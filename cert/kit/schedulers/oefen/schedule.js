// Practice, not drill (cert references/design.md). One clean try; a miss or a guess gets one more after
// a few days, then the question is done. "Done" is the last study day Etude can schedule (400 days).
const prev = card.state ?? {};
const guess = !!(attempt.details && attempt.details.gok);
const pass = attempt.score != null && attempt.score >= 0.95 && !guess;
const tries = (prev.tries ?? 0) + 1;
const last = attempt.score == null ? "ongemeten" : pass ? "goed" : guess && attempt.score >= 0.95 ? "gegokt" : "fout";
const state = { tries, last, first: prev.first ?? last };
const done = pass || tries >= options.maxTries;
return { due: done ? ctx.day[ctx.day.length - 1] : ctx.day[Math.min(options.againDays, ctx.day.length - 1)], state };
