// A sealed mock exam question is answered once (cert references/design.md): the first answer is the measurement.
const pass = attempt.score != null && attempt.score >= 0.95;
return { due: ctx.day[ctx.day.length - 1], state: { tries: (card.state?.tries ?? 0) + 1, last: attempt.score == null ? "ongemeten" : pass ? "goed" : "fout" } };
