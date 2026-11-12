// End-to-end test of the planner against a fake etude-sync database.
// Builds events from a real Etude collection's sync registers (encrypted with a test key), then plays the same
// scenario as the manual test on 11 November: learn two concepts, see the question released 3 days later, answer
// it wrong, see exactly those concepts' review cards come back; a right answer with "Ik gok" counts as a miss.
// Usage: node test/scenario-real.mjs <etude.db>   (needs a synced SF Platform Admin collection; synthetic.mjs needs nothing)
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { d1 } from "./d1shim.mjs";
import worker, { run, learningState, dayStartIso } from "../src/worker.js";

const src = new DatabaseSync(process.argv[2], { readOnly: true });
const path = "/tmp/planner-test.db";
rmSync(path, { force: true });
const DB = d1(path);
const enc = new TextEncoder();
const vk = crypto.getRandomValues(new Uint8Array(32));
const toB64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const b64url = (u) => toB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hk = await crypto.subtle.importKey("raw", vk, "HKDF", false, ["deriveBits"]);
const ek = await crypto.subtle.importKey("raw", await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("etude-sync"), info: enc.encode("etude-events-v1") }, hk, 256), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const seal = async (id, ev) => { const n = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: enc.encode(`etude-event:v1:${id}`) }, ek, enc.encode(JSON.stringify(ev)))); const o = new Uint8Array(13 + ct.length); o[0] = 1; o.set(n, 1); o.set(ct, 13); return toB64(o); };
const dec = async (id, c) => { const b = Uint8Array.from(atob(c), (x) => x.charCodeAt(0)); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(1, 13), additionalData: enc.encode(`etude-event:v1:${id}`) }, ek, b.slice(13)))); };

DB.raw.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE vaults (account_id TEXT PRIMARY KEY, server_vk TEXT);
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, id TEXT, device TEXT, ciphertext TEXT, at TEXT, UNIQUE(account_id, id));`);
DB.raw.prepare("INSERT INTO accounts VALUES ('acc', 'k@example.com')").run();
DB.raw.prepare("INSERT INTO vaults VALUES ('acc', ?)").run(b64url(vk));
let n = 0;
const insert = DB.raw.prepare("INSERT INTO events (account_id, id, device, ciphertext) VALUES ('acc', ?, 'dev', ?)");
const push = async (ev) => { const id = `test:${ev.stamp[0]}:${ev.stamp[1]}:${n++}`; insert.run(id, await seal(id, ev)); };
// One event per row, from the collection's registers (the relevant tables only).
DB.raw.exec("BEGIN");
for (const tbl of ["items", "cards", "reviews", "attempts"]) {
  const rows = new Map();
  // Only what the deck needs: sfa items and their cards; all reviews and attempts (few).
  const like = tbl === "items" ? "sfa.%" : tbl === "cards" ? '["sfa.%' : "%";
  for (const r of src.prepare("SELECT key, field, value, stamp FROM sync_registers WHERE tbl = ? AND key LIKE ? AND field NOT LIKE '/fields/%' OR (tbl = ? AND key LIKE ? AND field = '/fields/teaches')").iterate(tbl, like, tbl, like)) {
    const row = rows.get(r.key) ?? { fields: {}, stamp: [0, 0, ""] };
    row.fields[r.field] = JSON.parse(r.value);
    const st = JSON.parse(r.stamp);
    if (st[0] > row.stamp[0] || (st[0] === row.stamp[0] && st[1] > row.stamp[1])) row.stamp = st;
    rows.set(r.key, row);
  }
  for (const [key, row] of rows) await push({ v: 1, table: tbl, key, stamp: row.stamp, fields: row.fields });
  for (const r of src.prepare("SELECT key, stamp FROM sync_deleted WHERE tbl = ?").all(tbl)) await push({ v: 1, table: tbl, key: r.key, stamp: JSON.parse(r.stamp), fields: {}, deleted: true });
}
DB.raw.exec("COMMIT");
const env = { DB, ACCOUNT_EMAIL: "k@example.com", RUN_TOKEN: "t" };
const total = DB.raw.prepare("SELECT COUNT(*) n FROM events").get().n;
console.log("events", total);

// Runs until a run reads nothing new; returns the totals of what it changed (planning happens in that idle run).
const settle = async (now) => {
  const sum = { released: 0, refreshed: 0, held: 0, misses: 0, runs: 0, counts: null };
  for (;;) {
    const r = await run(env, { now });
    sum.runs++;
    for (const k of ["released", "refreshed", "held", "misses"]) sum[k] += r[k];
    if (r.counts) sum.counts = r.counts;
    if (r.read === 0) return { ...r, ...sum };
  }
};
const ok = (cond, msg) => { if (!cond) { console.error("FAIL", msg); process.exitCode = 1; } else console.log("ok  ", msg); };
let t = new Date("2026-11-12T06:00:00Z");
let res;
const t0 = performance.now();
let runs = 0;
res = await settle(t); runs = res.runs;
console.log("backfill runs", runs, "ms", Math.round(performance.now() - t0), res);
ok(res.counts && res.counts.locked === 352 && res.released === 0, "all 352 practice questions locked at the start");
const own = async () => { const out = []; for (const r of DB.raw.prepare("SELECT id, ciphertext FROM events WHERE device = 'dev_planner' ORDER BY seq").all()) out.push(await dec(r.id, r.ciphertext)); return out; };
ok((await own()).length === 0, "no events written while nothing changes (questions already on a far date)");

// learningState mirrors ts-fsrs's learning steps (1m 10m, relearning 10m).
ok(learningState([{ ts: "a", rating: 3 }, { ts: "b", rating: 3 }]) === 2, "Good, Good -> review");
ok(learningState([{ ts: "a", rating: 4 }]) === 2, "Easy -> review");
ok(learningState([{ ts: "a", rating: 3 }, { ts: "b", rating: 1 }, { ts: "c", rating: 3 }]) === 1, "Good, Again, Good -> still learning");
ok(learningState([{ ts: "a", rating: 4 }, { ts: "b", rating: 1 }]) === 3, "review then Again -> relearning");
ok(learningState([{ ts: "a", rating: 4 }, { ts: "b", rating: 1 }, { ts: "c", rating: 3 }]) === 2, "relearning then Good -> review");
ok(dayStartIso("2027-12-31") === "2027-12-31T03:00:00.000Z" && dayStartIso("2026-07-01") === "2026-07-01T02:00:00.000Z", "day start 04:00 Amsterdam, winter and summer");

// Scenario: sfa.oefen.01-048 needs sfa.d01.company.n01 and sfa.d01.company.03.
let wall = 1794500000000, c = 0;
const st = () => [wall, c++, "testdev"];
const review = async (card, rating, ts, score = null, grade = null) => {
  const rid = `rev-${c}`, aid = `att-${c}`;
  await push({ v: 1, table: "reviews", key: rid, stamp: st(), fields: { "/card_id": card, "/ts": ts, "/rating": rating, "/score": score, "/practice": 0, "/attempt_id": aid, "/duration_ms": 1000 } });
  await push({ v: 1, table: "attempts", key: aid, stamp: st(), fields: { "/card_id": card, "/ts": ts, "/grade": JSON.stringify(grade ?? { score, details: {} }), "/review_id": rid } });
};
for (const item of ["sfa.d01.company.n01", "sfa.d01.company.03"]) for (const face of ["herken", "produceer"]) await review(JSON.stringify([item, face]), 4, "2026-11-12T07:00:00.000Z");
t = new Date("2026-11-12T07:30:00Z");
res = await settle(t);
let evs = await own();
const rel = evs.filter((e) => e.key === JSON.stringify(["sfa.oefen.01-048", "oefen"]));
ok(rel.length === 1 && rel[0].fields["/sync_due"] === dayStartIso("2026-11-15"), `question released on 2026-11-15 (got ${rel[0]?.fields["/sync_due"]})`);
ok(res.released >= 1, `released ${res.released} questions in total once both concepts are learned`);
const releasedNow = res.released;

// Answer it wrong.
const qc = JSON.stringify(["sfa.oefen.01-048", "oefen"]);
await review(qc, 0, "2026-11-15T07:00:00.000Z", 0, { score: 0, details: { chosen: ["o3"] } });
t = new Date("2026-11-15T07:10:00Z");
res = await settle(t);
evs = (await own()).slice(-res.refreshed);
const back = new Set(evs.map((e) => e.key));
const want = ["herken", "produceer"].flatMap((f) => ["sfa.d01.company.n01", "sfa.d01.company.03"].map((i) => JSON.stringify([i, f])));
ok(res.misses === 1 && want.every((k) => back.has(k)), `a wrong answer brings back the concept cards in review (${res.refreshed}: ${[...back].join(" ")})`);
ok(evs.every((e) => e.fields["/sync_due"] === t.toISOString()), "they are due now");

// Running again does nothing new.
res = await settle(new Date("2026-11-15T07:20:00Z"));
ok(res.refreshed === 0 && res.misses === 0 && res.released === 0, "a second run changes nothing");

// A right answer marked "Ik gok" counts as a miss.
const other = JSON.parse(DB.raw.prepare("SELECT key FROM planner_rows WHERE tbl='cards' AND ref LIKE 'sfa.oefen.%' AND key <> ? LIMIT 1").get(qc).key);
await review(JSON.stringify(other), 0, "2026-11-15T08:00:00.000Z", 1, { score: 1, details: { gok: true } });
res = await settle(new Date("2026-11-15T08:10:00Z"));
ok(res.misses === 1, "a right answer with Ik gok counts as a miss");

// A right answer is no miss.
const third = DB.raw.prepare("SELECT key FROM planner_rows WHERE tbl='cards' AND ref LIKE 'sfa.oefen.%' AND key NOT IN (?, ?) LIMIT 1").get(qc, JSON.stringify(other)).key;
await review(third, 0, "2026-11-15T09:00:00.000Z", 1, { score: 1, details: {} });
res = await settle(new Date("2026-11-15T09:10:00Z"));
ok(res.misses === 0 && res.refreshed === 0, "a right answer changes nothing");

// The fetch handler needs the token.
const r401 = await worker.fetch(new Request("https://x/status"), env);
const r200 = await worker.fetch(new Request("https://x/status", { headers: { authorization: "Bearer t" } }), env);
ok(r401.status === 401 && r200.status === 200, "status needs the run token");
console.log(JSON.stringify((await r200.json()).last));
console.log(process.exitCode ? "FAILED" : "ALL OK", "released at first:", releasedNow);
