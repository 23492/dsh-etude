// Seeds the planner for one account from that person's synced Etude collection, so it does not have to replay the
// whole sync log (the free plan gives a Worker 10 ms of CPU per run, and a big pack import makes thousands of events).
// Optional: without a seed the planner works through the log by itself, a few dozen KB per run.
// Run after `etude sync now`; read-only on the collection.
// Usage: node seed.mjs <etude.db> <sync-url> <admin-token> <email> [--dry]
// The Sync server's /admin/planner/seed route (etude-cloudflare) takes the rows; behind Cloudflare Access call it from
// a session that passes Access, or post the same JSON with the Cloudflare API.
import { DatabaseSync } from "node:sqlite";
import { keep, learningState, deckSettings } from "./src/planner.js";

const [dbPath, url, token, email] = process.argv.slice(2);
if (!email) throw new Error("usage: node seed.mjs <etude.db> <sync-url> <admin-token> <email> [--dry]");
const dry = process.argv.includes("--dry");
const db = new DatabaseSync(dbPath, { readOnly: true });
const cursor = Number(JSON.parse(db.prepare("SELECT value FROM sync_meta WHERE key = 'cursor'").get().value));
const pending = db.prepare("SELECT (SELECT count(*) FROM sync_outbox) + (SELECT count(*) FROM sync_events WHERE sent = 0) AS n").get().n;
if (pending) throw new Error(`the collection has ${pending} unsent changes: run etude sync now first`);

// Rebuild each row's registers the way the planner stores them: {field: [value, stamp]}, through the same keep().
const rows = new Map();
for (const r of db.prepare("SELECT tbl, key, field, value, stamp FROM sync_registers WHERE tbl IN ('items','cards','reviews','attempts','decks','presets','types','schedulers','settings')").iterate()) {
  const k = `${r.tbl}\u0000${r.key}`;
  const row = rows.get(k) ?? { tbl: r.tbl, key: r.key, fields: {}, stamps: {} };
  row.fields[r.field] = JSON.parse(r.value);
  row.stamps[r.field] = JSON.parse(r.stamp);
  rows.set(k, row);
}
const deleted = new Map(db.prepare("SELECT tbl, key, stamp FROM sync_deleted").all().map((r) => [`${r.tbl}\u0000${r.key}`, JSON.parse(r.stamp)]));
const out = [];
for (const [k, row] of rows) {
  const kept = keep({ table: row.tbl, key: row.key, fields: row.fields });
  if (!kept || !Object.keys(kept).length) continue;
  const regs = {};
  for (const [f, v] of Object.entries(kept)) regs[f] = [v, row.stamps[f] ?? row.stamps["/grade"]];
  out.push([row.tbl, row.key, regs, deleted.get(k) ?? null]);
}
const byKey = new Map(out.map((r) => [`${r[0]}\u0000${r[1]}`, r]));
// Card states from the reviews, with each card's own deck's learning steps (the same replay the planner does).
const ctx = { decks: new Map(), byName: new Map(), presets: new Map(), types: new Map(), schedulers: new Map(), dayStartHour: 4, cache: new Map() };
for (const [tbl, key, regs, del] of out) {
  if (del) continue;
  const row = { regs, del: null };
  if (tbl === "decks") { ctx.decks.set(key, row); if (typeof regs["/name"]?.[0] === "string") ctx.byName.set(regs["/name"][0], row); }
  if (tbl === "presets") ctx.presets.set(key, row);
}
const deckOf = new Map(out.filter((r) => r[0] === "items").map((r) => [r[1], r[2]["/deck_id"]?.[0]]));
const reviewsOf = new Map();
for (const [tbl, key, regs, del] of out) {
  if (tbl !== "reviews" || del) continue;
  const v = (f) => regs[f]?.[0];
  if (!v("/card_id") || !v("/ts")) continue;
  (reviewsOf.get(v("/card_id")) ?? reviewsOf.set(v("/card_id"), []).get(v("/card_id"))).push({ key, ts: v("/ts"), rating: v("/rating"), score: v("/score"), practice: v("/practice") });
}
const cards = [];
for (const [card, list] of reviewsOf) {
  list.sort((a, b) => a.ts.localeCompare(b.ts) || a.key.localeCompare(b.key));
  const reset = byKey.get(`cards\u0000${card}`)?.[2]["/sync_reset"]?.[0] ?? null;
  const counted = list.filter((r) => !r.practice && !(reset && r.ts <= reset));
  const item = JSON.parse(card)[0];
  const s = deckSettings(ctx, deckOf.get(item));
  cards.push([card, item, learningState(list, reset, s.learningSteps, s.relearningSteps), counted[0]?.ts ?? null, counted.length]);
}
// Answers already in the collection count as handled: the planner only follows up answers it sees arrive.
const handled = out.filter((r) => r[0] === "reviews").map((r) => r[1]);
// Keep the seed small: only practice items, their cards, cards with a reset, reviews and the settings rows.
const practice = new Set(out.filter((r) => r[0] === "items" && Array.isArray(r[2]["/fields/teaches"]?.[0])).map((r) => r[1]));
const slim = out.filter(([tbl, key, regs]) => (tbl === "items" ? practice.has(key) : tbl === "cards" ? practice.has(JSON.parse(key)[0]) || !!regs["/sync_reset"] : tbl !== "attempts"));
const wall = Math.max(0, ...out.flatMap((r) => Object.values(r[2]).map((x) => x[1][0])));
console.log({ cursor, rows: slim.length, cards: cards.length, learned: cards.filter((c) => c[2] === 2).length, practice: practice.size, handled: handled.length });
if (dry) process.exit(0);

const post = async (body) => {
  const r = await fetch(url.replace(/\/$/, "") + "/admin/planner/seed", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ email, ...body }) });
  const j = await r.json().catch(() => ({ status: r.status }));
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
};
await post({ reset: true });
for (let i = 0; i < slim.length; i += 400) await post({ rows: slim.slice(i, i + 400) });
for (let i = 0; i < cards.length; i += 400) await post({ cards: cards.slice(i, i + 400) });
for (let i = 0; i < handled.length; i += 1000) await post({ handled: handled.slice(i, i + 1000) });
console.log(await post({ state: { cursor, wall, counter: 0, maxRemote: wall, dirty: true, inflight: 0, seededAt: new Date().toISOString() } }));
