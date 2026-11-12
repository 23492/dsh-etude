// Runs every ladder type's prepare and grade over every item of a pack, every face and every learner state,
// the way Etude calls them (prepare: function (fields, face, rng, learner); grade: function (answer, view, key, fields)).
// Plain Node, not Etude's QuickJS sandbox, so it catches logic errors, not sandbox limits; render a few cards in the
// app as well. Usage: node verify_types.mjs <pack.json>
import { readFileSync } from "node:fs";

const pack = JSON.parse(readFileSync(process.argv[2], "utf8"));
const types = Object.fromEntries(pack.types.map((t) => [t.id, t]));
const rng = { next: Math.random, int: (a, b) => a + Math.floor(Math.random() * (b - a + 1)), shuffle: (a) => [...a].sort(() => Math.random() - 0.5), pick: (a) => a[0] };
const std = { looseEqual: (a, b) => String(a).trim().toLowerCase().replace(/\s+/g, " ") === String(b).trim().toLowerCase().replace(/\s+/g, " "), lis: (s) => { const t = []; for (const x of s) { let i = t.findIndex((y) => y >= x); i < 0 ? t.push(x) : (t[i] = x); } return t.length; } };
const learners = {
  none: null,
  teach: { goal: "teach", card: { state: "new" } },
  learning: { goal: "measure", card: { state: "learning" } },
  review: { goal: "measure", card: { state: "review" } },
  relearning: { goal: "measure", card: { state: "relearning" } },
};
const fails = [];
let runs = 0;
const bad = (it, face, ls, msg) => { if (fails.length < 40) fails.push(`${it.id} ${face} ${ls}: ${msg}`); else fails.length++; };
const fns = {};
for (const it of pack.items) {
  if (it.archived) continue;
  const t = types[it.type];
  if (!t) continue; // built-in type
  fns[t.id] ??= { prepare: new Function("fields", "face", "rng", "learner", t.prepare), grade: new Function("answer", "view", "key", "fields", "std", t.grader.code), faces: t.facesWhen ? new Function("fields", t.facesWhen) : () => t.faces };
  const F = fns[t.id];
  const faces = F.faces(it.fields);
  for (const face of faces) for (const known of [0, 1]) for (const [ls, L] of Object.entries(learners)) {
    const fields = { ...it.fields, ladder: (it.fields.ladder ?? []).map((v) => ({ ...v, _known: known })) };
    let out;
    try { out = F.prepare(fields, face, rng, L); runs++; } catch (e) { bad(it, face, ls, "prepare threw " + e.message); continue; }
    const v = JSON.stringify(out.view);
    if (v.includes("undefined")) bad(it, face, ls, "undefined in view");
    if (out.key?.mode === "mc" && /"correct"|"why"/.test(v)) bad(it, face, ls, "MC view leaks correct/why");
    const k = out.key ?? {};
    const g = (a) => F.grade(a, out.view, k, fields, std);
    try {
      if (k.mode === "teach") { if (g({}).score !== 1) bad(it, face, ls, "teach not score 1"); continue; }
      if (k.mode === "mc") {
        const right = k.correct; const wrong = out.view.options.map((o) => o.id).filter((id) => !right.includes(id));
        if (g({ picked: out.view.multiple ? right : right[0] }).score !== 1) bad(it, face, ls, "right MC not 1");
        if (wrong.length && g({ picked: out.view.multiple ? [wrong[0]] : wrong[0] }).score >= 0.95) bad(it, face, ls, "wrong MC >= 0.95");
      } else if (k.mode === "cloze") {
        if (g(k.answers.map((a) => a[0])).score !== 1) bad(it, face, ls, "right cloze not 1");
        if (g(k.answers.map(() => "zzz")).score >= 0.95) bad(it, face, ls, "wrong cloze >= 0.95");
      } else if (k.mode === "typed") {
        if (g(k.answers[0]).score !== 1) bad(it, face, ls, "right typed not 1");
      } else if (k.mode === "match") {
        if (g(k.pairs).score !== 1) bad(it, face, ls, "right match not 1");
      } else if (k.mode === "order") {
        if (g(k.order).score !== 1) bad(it, face, ls, "right order not 1");
        if (k.order.length > 1 && g([...k.order].reverse()).score >= 0.95) bad(it, face, ls, "reversed order >= 0.95");
      }
    } catch (e) { bad(it, face, ls, "grade threw " + e.message); }
  }
}
console.log(JSON.stringify({ items: pack.items.filter((i) => !i.archived && types[i.type]).length, prepareRuns: runs, failures: fails.length }));
for (const f of fails.slice(0, 40)) console.log(" ", f);
process.exit(fails.length ? 1 : 0);
