// Seeds the planner Worker from a synced Etude collection, so it does not have to replay the whole sync log
// (the free plan gives a Worker 10 ms of CPU per run). Run after `etude sync now`; read-only on the collection.
// Usage: node seed.mjs <etude.db> <worker-url> <run-token> [--items sfa] [--types sfl] [--dry]
// --items / --types must match the Worker's ITEM_PREFIX / TYPE_PREFIX (cert.json ids.items / ids.types).
import { DatabaseSync } from "node:sqlite";
import { configure, keep, learningState } from "./src/worker.js";

const [dbPath, url, token] = process.argv.slice(2);
const flag = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const ITEM = flag("--items", "sfa");
configure({ ITEM_PREFIX: ITEM, TYPE_PREFIX: flag("--types", "sfl") });
const dry = process.argv.includes("--dry");
const db = new DatabaseSync(dbPath, { readOnly: true });
const cursor = Number(JSON.parse(db.prepare("SELECT value FROM sync_meta WHERE key = 'cursor'").get().value));
const pending = db.prepare("SELECT (SELECT count(*) FROM sync_outbox) + (SELECT count(*) FROM sync_events WHERE sent = 0) AS n").get().n;
if (pending) throw new Error(`the collection has ${pending} unsent changes: run etude sync now first`);

// Rebuild each row's registers the way the Worker stores them: {field: [value, stamp]}, through the same keep().
const rows = new Map();
for (const tbl of ["items", "cards", "reviews", "attempts"]) {
  const like = tbl === "items" ? `${ITEM}.oefen.%` : tbl === "cards" ? `["${ITEM}.%` : "%";
  for (const r of db.prepare("SELECT key, field, value, stamp FROM sync_registers WHERE tbl = ? AND key LIKE ?").iterate(tbl, like)) {
    const k = `${tbl}\u0000${r.key}`;
    const row = rows.get(k) ?? { tbl, key: r.key, fields: {}, stamps: {} };
    row.fields[r.field] = JSON.parse(r.value);
    row.stamps[r.field] = JSON.parse(r.stamp);
    rows.set(k, row);
  }
}
const deleted = new Map(db.prepare("SELECT tbl, key, stamp FROM sync_deleted WHERE tbl IN ('items','cards','reviews','attempts')").all().map((r) => [`${r.tbl}\u0000${r.key}`, JSON.parse(r.stamp)]));
const out = [];
for (const [k, row] of rows) {
  const kept = keep({ table: row.tbl, key: row.key, fields: row.fields });
  if (!kept) continue;
  const regs = {};
  for (const [f, v] of Object.entries(kept)) regs[f] = [v, row.stamps[f] ?? row.stamps["/grade"]];
  out.push([row.tbl, row.key, regs, deleted.get(k) ?? null]);
}
// Card states, from the reviews (the same replay the Worker does).
const reviewsOf = new Map();
for (const [tbl, key, regs, del] of out) {
  if (tbl !== "reviews" || del) continue;
  const v = (f) => regs[f]?.[0];
  if (!v("/card_id") || !v("/ts")) continue;
  (reviewsOf.get(v("/card_id")) ?? reviewsOf.set(v("/card_id"), []).get(v("/card_id"))).push({ key, ts: v("/ts"), rating: v("/rating"), score: v("/score"), practice: v("/practice") });
}
const resetOf = new Map(out.filter((r) => r[0] === "cards").map((r) => [r[1], r[2]["/sync_reset"]?.[0] ?? null]));
const cards = [];
for (const [card, list] of reviewsOf) {
  list.sort((a, b) => a.ts.localeCompare(b.ts) || a.key.localeCompare(b.key));
  const reset = resetOf.get(card);
  const counted = list.filter((r) => !r.practice && !(reset && r.ts <= reset));
  cards.push([card, JSON.parse(card)[0], learningState(list, reset), counted[0]?.ts ?? null, counted.length]);
}
// Answers to practice questions given before the planner existed are handled already (none so far).
const handled = out.filter((r) => r[0] === "reviews" && String(r[2]["/card_id"]?.[0] ?? "").startsWith(`["${ITEM}.oefen.`)).map((r) => r[1]);
const wall = Math.max(...out.flatMap((r) => Object.values(r[2]).map((x) => x[1][0])));
console.log({ cursor, rows: out.length, cards: cards.length, learned: cards.filter((c) => c[2] === 2).length, handled: handled.length });
if (dry) process.exit(0);

const post = async (body) => {
  const r = await fetch(url.replace(/\/$/, "") + "/seed", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
};
await post({ reset: true });
for (let i = 0; i < out.length; i += 400) await post({ rows: out.slice(i, i + 400) });
for (let i = 0; i < cards.length; i += 400) await post({ cards: cards.slice(i, i + 400) });
if (handled.length) await post({ handled });
console.log(await post({ meta: { cursor, wall, counter: 0, maxRemote: wall, dirty: true, inflight: 0, seededAt: new Date().toISOString() } }));
