// Workload simulation of a certification deck with Etude's own FSRS (ts-fsrs, default FSRS-6 weights).
// Usage: node sim.cjs <pack.json> <teaches.json> [days] [newPerDay] [json newPerFace] [releaseDays]
// ts-fsrs is taken from the Etude runtime: set ETUDE_ROOT (the folder with node_modules/ts-fsrs), or it looks in
// /data/.dsh/dsh-etude/runtime/<newest>/ and ./node_modules.
// Concept cards: as sim.js (item order, newPerDay, newPerFace, siblings buried, teach step = Good).
// Practice questions (<types>-oefen): available RELEASE days after every teaching item was first studied,
// within newPerFace.oefen, in pack order; right (p = 0.7) is done, wrong comes back once after 4 days and
// brings its teaching cards in review back the same day. Mock exams are not simulated (2 x 60 by hand).
const fs = require("node:fs"), path = require("node:path");
const tsfsrs = (() => {
  const roots = [process.env.ETUDE_ROOT, ...(() => { try { const d = "/data/.dsh/dsh-etude/runtime"; return fs.readdirSync(d).sort().reverse().map((x) => path.join(d, x)); } catch { return []; } })(), process.cwd()].filter(Boolean);
  for (const r of roots) { const p = path.join(r, "node_modules/ts-fsrs/dist/index.cjs"); if (fs.existsSync(p)) return p; }
  throw new Error("ts-fsrs not found: set ETUDE_ROOT to an Etude install");
})();
const { fsrs, generatorParameters, createEmptyCard } = require(tsfsrs);
const pack = require(path.resolve(process.argv[2]));
const teaches = require(path.resolve(process.argv[3]));
const DAYS = Number(process.argv[4] ?? 42);
const NEW = Number(process.argv[5] ?? 48);
const PER_FACE = JSON.parse(process.argv[6] ?? "{}");
const RELEASE = Number(process.argv[7] ?? 3);
const f = fsrs(generatorParameters({ request_retention: 0.9, learning_steps: ["1m", "10m"], enable_fuzz: false }));
const has = (s) => /\{\{[\s\S]+?\}\}/.test(String(s ?? ""));
const LADDER = { begrip: ["herken", "produceer"], cloze: ["herken", "produceer"], typed: ["herken", "produceer"], uitleg: ["herken", "onthoud"], koppel: ["produceer"], orden: ["produceer"] };
const OFFSET = { herken: 0.0, produceer: 0.08, onthoud: 0.12 };
const SECONDS = { teach: 40, herken: 12, produceer: 20, onthoud: 25, oefen: 45 };
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const cards = [], byItem = {}, oefen = [];
for (const it of pack.items) {
  if (it.archived) continue;
  const kind = it.type.split("-")[1];
  if (kind === "oefen") { oefen.push({ id: it.id, need: teaches[it.id] ?? [], state: "new", tries: 0, due: null }); continue; }
  if (!LADDER[kind]) continue;
  const fl = it.fields;
  const faces = LADDER[kind].filter((x) => (x !== "herken" || fl.rec) && (x !== "produceer" || kind !== "begrip" || has(fl.text)));
  faces.forEach((face, i) => { const c = { item: it.id, face, first: i === 0, c: null, seen: false }; cards.push(c); (byItem[it.id] ??= []).push(c); });
}
const firstDay = {};
const start = new Date("2026-11-12T08:00:00Z");
const out = [];
let refreshed = 0, oefenDone = 0, oefenFirstWrong = 0;
for (let d = 0; d < DAYS; d++) {
  const day = new Date(start.getTime() + d * 86400000);
  const end = new Date(day.getTime() + 86400000);
  const studied = new Set();
  let reviews = 0, news = 0, secs = 0, oq = 0;
  const run = (card, now, isNew) => {
    let t = now;
    for (let guard = 0; guard < 12; guard++) {
      if (!card.c) card.c = createEmptyCard(t);
      const teach = isNew && card.first && !card.seen;
      let g;
      if (teach) { g = 3; secs += SECONDS.teach; }
      else {
        const r = card.c.state === 0 ? 0.85 : Math.max(0, f.get_retrievability(card.c, t, false) - OFFSET[card.face]);
        const p = card.c.state === 1 || card.c.state === 3 ? Math.min(0.95, r + 0.1) : r;
        g = rand() < p ? 3 : 1;
        secs += SECONDS[card.face];
      }
      card.seen = true;
      card.c = f.next(card.c, t, g).card;
      studied.add(card.item);
      firstDay[card.item] ??= d;
      if (card.c.due >= end) return;
      t = card.c.due;
      reviews++;
    }
  };
  for (const card of cards) if (card.c && card.c.due < end) { reviews++; run(card, day, false); }
  // Practice questions: retries due today, then released new ones within the face limit.
  const miss = (q) => {
    for (const n of q.need) for (const c of byItem[n] ?? []) if (c.c && c.c.state === 2) { c.c = { ...c.c, due: day }; refreshed++; }
  };
  for (const q of oefen) if (q.state === "retry" && q.due <= d) { secs += SECONDS.oefen; oq++; q.state = "done"; oefenDone++; }
  let left = PER_FACE.oefen ?? Infinity;
  for (const q of oefen) {
    if (q.state !== "new" || left <= 0) continue;
    const ready = q.need.length && q.need.every((n) => firstDay[n] !== undefined && (byItem[n] ?? []).some((c) => c.c && c.c.state === 2)) && Math.max(...q.need.map((n) => firstDay[n])) + RELEASE <= d;
    if (!ready) continue;
    left--; oq++; secs += SECONDS.oefen;
    if (rand() < 0.7) { q.state = "done"; oefenDone++; } else { q.state = "retry"; q.due = d + 4; oefenFirstWrong++; miss(q); }
  }
  const leftF = { ...PER_FACE };
  for (const card of cards) {
    if (news >= NEW) break;
    if (card.c || studied.has(card.item)) continue;
    if (leftF[card.face] !== undefined) { if (leftF[card.face] <= 0) continue; leftF[card.face]--; }
    news++;
    run(card, day, true);
  }
  out.push({ day: d + 1, new: news, reviews, oefen: oq, minutes: Math.round(secs / 60) });
}
const avg = (a, b, k) => Math.round(out.slice(a, b).reduce((s, x) => s + x[k], 0) / (b - a));
const cum = (k) => out.reduce((s, x) => s + x[k], 0);
console.log(JSON.stringify({
  conceptCards: cards.length, practice: oefen.length, newPerDay: NEW, newPerFace: PER_FACE,
  conceptsAllSeenByDay: (out.findIndex((x, i) => out.slice(0, i + 1).reduce((s, y) => s + y.new, 0) >= cards.length) + 1) || null,
  practiceFirstAnswered: oefen.filter((q) => q.state !== "new").length, practiceNeverReleased: oefen.filter((q) => q.state === "new").length,
  practiceAllReleasedByDay: (() => { let n = 0; for (const x of out) { n += x.oefen; } return null; })(),
  minutesPerDay: { week1: avg(0, 7, "minutes"), week2: avg(7, 14, "minutes"), week3: avg(14, 21, "minutes"), week4: avg(21, 28, "minutes"), week5: avg(28, 35, "minutes"), week6: avg(35, 42, "minutes"), max: Math.max(...out.map((x) => x.minutes)) },
  oefenPerDay: { week1: avg(0, 7, "oefen"), week3: avg(14, 21, "oefen"), week5: avg(28, 35, "oefen") },
  refreshedCards: refreshed, totalMinutes: cum("minutes"),
}));
