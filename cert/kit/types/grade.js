// Leerladder grader, body of function (answer, view, key, fields). One grader for every mode.
const mode = key.mode;
// Teach step: nothing to answer. Score 1 so Etude suggests Good; "known" marks "Wist ik al" (card.js rates it Easy).
if (mode === "teach") return { score: 1, details: { known: !!(answer && answer.known) } };
if (mode === "mc") {
  const a = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : { picked: answer };
  const chosen = new Set(Array.isArray(a.picked) ? a.picked : a.picked == null ? [] : [a.picked]);
  const right = new Set(key.correct);
  let tp = 0, fp = 0;
  for (const id of chosen) right.has(id) ? tp++ : fp++;
  const exact = tp === right.size && fp === 0;
  let score = exact ? 1 : view.multiple ? Math.max(0, (tp - fp) / right.size) : 0;
  const sure = a.confidence ?? null; // 1 gok, 2 denk het, 3 zeker
  // A lucky guess is weak evidence (only when the confidence step is switched on): cap it so Etude suggests Hard.
  if (exact && sure === 1) score = 0.6;
  // "Gok" on a practice question: the score stays honest, the scheduler (sfa-oefen) treats a lucky guess as a miss.
  return { score, details: { chosen: [...chosen], confidence: sure, guess: a.guess ?? "", gok: !!a.gok } };
}
if (mode === "cloze") {
  const given = Array.isArray(answer) ? answer : [];
  const fits = (v, i) => String(v ?? "").trim() !== "" && key.answers[i].some((x) => x && std.looseEqual(v, x));
  const marks = key.answers.map((_, i) => fits(given[i], i));
  // fix[i]: the answer to show for gap i. In a swap group a block may sit in any of the group's gaps: take the
  // assignment of the group's answers to its gaps that gets the most gaps right.
  const fix = key.answers.map((alts) => alts[0]);
  for (const grp of key.groups ?? []) {
    let best = null;
    const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, k) => perms([...a.slice(0, k), ...a.slice(k + 1)]).map((p) => [x, ...p])));
    for (const p of perms(grp)) {
      // p[j] = whose answers gap grp[j] takes
      const ok = grp.map((gi, j) => fits(given[gi], p[j]));
      const n = ok.filter(Boolean).length;
      if (!best || n > best.n) best = { n, p, ok };
    }
    grp.forEach((gi, j) => { marks[gi] = best.ok[j]; fix[gi] = key.answers[best.p[j]][0]; });
  }
  return { score: marks.filter(Boolean).length / marks.length, details: { marks, fix } };
}
if (mode === "typed") {
  const ok = key.answers.some((x) => std.looseEqual(String(answer ?? ""), x));
  return { score: ok ? 1 : 0 };
}
if (mode === "match") {
  const given = answer && typeof answer === "object" ? answer : {};
  const marks = {};
  let right = 0;
  for (const [l, r] of Object.entries(key.pairs)) {
    marks[l] = given[l] === r;
    if (marks[l]) right++;
  }
  return { score: right / Object.keys(key.pairs).length, details: { marks } };
}
if (mode === "order") {
  const given = Array.isArray(answer) ? answer : [];
  const pos = Object.fromEntries(key.order.map((id, i) => [id, i]));
  const seq = given.map((id) => pos[id]).filter((p) => p !== undefined);
  const exact = seq.length === key.order.length && seq.every((p, i) => p === i);
  return { score: exact ? 1 : Math.min(0.9, std.lis(seq) / key.order.length) };
}
// free: hand over to the AI grader (hybrid type). Anything else is self-rated.
return { defer: true };
