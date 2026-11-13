"""Builds the ladder card types (<prefix>-begrip ... <prefix>-oefen) and turns items of built-in kinds into ladder items.

Kinds and their faces (ladder rungs), first face first. On a type change Etude moves an item's
existing card onto the first face of the new type, so the rung that matches the old card comes first.

  begrip  (was basic):  herken -> produceer   (a free-recall rung cost 152 cards; see references/design.md)
  produceer on begrip, cloze and typed is a word bank: drag blocks into the gaps, decoys join in review (references/decoys.md)
  cloze   (was cloze):  herken -> produceer
  typed   (was typed):  herken -> produceer
  uitleg  (was free):   herken -> onthoud
  koppel  (was match):  produceer
  orden   (was order):  produceer
  examen  (was mcq):    examen   sealed mock exam question, answered once (scheduler <schedulers>-toets)
  oefen:                oefen    exam-style practice question, released after its concept cards (scheduler <schedulers>-oefen)

Face order matters twice: on a type change Etude moves the item's existing card onto the first face,
and new cards come in by item order, then card id (= face order). So the easiest rung is always first.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
read = lambda n: open(os.path.join(HERE, n)).read()

KINDS = {
    # kind: (old built-in kind, faces in carry order, fields)
    "begrip": ("basic", ["herken", "produceer"], ["front", "back", "extra", "text", "rec", "decoys", "swap"]),
    "cloze": ("cloze", ["herken", "produceer"], ["text", "explanation", "rec", "decoys", "swap"]),
    "typed": ("typed", ["herken", "produceer"], ["prompt", "answers", "explanation", "rec", "decoys"]),
    "uitleg": ("free", ["herken", "onthoud"], ["prompt", "reference", "rubric", "explanation", "rec"]),
    "koppel": ("match", ["produceer"], ["prompt", "pairs", "explanation"]),
    "orden": ("order", ["produceer"], ["prompt", "steps", "explanation"]),
    "examen": ("mcq", ["examen"], ["prompt", "options", "multiple", "shuffle", "explanation"]),
    "oefen": ("oefen", ["oefen"], ["prompt", "options", "multiple", "shuffle", "explanation", "teaches"]),
}
FROM_OLD = {old: kind for kind, (old, _, _) in KINDS.items()}

FIELD = {
    "front": {"kind": "markdown", "required": True},
    "back": {"kind": "markdown", "required": True, "private": True},
    "extra": {"kind": "markdown", "private": True},
    "text": {"kind": "markdown", "private": True, "description": "Zin met {{blanks}} op de kernbegrippen."},
    "rec": {"kind": "json", "private": True, "label": "Herkennen", "description": "Meerkeuze voor de herken-face: {prompt, options:[{text, correct, why}], explanation}."},
    "explanation": {"kind": "markdown", "private": True},
    "swap": {"kind": "json", "private": True, "label": "Uitwisselbaar", "description": "Gaten waarvan de goede blokjes van plek mogen wisselen: [[0, 1]] (volgorde in de zin, vanaf 0)."},
    "decoys": {"kind": "list", "private": True, "label": "Lokkers", "description": "Foute blokjes voor de woordbank, moeilijkste eerst. Tijdens het leren alleen de goede blokjes; in review komen er lokkers bij, meer naarmate de kaart sterker wordt."},
    "prompt": {"kind": "markdown", "required": True},
    "answers": {"kind": "list", "required": True, "private": True},
    "reference": {"kind": "markdown", "required": True, "private": True},
    "rubric": {"kind": "markdown", "private": True},
    "pairs": {"kind": "json", "required": True, "private": True, "editor": "pairs"},
    "steps": {"kind": "list", "required": True, "private": True},
    "options": {"kind": "json", "required": True, "private": True, "editor": "choices"},
    "multiple": {"kind": "boolean"},
    "shuffle": {"kind": "boolean", "default": True},
    "teaches": {"kind": "json", "private": True, "label": "Begrippen", "description": "Intern: item-ids van de begripskaarten die deze vraag nodig heeft. De planner op de Sync-server geeft de vraag vrij als die geleerd zijn en haalt ze terug na een fout."},
}
COMMON = [
    {"name": "lesson", "kind": "markdown", "private": True, "label": "Les", "description": "Uitleg van het onderwerp, bij de eerste kaart ervan. Privé zodat het niet als titel boven een vraag verschijnt; prepare toont het in de uitlegstap."},
    {"name": "topic", "kind": "text", "label": "Onderwerp"},
    # The gate: one variant whose `requires` is this item, so Etude reports `_known` = 1 once any of its cards is in review.
    {"name": "ladder", "kind": "json", "label": "Ladder", "description": "Intern: [{id, requires:[item id]}]. Etude meldt _known zodra een kaart van dit item in review staat."},
]
NAMES = {"begrip": "Begrip", "cloze": "Gatentekst", "typed": "Term", "uitleg": "Uitleg", "koppel": "Koppelen", "orden": "Volgorde", "examen": "Proefexamenvraag", "oefen": "Oefenvraag"}
DESCR = {
    "begrip": "Een begrip in twee stappen: herkennen (meerkeuze), dan de zin afmaken door blokjes naar de gaten te slepen. Tijdens het leren alleen de goede blokjes, daarna lokkers erbij. Elke stap is een eigen kaart met eigen planning.",
    "cloze": "Gatentekst met een woordbank: sleep de blokjes naar de gaten. Tijdens het leren alleen de goede blokjes, in review komen er lastige lokkers bij. Met een herken-stap (meerkeuze) ervoor.",
    "typed": "Een term kiezen uit een woordbank met lastige lokkers, met een herken-stap (meerkeuze) ervoor. Niets typen.",
    "uitleg": "Uitleggen in eigen woorden (AI beoordeelt), met een herken-stap (meerkeuze) erbij.",
    "koppel": "Koppelen. Tijdens het leren staat er een paar al goed als hint.",
    "orden": "In volgorde zetten. Tijdens het leren staat de eerste stap al goed als hint.",
    "examen": "Vraag uit een verzegeld proefexamen: een keer beantwoorden, daarna nooit meer. De uitslag is de meting.",
    "oefen": "Examenvraag als oefening zonder hulp. Komt vrij een paar dagen nadat de begripskaarten erachter geleerd zijn. Goed: klaar. Fout of gegokt: de begripskaarten komen terug en de vraag nog een keer na een paar dagen.",
}
INSTR = "Judge whether the answer shows the understanding the reference and rubric describe. Wording, order and length do not matter; missing or wrong concepts do. A correct idea in different words is correct. Feedback in Dutch, short, naming the one thing to remember."


# Words the learner sees on the card (card.js). Dutch by default; a cert.json can override any of them in "ui".
UI = {
    "lesson": "Les", "known": "Wist ik al", "guess": "Ik gok", "options": "Opties", "pickAll": "Kies alle juiste.",
    "confGuess": "Gok", "confThink": "Denk het", "confSure": "Zeker", "rightOrder": "Goede volgorde", "alsoRight": "ook goed:",
}


def build_types(prefix="sfl", schedulers="sfa", ui=None, names=None, descr=None, instructions=None):
    """prefix: type ids; schedulers: scheduler id prefix (<schedulers>-toets, <schedulers>-oefen).
    ui / names / descr / instructions override the Dutch defaults (cert.json "ui", "typeNames", "typeDescriptions", "typeInstructions")."""
    shared = read("prepare.js")
    words = {**UI, **(ui or {})}
    card = read("card.js").replace("__UI__", json.dumps(words, ensure_ascii=False))
    nm, ds = {**NAMES, **(names or {})}, {**DESCR, **(descr or {})}
    out = []
    for kind, (_, faces, fields) in KINDS.items():
        title = "front" if kind == "begrip" else "text" if kind == "cloze" else "prompt"
        t = {
            "id": f"{prefix}-{kind}",
            "name": f"Ladder: {nm[kind]}",
            "description": ds[kind],
            "faces": faces,
            "fields": [{"name": n, **FIELD[n]} for n in fields] + COMMON,
            "titleField": title,
            "skills": {f: f for f in faces},
            "variants": {"field": "ladder"},
            "prepare": shared + f"\nreturn build({json.dumps(kind)});\n",
            "template": {"html": read("template.html"), "css": read("style.css"), "js": card},
            "grader": {"kind": "hybrid", "code": read("grade.js")},
            "instructions": instructions or INSTR,
        }
        if kind == "examen":
            # Sealed mock exam: answered once, never drilled (research/09-synthese.md).
            t["scheduler"] = f"{schedulers}-toets"
        if kind == "oefen":
            # Practice question: one clean try, one retry after a miss, never drilled (research/09-synthese.md).
            t["scheduler"] = f"{schedulers}-oefen"
        if len(faces) > 1:
            # A rung exists only when its content does: herken needs `rec`, produceer on a begrip needs a cloze `text`.
            t["facesWhen"] = (
                "const has = (s) => /\\{\\{[\\s\\S]+?\\}\\}/.test(String(s ?? ''));\n"
                f"const out = {json.dumps(faces)}.filter((f) => (f !== 'herken' || !!fields.rec) && (f !== 'produceer' || {json.dumps(kind)} !== 'begrip' || has(fields.text)));\nreturn out.length ? out : [{json.dumps(faces[-1])}];"
            )
        out.append(t)
    return out


def ladder_item(item, ladder_content, prefix="sfl"):
    """Converts one pack item of a built-in kind (<anything>-basic, -cloze, ...) to its ladder form. ladder_content: {recognize, text} or None."""
    old = item["type"].split("-", 1)[1]
    kind = FROM_OLD.get(old, old)
    f = dict(item["fields"])
    lc = ladder_content or {}
    if lc.get("recognize"):
        f["rec"] = lc["recognize"]
    if kind in ("begrip", "cloze") and lc.get("text"):
        f["text"] = lc["text"]
    if lc.get("decoys"):
        f["decoys"] = lc["decoys"]
    if lc.get("swap"):
        f["swap"] = lc["swap"]
    f["ladder"] = [{"id": "item", "requires": [item["id"]]}]
    return {**item, "type": f"{prefix}-{kind}", "fields": f}


if __name__ == "__main__":
    print(json.dumps([t["id"] for t in build_types()]))
