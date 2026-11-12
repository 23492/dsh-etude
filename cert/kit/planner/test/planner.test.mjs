// Self-contained test of the multi-account planner against a fake etude-sync D1 (node:sqlite).
// Two accounts. Account A has two certification decks with different prefixes and settings; account B one deck
// and a server that does not keep its vault key. Settings come only from synced decks, presets, types and schedulers.
// Usage: node test/planner.test.mjs
import { rmSync } from "node:fs";
import { d1 } from "./d1shim.mjs";
import { runPlanner, learningState, dayStartIso, plannerStatus } from "../src/planner.js";

const path = "/tmp/planner-multi.db";
rmSync(path, { force: true });
const DB = d1(path);
const enc = new TextEncoder();
const toB64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const b64url = (u) => toB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vault() {
  const vk = crypto.getRandomValues(new Uint8Array(32));
  const hk = await crypto.subtle.importKey("raw", vk, "HKDF", false, ["deriveBits"]);
  const ek = await crypto.subtle.importKey("raw", await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("etude-sync"), info: enc.encode("etude-events-v1") }, hk, 256), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { vk: b64url(vk), ek };
}
const seal = async (ek, id, ev) => { const n = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: enc.encode(`etude-event:v1:${id}`) }, ek, enc.encode(JSON.stringify(ev)))); const o = new Uint8Array(13 + ct.length); o[0] = 1; o.set(n, 1); o.set(ct, 13); return toB64(o); };
const open = async (ek, id, c) => { const b = Uint8Array.from(atob(c), (x) => x.charCodeAt(0)); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(1, 13), additionalData: enc.encode(`etude-event:v1:${id}`) }, ek, b.slice(13)))); };

DB.raw.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE vaults (account_id TEXT PRIMARY KEY, server_vk TEXT);
  CREATE TABLE blocked (email TEXT PRIMARY KEY);
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, id TEXT, device TEXT, ciphertext TEXT, at TEXT, UNIQUE(account_id, id));`);
const A = await vault(), B = await vault();
DB.raw.prepare("INSERT INTO accounts VALUES ('accA', 'a@x.test'), ('accB', 'b@x.test'), ('accC', 'c@x.test')").run();
DB.raw.prepare("INSERT INTO vaults VALUES ('accA', ?), ('accB', ?), ('accC', NULL)").run(A.vk, B.vk);
let n = 0, wall = 1794400000000, c = 0;
const st = () => [wall, c++, "testdev"];
const insert = DB.raw.prepare("INSERT INTO events (account_id, id, device, ciphertext) VALUES (?, ?, 'dev', ?)");
const push = async (acct, v, ev) => { const id = `test:${ev.stamp[0]}:${ev.stamp[1]}:${n++}`; insert.run(acct, id, await seal(v.ek, id, ev)); };
const card = (item, face) => JSON.stringify([item, face]);
const ok = (cond, msg) => { if (!cond) { console.error("FAIL", msg); process.exitCode = 1; } else console.log("ok  ", msg); };
const env = { DB, PLANNER_TZ: "Europe/Amsterdam" };

// ---- Account A: deck "AWS" (prefix aws/awl, preset with 1 learning step, releaseDays 2 on the deck),
//      deck "SF" (prefix sfa/sfl, defaults from Etude: 2 learning steps; releaseDays from the scheduler option = 3).
const a = (ev) => push("accA", A, ev);
await a({ v: 1, table: "settings", key: "settings", stamp: st(), fields: { "/value/dayStartHour": 4 } });
await a({ v: 1, table: "presets", key: "aws-exam", stamp: st(), fields: { "/config/learningSteps": ["10m"], "/config/relearningSteps": ["10m"] } });
await a({ v: 1, table: "decks", key: "dAWS", stamp: st(), fields: { "/name": "AWS", "/preset_id": "aws-exam", "/config/schedulerOptions/releaseDays": 2 } });
await a({ v: 1, table: "decks", key: "dAWS1", stamp: st(), fields: { "/name": "AWS::1 IAM", "/preset_id": null } });
await a({ v: 1, table: "decks", key: "dSF", stamp: st(), fields: { "/name": "SF", "/preset_id": null } });
await a({ v: 1, table: "schedulers", key: "sfa-oefen", stamp: st(), fields: { "/def/options": [{ name: "againDays", default: 4 }, { name: "releaseDays", default: 3 }] } });
await a({ v: 1, table: "types", key: "sfl-oefen", stamp: st(), fields: { "/def/scheduler": "sfa-oefen" } });
const AW1 = "aws.d01.iam.01", AW2 = "aws.d01.iam.02", AQ = "aws.oefen.01-001", AQ2 = "aws.oefen.01-002";
const SF1 = "sfa.d01.company.01", SQ = "sfa.oefen.01-048";
for (const [id, deck, type, teaches] of [[AQ, "dAWS1", "awl-oefen", [AW1, AW2]], [AQ2, "dAWS1", "awl-oefen", [AW1]], [SQ, "dSF", "sfl-oefen", [SF1]]]) {
  await a({ v: 1, table: "items", key: id, stamp: st(), fields: { "/type": type, "/deck_id": deck, "/archived": 0, "/fields/teaches": teaches } });
  await a({ v: 1, table: "cards", key: card(id, "oefen"), stamp: st(), fields: { "/suspended": 0 } });
}
for (const [id, deck] of [[AW1, "dAWS1"], [AW2, "dAWS1"], [SF1, "dSF"]]) {
  await a({ v: 1, table: "items", key: id, stamp: st(), fields: { "/type": id.startsWith("aws") ? "awl-begrip" : "sfl-begrip", "/deck_id": deck, "/archived": 0 } });
  for (const f of ["herken", "produceer"]) await a({ v: 1, table: "cards", key: card(id, f), stamp: st(), fields: { "/suspended": 0 } });
}
// A mock exam question (no teaches) is never touched.
await a({ v: 1, table: "items", key: "aws.proef.01-009", stamp: st(), fields: { "/type": "awl-examen", "/deck_id": "dAWS", "/archived": 0 } });
await a({ v: 1, table: "cards", key: card("aws.proef.01-009", "examen"), stamp: st(), fields: { "/suspended": 0 } });

// ---- Account B: one deck, defaults everywhere.
const b = (ev) => push("accB", B, ev);
await b({ v: 1, table: "decks", key: "dX", stamp: st(), fields: { "/name": "ISTQB" } });
await b({ v: 1, table: "items", key: "ist.oefen.1", stamp: st(), fields: { "/type": "isl-oefen", "/deck_id": "dX", "/archived": 0, "/fields/teaches": ["ist.d1.a.01"] } });
await b({ v: 1, table: "cards", key: card("ist.oefen.1", "oefen"), stamp: st(), fields: { "/suspended": 0 } });
await b({ v: 1, table: "items", key: "ist.d1.a.01", stamp: st(), fields: { "/type": "isl-begrip", "/deck_id": "dX", "/archived": 0 } });
await b({ v: 1, table: "cards", key: card("ist.d1.a.01", "herken"), stamp: st(), fields: { "/suspended": 0 } });

const review = async (acct, v, cardKey, rating, ts, score = null, grade = null) => {
  const rid = `rev-${c}`, aid = `att-${c}`;
  await push(acct, v, { v: 1, table: "reviews", key: rid, stamp: st(), fields: { "/card_id": cardKey, "/ts": ts, "/rating": rating, "/score": score, "/practice": 0, "/attempt_id": aid } });
  await push(acct, v, { v: 1, table: "attempts", key: aid, stamp: st(), fields: { "/card_id": cardKey, "/ts": ts, "/grade": JSON.stringify(grade ?? { score, details: {} }), "/review_id": rid } });
};
/** Cron runs until nothing is left to do (each run works on one account). */
const settle = async (now) => {
  let runs = 0;
  for (;;) {
    const r = await runPlanner(env, { now });
    runs++;
    if (r.idle || runs > 200) return runs;
  }
};
const own = async (acct, v) => { const out = []; for (const r of DB.raw.prepare("SELECT id, ciphertext FROM events WHERE account_id = ? AND device = 'dev_planner' ORDER BY seq").all(acct)) out.push(await open(v.ek, r.id, r.ciphertext)); return out; };
const dueOf = (evs, key) => evs.filter((e) => e.key === key).at(-1)?.fields["/sync_due"];
const FAR = (h = 4) => dayStartIso("2027-12-31", "Europe/Amsterdam", h);

let runs = await settle(new Date("2026-12-01T10:00:00Z"));
let ea = await own("accA", A), eb = await own("accB", B);
ok(dueOf(ea, card(AQ, "oefen")) === FAR() && dueOf(ea, card(AQ2, "oefen")) === FAR() && dueOf(ea, card(SQ, "oefen")) === FAR(), `account A: all 3 practice questions of both decks held (${runs} runs)`);
ok(dueOf(eb, card("ist.oefen.1", "oefen")) === FAR(), "account B: its practice question held too");
ok(!ea.some((e) => e.key.includes(".proef.")) && !ea.some((e) => e.key.includes("iam.0")), "mock exams and concept cards untouched");
ok(!DB.raw.prepare("SELECT 1 FROM events WHERE account_id = 'accC' AND device = 'dev_planner'").get(), "an account without a server-kept key is skipped");
ok(await settle(new Date("2026-12-01T10:05:00Z")) === 1, "nothing to do: one idle run");

// AWS deck: one learning step (preset). One Good on AW1 is enough; release 2 days later (deck releaseDays).
for (const f of ["herken", "produceer"]) await review("accA", A, card(AW1, f), 3, "2026-12-01T10:10:00.000Z");
// SF deck: Etude's default 2 learning steps. One Good is NOT enough.
await review("accA", A, card(SF1, "herken"), 3, "2026-12-01T10:10:00.000Z");
await settle(new Date("2026-12-01T10:30:00Z"));
ea = await own("accA", A);
ok(dueOf(ea, card(AQ2, "oefen")) === dayStartIso("2026-12-03"), `AWS: Q2 (needs AW1) released 2 days later, from the deck's own releaseDays (got ${dueOf(ea, card(AQ2, "oefen"))})`);
ok(dueOf(ea, card(AQ, "oefen")) === FAR(), "AWS: Q1 still held (AW2 not learned)");
ok(dueOf(ea, card(SQ, "oefen")) === FAR(), "SF: one Good is not enough with two learning steps");
await review("accA", A, card(SF1, "herken"), 3, "2026-12-01T10:20:00.000Z");
await settle(new Date("2026-12-01T10:40:00Z"));
ea = await own("accA", A);
ok(dueOf(ea, card(SQ, "oefen")) === dayStartIso("2026-12-04"), `SF: released after the second Good, 3 days after first studied (scheduler option) (got ${dueOf(ea, card(SQ, "oefen"))})`);

// A miss on AQ2 brings AW1's cards back now; a guess counts as a miss; a right answer does nothing.
await review("accA", A, card(AQ2, "oefen"), 0, "2026-12-03T08:00:00.000Z", 0, { score: 0, details: {} });
const t = new Date("2026-12-03T08:10:00Z");
await settle(t);
ea = await own("accA", A);
ok([card(AW1, "herken"), card(AW1, "produceer")].every((k) => dueOf(ea, k) === t.toISOString()), "a miss brings the linked concept cards back now");
const before = ea.length;
await review("accA", A, card(SQ, "oefen"), 0, "2026-12-04T08:00:00.000Z", 1, { score: 1, details: { gok: true } });
const t2 = new Date("2026-12-04T08:10:00Z");
await settle(t2);
ea = await own("accA", A);
ok(dueOf(ea, card(SF1, "herken")) === t2.toISOString(), "a right answer after the guess button counts as a miss");
await review("accA", A, card(AQ, "oefen"), 0, "2026-12-04T09:00:00.000Z", 1, { score: 1, details: {} });
const n0 = (await own("accA", A)).length;
await settle(new Date("2026-12-04T09:10:00Z"));
ok((await own("accA", A)).length === n0, "a right answer changes nothing");
ok(before > 0, "events were written");

// Changing the preset's learning steps re-applies to later reviews (deck setting, not a constant).
ok(learningState([{ ts: "a", rating: 3 }], null, 1, 1) === 2 && learningState([{ ts: "a", rating: 3 }], null, 2, 1) === 1, "learning steps come from the caller");
ok(learningState([{ ts: "a", rating: 4 }, { ts: "b", rating: 1 }], null, 2, 1) === 3, "review then Again -> relearning");
ok(dayStartIso("2027-12-31") === "2027-12-31T03:00:00.000Z" && dayStartIso("2026-07-01") === "2026-07-01T02:00:00.000Z", "day start 04:00 Amsterdam, winter and summer");

// Blocked accounts are skipped.
DB.raw.prepare("INSERT INTO blocked VALUES ('b@x.test')").run();
await review("accB", B, card("ist.d1.a.01", "herken"), 4, "2026-12-05T08:00:00.000Z");
const nb = (await own("accB", B)).length;
await settle(new Date("2026-12-05T08:10:00Z"));
ok((await own("accB", B)).length === nb, "a blocked account is left alone");

const status = await plannerStatus(env);
ok(status.length === 2 && status.every((s) => s.last), `status lists both accounts (${status.map((s) => s.email).join(", ")})`);
console.log(process.exitCode ? "FAILED" : "ALL OK");
