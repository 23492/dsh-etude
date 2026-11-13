// Leerladder: shared prepare logic for every sfl-* type. Runs in Etude's QuickJS sandbox as the body of
// function (fields, face, rng, learner). The builder appends `return build(KIND);` with the type's kind.
//
// Two axes (see research/00-ontwerp.md):
// 1. Form = face. Each rung of the ladder (herken, produceer, onthoud, examen) is its own card with its
//    own FSRS memory, so a harder form never corrupts the stability of an easier one.
// 2. Support = only while learning. Hints exist on the first showing, in learning/relearning, and while
//    the item has no card in review yet (the gate). In review the question is always the same: goal
//    "measure" means comparable evidence for FSRS.

const L = learner || null;
// The teach step belongs to the item's first rung (rungsOf(kind)[0]); later rungs are new cards too,
// and their first showing comes with hints instead (support), since the rung before taught them.
const LADDER = {
  begrip: ["herken", "produceer"],
  cloze: ["herken", "produceer"],
  typed: ["herken", "produceer"],
  uitleg: ["herken", "onthoud"],
  koppel: ["produceer"],
  orden: ["produceer"],
  examen: ["examen"],
  oefen: ["oefen"],
};
const hasBlank = (s) => /\{\{[\s\S]+?\}\}/.test(String(s ?? ""));
const rungsOf = (kind) => {
  const out = LADDER[kind].filter((r) => (r !== "herken" || !!fields.rec) && (r !== "produceer" || kind !== "begrip" || hasBlank(fields.text)));
  return out.length ? out : [LADDER[kind][LADDER[kind].length - 1]];
};

const state = L ? L.card.state : null;
const gate = Array.isArray(fields.ladder) ? fields.ladder : [];
// _known is only there when Etude annotated the variants (adaptive deck): 1 once any card of this item is in review.
const known = gate.length && typeof gate[0]._known === "number" ? gate[0]._known : null;
const teaching = !!L && L.goal === "teach";
const support = !!L && (teaching || state === "learning" || state === "relearning" || known === 0);

const strip = (s) => { const t = String(s ?? "").replace(/^\s*(in)?correct[:.,]?\s*/i, "").trim(); return t ? t[0].toUpperCase() + t.slice(1) : t; };
const firstHint = (a) => {
  const w = String(a).trim();
  return w.length <= 2 ? "" : `${w[0]}${"\u2026"}`;
};
const blanksOf = (text, withHints) => {
  const blanks = [];
  const shown = String(text).replace(/\{\{([\s\S]+?)\}\}/g, (_, inner) => {
    const [ans, hint] = inner.split("::");
    const answers = ans.split("|").map((s) => s.trim()).filter(Boolean);
    const i = blanks.length;
    blanks.push({ answers, hint: (hint ?? "").trim() || (withHints ? firstHint(answers[0]) : "") });
    return `\u27e6${i}\u27e7`;
  });
  return { shown, blanks };
};
const filled = (text) => String(text).replace(/\{\{([\s\S]+?)\}\}/g, (_, inner) => `**${inner.split("::")[0].split("|")[0].trim()}**`);

// ---------- teach (first showing of the first rung) ----------
function teachBody(kind) {
  const f = fields;
  if (kind === "begrip") return [`**${f.front}**`, f.back, f.extra].filter(Boolean).join("\n\n");
  if (kind === "cloze") return [filled(f.text), f.explanation].filter(Boolean).join("\n\n");
  if (kind === "typed") return [`**${f.prompt}**`, f.answers[0], f.explanation].filter(Boolean).join("\n\n");
  if (kind === "uitleg") return [`**${f.prompt}**`, f.reference, f.explanation].filter(Boolean).join("\n\n");
  if (kind === "koppel") return [f.prompt, f.pairs.map(([l, r]) => `- **${l}**: ${r}`).join("\n"), f.explanation].filter(Boolean).join("\n\n");
  if (kind === "orden") return [f.prompt, f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), f.explanation].filter(Boolean).join("\n\n");
  if (kind === "examen") {
    const right = f.options.filter((o) => o.correct), wrong = f.options.filter((o) => !o.correct);
    const bare = (t) => String(t).trim().replace(/[.:;]+$/, "");
    // Each option as a line; card.js marks the right one green and the wrong ones muted (no glyphs: not every font has them).
    const line = (o) => `**${bare(o.text)}**${strip(o.why) ? `  \n${strip(o.why)}` : ""}`;
    return { md: [f.prompt, f.explanation].filter(Boolean), options: [...right.map((o) => ({ ok: true, md: line(o) })), ...wrong.map((o) => ({ ok: false, md: line(o) }))] };
  }
  return "";
}

// ---------- the rungs ----------
function mc(prompt, options, opts) {
  const list = options.map((o, i) => ({ ...o, id: "o" + i }));
  const shown = opts.shuffle === false ? list : rng.shuffle(list);
  const correct = list.filter((o) => o.correct).map((o) => o.id);
  return {
    view: {
      mode: "mc",
      prompt,
      multiple: opts.multiple ?? correct.length > 1,
      options: shown.map((o) => ({ id: o.id, text: o.text })),
      commit: !!opts.commit,
      confidence: !!opts.confidence,
      gok: !!opts.gok,
    },
    key: { mode: "mc", correct, why: Object.fromEntries(list.filter((o) => o.why).map((o) => [o.id, strip(o.why)])), explanation: opts.explanation ?? "" },
  };
}

// A blank whose answer already stands in the question or elsewhere in the sentence gives itself away.
// Fill those in, as long as at least one real blank stays.
function dropGiveaways(prompt, text) {
  const re = /\{\{([\s\S]+?)\}\}/g;
  const blanks = [...String(text).matchAll(re)].map((m) => ({ raw: m[0], ans: m[1].split("::")[0].split("|")[0].trim() }));
  if (blanks.length < 2) return text;
  const plain = (s) => String(s).replace(re, (_, inner) => inner.split("::")[0].split("|")[0]);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = String(text), left = blanks.length;
  for (const b of blanks) {
    if (left <= 1 || b.ans.length < 4) continue;
    const others = plain(out.replace(b.raw, " ")) + " " + String(prompt ?? "");
    if (new RegExp(`\\b${esc(b.ans)}\\b`, "i").test(others)) { out = out.replace(b.raw, b.ans); left--; }
  }
  return out;
}

// Produce without typing: drag blocks from a word bank into the gaps. While learning the bank holds only the
// right blocks; once the card is in review, tricky wrong blocks (fields.decoys, hardest first) join it, more as
// the memory matures. Grading is unchanged: the answer is the block text placed in each gap.
const decoyCount = () => {
  const pool = Array.isArray(fields.decoys) ? fields.decoys.length : 0;
  if (!pool) return 0;
  if (!L) return Math.min(3, pool);
  if (teaching || known === 0 || state === "new" || state === "learning" || state === "relearning") return 0;
  const s = Number(L.card.stability) || 0;
  return Math.min(pool, s < 7 ? 2 : s < 30 ? 4 : pool);
};
function bank(prompt, text, explanation, reveal) {
  const { shown, blanks } = blanksOf(text, false);
  const n = decoyCount();
  const right = blanks.map((b) => String(b.answers[0]));
  const low = (x) => String(x).trim().toLowerCase();
  const taken = new Set(blanks.flatMap((b) => b.answers.map(low)));
  const wrong = (Array.isArray(fields.decoys) ? fields.decoys : []).map(String).filter((d) => !taken.has(low(d))).slice(0, n);
  const chips = rng.shuffle([...right, ...wrong]).map((t, i) => ({ id: "b" + i, text: t }));
  return {
    view: { mode: "bank", prompt: prompt ?? "", text: shown, blanks: blanks.map((b, i) => ({ id: i })), bank: chips, level: n },
    key: { mode: "cloze", answers: blanks.map((b) => b.answers), explanation: explanation ?? "", reveal: reveal ?? "" },
  };
}
// Every gap stays a gap: with a word bank the learner places all the right blocks (dropGiveaways was for typing).
function cloze(prompt, text, explanation, reveal) {
  return bank(prompt, text, explanation, reveal);
}

function typed(prompt, answers, explanation) {
  const a = String(answers[0] ?? "");
  const hint = support && a.length > 2 ? `${a[0]}${"\u2026"}` : "";
  return { view: { mode: "typed", prompt, placeholder: hint }, key: { mode: "typed", answers, explanation: explanation ?? "" } };
}

function match(prompt, pairs, explanation) {
  const ps = pairs.map(([l, r], i) => ({ l: { id: "l" + i, text: l }, r: { id: "r" + i, text: r } }));
  // Support: one pair already connected.
  const given = support && ps.length > 2 ? { [ps[0].l.id]: ps[0].r.id } : {};
  return {
    view: { mode: "match", prompt, left: rng.shuffle(ps.map((p) => p.l)), right: rng.shuffle(ps.map((p) => p.r)), given },
    key: {
      mode: "match",
      pairs: Object.fromEntries(ps.map((p) => [p.l.id, p.r.id])),
      text: Object.fromEntries(ps.flatMap((p) => [[p.l.id, p.l.text], [p.r.id, p.r.text]])),
      explanation: explanation ?? "",
    },
  };
}

function order(prompt, steps, explanation) {
  const list = steps.map((text, i) => ({ id: "s" + i, text }));
  let shown = rng.shuffle(list);
  for (let t = 0; t < 5 && shown.every((s, i) => s.id === list[i].id); t++) shown = rng.shuffle(list);
  // Support: the first step already in place.
  if (support && list.length > 3) shown = [list[0], ...shown.filter((s) => s.id !== list[0].id)];
  return {
    view: { mode: "order", prompt, blocks: shown, fixed: support && list.length > 3 ? list[0].id : "" },
    key: { mode: "order", order: list.map((s) => s.id), steps: list.map((s) => s.text), explanation: explanation ?? "" },
  };
}

function recall(prompt, reveal, extra) {
  // Free recall, self-rated: write or say it, then compare.
  return { view: { mode: "reveal", prompt }, key: { mode: "reveal", reveal: [reveal, extra].filter(Boolean).join("\n\n") }, grader: "self" };
}

function free(prompt, reference, rubric, explanation) {
  return { view: { mode: "free", prompt }, key: { mode: "free", reveal: reference, rubric: rubric ?? "", explanation: explanation ?? "" } };
}

// ---------- per kind ----------
function rungFor(kind) {
  const f = fields;
  const rec = f.rec && typeof f.rec === "object" ? f.rec : null;
  if (face === "herken") return mc(rec.prompt, rec.options, { explanation: rec.explanation, shuffle: true });
  if (kind === "begrip") {
    // produceer: a cloze of the back; without one (no ladder content) the old self-rated card.
    if (hasBlank(f.text)) return cloze(f.front, f.text, "", [f.back, f.extra].filter(Boolean).join("\n\n"));
    return recall(f.front, f.back, f.extra);
  }
  if (kind === "cloze") return cloze("", f.text, f.explanation, "");
  // A term is produced from the bank as well: one gap under the question.
  if (kind === "typed") return bank(f.prompt, `{{${f.answers.map((a) => String(a).replace(/[|}]/g, " ")).join("|")}}}`, f.explanation, "");
  if (kind === "uitleg") return free(f.prompt, f.reference, f.rubric, f.explanation);
  if (kind === "koppel") return match(f.prompt, f.pairs, f.explanation);
  if (kind === "orden") return order(f.prompt, f.steps, f.explanation);
  // Exam questions (mock and practice): plain multiple choice, no hints. Practice offers "Gok" (a guess).
  if (kind === "examen") return mc(f.prompt, f.options, { explanation: f.explanation, multiple: f.multiple, shuffle: f.shuffle });
  if (kind === "oefen") return mc(f.prompt, f.options, { explanation: f.explanation, multiple: f.multiple, shuffle: f.shuffle, gok: true });
  throw new Error(`no rung ${face} for ${kind}`);
}

function build(kind) {
  // Exam questions are never taught: no teach step (research/09-synthese.md).
  if (teaching && kind !== "examen" && kind !== "oefen" && face === rungsOf(kind)[0]) {
    // Script-graded with score 1 (grade.js), so Etude's big button counts as Good; card.js rates it at once.
    return {
      view: (() => { const b = teachBody(kind); return typeof b === "string" ? { teach: b, lesson: fields.lesson ?? "", topic: fields.topic ?? "" } : { teach: b.md[0], teachOptions: b.options, teachAfter: b.md[1] ?? "", lesson: fields.lesson ?? "", topic: fields.topic ?? "" }; })(),
      key: { mode: "teach" },
      variant: `${face}:uitleg`,
    };
  }
  const out = rungFor(kind);
  out.view.support = support && face !== "herken" && face !== "examen" && face !== "oefen";
  const variant = face === "examen" || face === "oefen" ? "opties" : face === "herken" ? "keuze" : out.view.mode === "bank" ? `bank${out.view.level}` : support ? "steun" : "vrij";
  // Variant keys are per face: Etude keys learned difficulty by item#variant, and faces are different questions.
  return {
    ...out,
    variant: `${face}:${variant}`,
  };
}
