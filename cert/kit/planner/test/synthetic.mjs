// Self-contained planner test: a made-up deck with prefix "aws"/"awl" (not the SF defaults), no real collection.
// Two concept items, two practice questions that need them, one that needs a concept never learned.
// Checks: hold on a far date, release RELEASE_DAYS after the last concept was first studied, a miss and a
// guess bring the concept cards back, a right answer changes nothing, learning steps count, the token guard.
// Usage: node test/synthetic.mjs
import { rmSync } from "node:fs";
import { d1 } from "./d1shim.mjs";
import worker, { run, learningState, dayStartIso, configure } from "../src/worker.js";

const path = "/tmp/planner-synthetic.db";
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
let n = 0, wall = 1794400000000, c = 0;
const st = () => [wall, c++, "testdev"];
const insert = DB.raw.prepare("INSERT INTO events (account_id, id, device, ciphertext) VALUES ('acc', ?, 'dev', ?)");
const push = async (ev) => { const id = `test:${ev.stamp[0]}:${ev.stamp[1]}:${n++}`; insert.run(id, await seal(id, ev)); };

const A = "aws.d01.iam.01", B = "aws.d01.iam.02", Z = "aws.d02.s3.01";
const Q1 = "aws.oefen.01-001", Q2 = "aws.oefen.01-002", Q3 = "aws.oefen.02-001";
const card = (item, face) => JSON.stringify([item, face]);
for (const [id, teaches] of [[Q1, [A, B]], [Q2, [A]], [Q3, [Z]]]) {
  await push({ v: 1, table: "items", key: id, stamp: st(), fields: { "/type": "awl-oefen", "/archived": 0, "/fields/teaches": teaches } });
  await push({ v: 1, table: "cards", key: card(id, "oefen"), stamp: st(), fields: { "/suspended": 0 } });
}
for (const it of [A, B, Z]) for (const f of ["herken", "produceer"]) await push({ v: 1, table: "cards", key: card(it, f), stamp: st(), fields: { "/suspended": 0 } });
// A foreign deck's practice question with the SF prefix must be ignored.
await push({ v: 1, table: "items", key: "sfa.oefen.01-048", stamp: st(), fields: { "/type": "sfl-oefen", "/archived": 0, "/fields/teaches": [A] } });
await push({ v: 1, table: "cards", key: card("sfa.oefen.01-048", "oefen"), stamp: st(), fields: { "/suspended": 0 } });

const env = { DB, ACCOUNT_EMAIL: "k@example.com", RUN_TOKEN: "t", ITEM_PREFIX: "aws", TYPE_PREFIX: "awl", RELEASE_DAYS: "2", TZ: "UTC", DAY_START_HOUR: "0", LEARNING_STEPS: "1" };
const settle = async (now) => {
  const sum = { released: 0, refreshed: 0, held: 0, misses: 0, counts: null };
  for (;;) {
    const r = await run(env, { now });
    for (const k of ["released", "refreshed", "held", "misses"]) sum[k] += r[k];
    if (r.counts) sum.counts = r.counts;
    if (r.read === 0) return { ...r, ...sum };
  }
};
const own = async () => { const out = []; for (const r of DB.raw.prepare("SELECT id, ciphertext FROM events WHERE device = 'dev_planner' ORDER BY seq").all()) out.push(await dec(r.id, r.ciphertext)); return out; };
const ok = (cond, msg) => { if (!cond) { console.error("FAIL", msg); process.exitCode = 1; } else console.log("ok  ", msg); };
const review = async (cardKey, rating, ts, score = null, grade = null) => {
  const rid = `rev-${c}`, aid = `att-${c}`;
  await push({ v: 1, table: "reviews", key: rid, stamp: st(), fields: { "/card_id": cardKey, "/ts": ts, "/rating": rating, "/score": score, "/practice": 0, "/attempt_id": aid, "/duration_ms": 1000 } });
  await push({ v: 1, table: "attempts", key: aid, stamp: st(), fields: { "/card_id": cardKey, "/ts": ts, "/grade": JSON.stringify(grade ?? { score, details: {} }), "/review_id": rid } });
};

let res = await settle(new Date("2026-12-01T10:00:00Z"));
ok(res.counts.locked === 3 && res.held === 3, `3 questions of this deck locked and held, the foreign one ignored (${JSON.stringify(res.counts)})`);
let evs = await own();
ok(evs.every((e) => e.fields["/sync_due"] === dayStartIso("2027-12-31")), "held on the far date");
ok(!evs.some((e) => e.key.includes("sfa.")), "never touches another deck's cards");

// Learn A on day 1 and B on day 3 (one learning step: one Good is enough).
for (const f of ["herken", "produceer"]) await review(card(A, f), 3, "2026-12-01T10:05:00.000Z");
res = await settle(new Date("2026-12-01T10:30:00Z"));
evs = await own();
ok(evs.filter((e) => e.key === card(Q2, "oefen")).at(-1)?.fields["/sync_due"] === dayStartIso("2026-12-03"), "Q2 (needs A) released 2 days after A was first studied");
ok(!evs.some((e) => e.key === card(Q1, "oefen") && e.fields["/sync_due"] !== dayStartIso("2027-12-31")), "Q1 still held (B not learned)");
for (const f of ["herken", "produceer"]) await review(card(B, f), 3, "2026-12-03T09:00:00.000Z");
res = await settle(new Date("2026-12-03T09:30:00Z"));
evs = await own();
ok(evs.filter((e) => e.key === card(Q1, "oefen")).at(-1)?.fields["/sync_due"] === dayStartIso("2026-12-05"), "Q1 released 2 days after the last of A and B");

// A miss on Q1 brings A's and B's cards back now.
const t = new Date("2026-12-05T08:00:00Z");
await review(card(Q1, "oefen"), 0, "2026-12-05T07:50:00.000Z", 0, { score: 0, details: {} });
res = await settle(t);
const back = new Set((await own()).slice(-res.refreshed).map((e) => e.key));
ok(res.misses === 1 && res.refreshed === 4 && [A, B].every((i) => back.has(card(i, "herken")) && back.has(card(i, "produceer"))), `a miss brings back exactly the 4 concept cards (${[...back].join(" ")})`);
// A guess on Q2 counts as a miss; a right answer does nothing.
await review(card(Q2, "oefen"), 0, "2026-12-05T09:00:00.000Z", 1, { score: 1, details: { gok: true } });
res = await settle(new Date("2026-12-05T09:10:00Z"));
ok(res.misses === 1 && res.refreshed === 2, "a right answer with a guess counts as a miss (A's 2 cards back)");
await review(card(Q2, "oefen"), 0, "2026-12-09T09:00:00.000Z", 1, { score: 1, details: {} });
res = await settle(new Date("2026-12-09T09:10:00Z"));
ok(res.misses === 0 && res.refreshed === 0, "a right answer changes nothing");

configure({ LEARNING_STEPS: "2", RELEARNING_STEPS: "1" });
ok(learningState([{ ts: "a", rating: 3 }]) === 1 && learningState([{ ts: "a", rating: 3 }, { ts: "b", rating: 3 }]) === 2, "two learning steps: Good, Good -> review");
ok(learningState([{ ts: "a", rating: 4 }, { ts: "b", rating: 1 }]) === 3, "review then Again -> relearning");
configure({});
ok(dayStartIso("2027-12-31") === "2027-12-31T03:00:00.000Z" && dayStartIso("2026-07-01") === "2026-07-01T02:00:00.000Z", "defaults: day start 04:00 Amsterdam, winter and summer");

const r401 = await worker.fetch(new Request("https://x/status"), env);
const r200 = await worker.fetch(new Request("https://x/status", { headers: { authorization: "Bearer t" } }), env);
ok(r401.status === 401 && r200.status === 200, "status needs the run token");
console.log(process.exitCode ? "FAILED" : "ALL OK");
