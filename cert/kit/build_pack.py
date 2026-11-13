#!/usr/bin/env python3
"""Builds one Etude pack for a certification deck from a project folder (see ../SKILL.md, step 8).

Usage: python3 build_pack.py <project-dir> [--allow-gaps]

<project-dir> holds cert.json and the stage outputs:
  parts/DD/NN-slug.json   topics with items (references/concepts.md)
  lessons/DD.json         topic lessons (references/lessons.md)
  ladder/out/DD.json      recognize MCQ + production cloze per concept (references/ladder.md)
  balance/out/DD.json     option texts without the length cue (references/balance.md), optional
  repair/out/DD.json      gap cards, teaches links, fixed/retired questions (references/repair.md)
  repair/holdout.json     {"proef1": [qid...], "proef2": [...]}: the sealed mock exams
and cert.json "paths.questions" points at the question bank ({questions:[{id, domain, domain_name, type, source, source_id, status, ...}]}).

Item ids are <ids.items>.dDD.<slug>.<key> (concepts), <ids.items>.oefen.<qid> (practice), <ids.items>.proef.<qid> (mock).
They must stay stable once studied: never renumber keys or rename slugs of a deck in use.
Writes the pack (cert.json paths.pack) and teaches.json next to it.
"""
import json, glob, os, re, sys, collections, random

KIT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(KIT, "types"))
from build import build_types, ladder_item

if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
    raise SystemExit(__doc__)
ROOT = os.path.abspath(sys.argv[1])
C = json.load(open(os.path.join(ROOT, "cert.json")))
IDS = C.get("ids", {})
P_ITEM, P_TYPE, P_SCHED = IDS.get("items", "cert"), IDS.get("types", "cl"), IDS.get("schedulers", IDS.get("items", "cert"))
P_TAG, PRESET = IDS.get("tags", P_ITEM), IDS.get("preset", P_ITEM + "-exam")
TOP = C["name"]
EX = C["exam"]
TXT = C.get("text", {})
fmt = lambda s, **kw: re.sub(r"\{(\w+)\}", lambda m: str(kw.get(m.group(1), m.group(0))), s)

src = json.load(open(os.path.normpath(os.path.join(ROOT, C["paths"]["questions"]))))
Q = {q["id"]: q for q in src["questions"]}
DOMAINS = {d["id"]: d for d in C["domains"]}
PLAN = [d["id"] for d in C["domains"]]  # cert.json order = the order new cards arrive in
for q in src["questions"]:
    DOMAINS.setdefault(q["domain"], {"id": q["domain"], "name": q["domain_name"], "weight": 0})

def source_label(ids):
    out = []
    for i in ids:
        q = Q[i]
        s = q["source"]
        if s.startswith("vragenbank:") or s.startswith("bank:"):
            out.append(f"exam bank {s.split(':', 1)[1]} ({q.get('source_id', i)})")
        elif s in ("trailhead", "official"):
            out.append(f"{'Trailhead' if s == 'trailhead' else 'Official'} ({q.get('source_id', i)})")
        else:
            out.append(f"own ({q.get('source_id', i)})")
    return "; ".join(dict.fromkeys(out))

def official(s):
    return s.startswith("vragenbank:") or s.startswith("bank:") or s in ("trailhead", "official")

def normalize(it):
    """Etude needs 3+ match pairs and a markdown rubric. Fix shape, not content."""
    f = it["fields"]
    if it["type"] == "match" and len(f.get("pairs", [])) == 2:
        it["type"] = "basic"
        back = "\n".join(f"- **{l}**: {r}" for l, r in f["pairs"])
        it["fields"] = {"front": f["prompt"], "back": back}
        if f.get("explanation"): it["fields"]["extra"] = f["explanation"]
    if it["type"] == "free" and isinstance(f.get("rubric"), list):
        f["rubric"] = "A correct answer:\n" + "\n".join(f"- {r}" for r in f["rubric"])
    return it

def check_item(it, where):
    t, f = it["type"], it["fields"]
    errs = []
    if t == "mcq":
        if not any(o.get("correct") for o in f.get("options", [])): errs.append("no correct option")
    elif t == "match":
        if len(f.get("pairs", [])) < 2: errs.append("match < 2 pairs")
    elif t == "order":
        if len(f.get("steps", [])) < 3: errs.append("order < 3 steps")
    elif t == "cloze":
        if "{{" not in f.get("text", ""): errs.append("cloze without blank")
    elif t == "typed":
        if not f.get("answers"): errs.append("typed without answers")
    elif t == "basic":
        if not f.get("front") or not f.get("back"): errs.append("basic missing side")
    elif t == "free":
        if not f.get("reference"): errs.append("free without reference")
    else:
        errs.append(f"unknown type {t}")
    for k, v in f.items():
        if isinstance(v, str) and "\u2014" in v: f[k] = v.replace(" \u2014 ", ", ").replace("\u2014", ", ")
    return [f"{where}: {e}" for e in errs]

def load_dir(*parts):
    out = {}
    for fp in sorted(glob.glob(os.path.join(ROOT, *parts, "*.json"))):
        out.update(json.load(open(fp)))
    return out

# Option texts rebalanced so the correct one is not given away by its length (balance/out/DD.json).
BAL = load_dir("balance", "out")
def balanced(ref, options):
    b = BAL.get(ref)
    if not b: return options
    new = b["options"]
    assert len(new) == len(options) and [bool(x.get("correct")) for x in new] == [bool(x.get("correct")) for x in options], ref
    return [{**o, "text": n["text"], "why": n["why"]} for o, n in zip(options, new)]

# Repair of the exam bank: new concept cards, teaches links, fixed or retired questions.
REPAIR_NEW, REPAIR_EX = {}, {}
for fp in sorted(glob.glob(os.path.join(ROOT, "repair", "out", "*.json"))):
    r = json.load(open(fp))
    for c in r.get("new_concepts", []):
        REPAIR_NEW.setdefault(c["topic_file"], []).append(c)
    REPAIR_EX.update(r.get("exams", {}))
hold_fp = os.path.join(ROOT, "repair", "holdout.json")
HOLD = json.load(open(hold_fp)) if os.path.exists(hold_fp) else {}
MOCKS = C.get("mocks", {"count": 2})
MOCK = {}
for n in range(1, MOCKS.get("count", 2) + 1):
    for i in HOLD.get(f"proef{n}", []): MOCK[i] = n
mock_deck = lambda n: f"{TOP}::" + fmt(TXT.get("mockDeck", "Proefexamen {n}"), n=n)

slugify = lambda s: re.sub(r"[^a-z0-9-]", "", s.lower())
REPAIR_LADDER = {}
items, decks, errors, covered = [], [], [], set()
ref_to_id, teaches_refs, exam_new = {}, {}, []
stats = collections.Counter()
top = {"name": TOP, "preset": PRESET, "description": TXT.get("deckDescription", EX.get("title", TOP))}
if TXT.get("deckInstructions"): top["instructions"] = TXT["deckInstructions"]
decks.append(top)
LESSONS = {}
for dd in PLAN:
    files = sorted(glob.glob(os.path.join(ROOT, "parts", dd, "*.json")))
    if not files:
        errors.append(f"domain {dd}: no parts")
        continue
    D = DOMAINS[dd]
    dname = f"{TOP}::{int(dd) if dd.isdigit() else dd} {D['name']}"
    expected = round(D.get("weight", 0) * EX.get("questions", 60) / 100)
    ddesc = fmt(TXT.get("domainDescription", "{weight}% of the exam, about {expected} of {questions} questions."), weight=D.get("weight", 0), expected=expected, questions=EX.get("questions", 60), video=D.get("video", ""))
    decks.append({"name": dname, "description": ddesc})
    lp = os.path.join(ROOT, "lessons", f"{dd}.json")
    lessons = json.load(open(lp)) if os.path.exists(lp) else {}
    for fp in files:
        part = json.load(open(fp))
        num = os.path.basename(fp).split("-")[0]
        slug = slugify(part["slug"])
        tdeck = f"{dname}::{num} {part['topic']}"
        decks.append({"name": tdeck, "description": part.get("intro", "")})
        lesson = lessons.get(os.path.basename(fp)[:-5])
        if not lesson: errors.append(f"{fp}: no lesson")
        keys = set()
        lesson_done = False
        tf = f"{dd}/{os.path.basename(fp)}"
        extra_items = []
        for c in REPAIR_NEW.get(tf, []):
            extra_items.append({"key": c["key"], "type": c["type"], "fields": c["fields"], "covers": [x for x in c.get("for", []) if x in Q], "extra": False, "disputed": False, "check": "", "new": True})
            REPAIR_LADDER[f"{P_ITEM}.d{dd}.{slug}.{c['key']}"] = c.get("ladder") or {}
        for it in part["items"] + extra_items:
            it = normalize(it)
            key = it["key"]
            if key in keys: errors.append(f"{fp}: duplicate key {key}")
            keys.add(key)
            bad = [c for c in it["covers"] if c not in Q]
            if bad: errors.append(f"{fp} {key}: unknown ids {bad}")
            cov = [c for c in it["covers"] if c in Q]
            covered.update(cov)
            errors += check_item(it, f"{fp} {key}")
            srcs = {Q[c]["source"] for c in cov}
            tags = [f"{P_TAG}::d{dd}", f"{P_TAG}::d{dd}::{slug}"]
            if any(official(s) for s in srcs): tags.append(f"{P_TAG}::examenvraag")
            if it.get("extra"): tags.append(f"{P_TAG}::extra")
            if it.get("disputed") or any(Q[c].get("status", "ok") != "ok" for c in cov): tags.append(f"{P_TAG}::betwist")
            if it.get("check"): tags.append(f"{P_TAG}::controleren")
            notes = "Covers: " + ", ".join(cov)
            if it.get("check"): notes += "\nCheck: " + it["check"]
            fields = dict(it["fields"])
            iid = f"{P_ITEM}.d{dd}.{slug}.{key}"
            ref_to_id[f"{tf}|{key}"] = iid
            role, archived = None, False
            if it["type"] == "mcq":
                fields["options"] = balanced(f"examen|{tf}|{key}", fields["options"])
                rep = REPAIR_EX.get(f"{tf}|{key}")
                if rep is None:
                    errors.append(f"{tf}|{key}: no repair decision")
                    rep = {"action": "keep", "teaches": []}
                if rep["action"] == "fix" and rep.get("fields"):
                    fields = {**fields, **rep["fields"]}
                if rep["action"] == "retire":
                    archived = True
                qid = it["covers"][0]
                role = "proef" if qid in MOCK else "oefen"
                if role == "proef" and archived:
                    errors.append(f"{tf}|{key}: mock question {qid} retired")
                teaches_refs[iid] = rep.get("teaches") or []
                if not archived and not teaches_refs[iid]:
                    errors.append(f"{tf}|{key}: no teaching card")
            if lesson and not lesson_done and it["type"] != "mcq" and not it.get("new"):
                lesson_done = True
                fields["lesson"] = lesson
                fields["topic"] = part["topic"]
                tags.append(f"{P_TAG}::les")
            deck_for, typ = tdeck, f"{P_ITEM}-" + it["type"]
            if role == "oefen":
                # Practice questions live with their topic, so the deck tree and Custom study by topic show them.
                typ = f"{P_ITEM}-oefen"
                tags.append(f"{P_TAG}::oefen")
            elif role == "proef":
                n = MOCK[it["covers"][0]]
                deck_for = mock_deck(n)
                tags.append(f"{P_TAG}::proef{n}")
            if it.get("new"): tags.append(f"{P_TAG}::aanvulling")
            if archived: tags.append(f"{P_TAG}::uitgefaseerd")
            src_label = source_label(cov) if cov else "aanvulling (repair)"
            if it["type"] == "mcq":
                if C.get("legacyExamItems"):
                    # Decks built before practice/mock existed kept the question as a topic-test item; keep it archived
                    # so its id stays known (never reuse an id).
                    items.append({"id": iid, "type": f"{P_ITEM}-mcq", "deck": tdeck.replace(f"{TOP}::", f"{TOP}::Toetsen::", 1), "tags": tags + [f"{P_TAG}::vervangen"],
                                  "fields": dict(it["fields"]), "source": src_label, "notes": notes, "archived": True})
                qid = it["covers"][0]
                nid = f"{P_ITEM}.{role}.{qid}"
                note = REPAIR_EX.get(f"{tf}|{key}", {}).get("note")
                exam_new.append({"id": nid, "type": typ, "deck": deck_for, "tags": tags, "fields": fields, "source": src_label,
                                 "notes": notes + (f"\nRepair: {note}" if note else ""), **({"archived": True} if archived else {})})
                teaches_refs[nid] = teaches_refs.pop(iid)
            else:
                items.append({"id": iid, "type": typ, "deck": deck_for, "tags": tags, "fields": fields, "source": src_label, "notes": notes})
            stats[(dd, it["type"])] += 1

# Practice and mock questions after every concept card, shuffled across topics (interleaving).
random.Random(MOCKS.get("seed", 201)).shuffle(exam_new)
items += exam_new
missing = sorted(set(Q) - covered)
if missing: errors.append(f"{len(missing)} source questions not covered: {missing[:40]}")
dup = [i for i, n in collections.Counter(i["id"] for i in items).items() if n > 1]
if dup: errors.append(f"duplicate item ids: {dup}")

# Ladder content (recognize MCQ + production cloze) per concept item.
LADDER = load_dir("ladder", "out")
LADDER.update({k: v for k, v in REPAIR_LADDER.items() if v})
for iid, c in LADDER.items():
    if c.get("recognize"): c["recognize"] = {**c["recognize"], "options": balanced(f"herken|{iid}", c["recognize"]["options"])}
# Decoys for the word-bank rung (decoys/out/DD.json, references/decoys.md).
DECOYS = load_dir("decoys", "out")
for iid, d in DECOYS.items():
    if d.get("decoys"): LADDER[iid] = {**LADDER.get(iid, {}), "decoys": d["decoys"]}
# Gaps whose right blocks may trade places (gaps/out/DD.json: {"swap": [[0, 1]]}).
for iid, g in load_dir("gaps", "out").items():
    if g.get("swap"): LADDER[iid] = {**LADDER.get(iid, {}), "swap": g["swap"]}
items = [ladder_item(it, LADDER.get(it["id"]), P_TYPE) for it in items]
missing_ladder = [it["id"] for it in items if it["type"] in (f"{P_TYPE}-begrip", f"{P_TYPE}-cloze", f"{P_TYPE}-typed", f"{P_TYPE}-uitleg") and "rec" not in it["fields"]]
for it in items:
    if it["type"] == f"{P_TYPE}-examen" and not it.get("archived") and not any(it["deck"] == mock_deck(n) for n in range(1, MOCKS.get("count", 2) + 1)):
        raise SystemExit(f"stray exam item {it['id']}")
teaches = {}
for iid, refs in teaches_refs.items():
    ids = []
    for r in refs:
        t = ref_to_id.get(r)
        if not t: errors.append(f"{iid}: teaches unknown {r}")
        elif t not in ids: ids.append(t)
    teaches[iid] = ids
pack_fp = os.path.join(ROOT, C["paths"].get("pack", "deck.pack.json"))
json.dump(teaches, open(os.path.join(os.path.dirname(pack_fp), "teaches.json"), "w"), indent=1)
for it in items:
    # The planner on the Sync server reads this field: only live practice questions carry it.
    if it["type"] == f"{P_TYPE}-oefen" and not it.get("archived"):
        it["fields"]["teaches"] = teaches.get(it["id"], [])
if missing_ladder: errors.append(f"{len(missing_ladder)} concept items without ladder content: {missing_ladder[:10]}")

for n in range(1, MOCKS.get("count", 2) + 1):
    when = (TXT.get("mockWhen") or [""] * n)
    decks.append({"name": mock_deck(n), "description": fmt(TXT.get("mockDescription", "Sealed mock exam {n}: {size} questions, {minutes} minutes."), n=n, size=MOCKS.get("size", EX.get("questions", 60)),
                  minutes=EX.get("minutes", ""), when=when[n - 1] if n - 1 < len(when) else "", **{"pass": round(EX.get("passMark", 0.68) * 100), "book": round(EX.get("bookAt", 0.75) * 100)})})

def scheduler(kind):
    d = json.load(open(os.path.join(KIT, "schedulers", kind, "scheduler.json")))
    d["id"] = f"{P_SCHED}-{kind}"
    # Names and stats labels in the learner's language (cert.json "schedulerText": {"oefen": {"name", "statsLabel"}}).
    tx = C.get("schedulerText", {}).get(kind, {})
    if tx.get("name"): d["name"] = tx["name"]
    if tx.get("statsLabel"): d["stats"] = {**d.get("stats", {}), "label": tx["statsLabel"]}
    if kind == "oefen":
        pr = C.get("practice", {})
        for o in d["options"]:
            if o["name"] in pr: o["default"] = pr[o["name"]]
    return {**d, "schedule": open(os.path.join(KIT, "schedulers", kind, "schedule.js")).read()}

pack = {
    "etude": "pack/1",
    "name": TOP,
    "description": TXT.get("packDescription", EX.get("title", TOP)),
    "presets": [{"id": PRESET, "name": C.get("preset", {}).get("name", TOP), "config": C.get("preset", {}).get("config", {})}],
    "decks": decks,
    "schedulers": [scheduler("toets"), scheduler("oefen")],
    "types": build_types(P_TYPE, P_SCHED, C.get("ui"), C.get("typeNames"), C.get("typeDescriptions"), C.get("typeInstructions")),
    "items": items,
}
json.dump(pack, open(pack_fp, "w"), ensure_ascii=False, indent=1)
tot = collections.Counter(t for (_, t), n in stats.items() for _ in range(n))
print(json.dumps({"pack": pack_fp, "items": len(items), "decks": len(decks), "per_type": tot, "covered": len(covered), "of": len(Q)}, default=dict))
for d in sorted({d for d, _ in stats}):
    print(d, {t: n for (dd, t), n in sorted(stats.items()) if dd == d})
if errors:
    print("ERRORS:"); [print(" ", e) for e in errors]
    if "--allow-gaps" not in sys.argv: sys.exit(1)
