// cert-planner: releases practice questions and follows up misses in an Etude certification deck, inside Cloudflare,
// next to the etude-sync Worker (dsh-etude cert/references/design.md and planner.md).
//
// It reads the vault's sync events straight from the etude-sync D1 database, decrypts them with the vault key the
// server keeps (Sync without a password), and writes due-date changes back as ordinary sync events, the same ones
// `etude card due` makes on a device. Every device picks them up at its next sync. Nothing is ever rated.
//
// Rules:
// 1. A practice question (item type <TYPE_PREFIX>-oefen) waits until every concept item in its `teaches` field has a card in
//    review. It then becomes due RELEASE_DAYS after the last of those items was first studied (not before today).
//    A new practice question that has no due date yet is held on a far date until then.
// 2. A practice question answered wrong, or right after "Ik gok", brings the concept cards that teach it (those in
//    review) back now. Every answer is handled once.
// 3. Mock-exam questions (<TYPE_PREFIX>-examen) and everything else are never touched.
//
// One deck per Worker. Configuration (wrangler vars, defaults = the SF Platform Admin deck):
//   ITEM_PREFIX (sfa), TYPE_PREFIX (sfl), RELEASE_DAYS (3), LEARNING_STEPS (2), RELEARNING_STEPS (1),
//   TZ (Europe/Amsterdam), DAY_START_HOUR (4), FAR (2027-12-31), ACCOUNT_EMAIL (required).
//
// State lives in planner_* tables in the same D1 database: the registers it needs (last writer wins per field,
// Etude's own model), each concept card's learning state, and the answers already handled. Each run reads at most
// BUDGET bytes of new events, and plans only in a run that read nothing new, so each run stays inside the free plan's
// CPU budget (10 ms); a backlog is worked off over several runs.

const BATCH = 200; // events per query
const BUDGET = 24 * 1024; // ciphertext bytes decrypted per run: about 4 ms CPU, the free plan allows 10
// Per-deck settings come from env (see configure()); these are the defaults.
let RELEASE_DAYS = 3;
let FAR = "2027-12-31";
let TZ = "Europe/Amsterdam";
let DAY_START_HOUR = 4;
// The deck preset's learning steps (1m 10m) and relearning steps (10m). Only their count matters here.
let LEARNING_STEPS = 2;
let RELEARNING_STEPS = 1;
let ITEM = "sfa";
let TYPE = "sfl";
/** Reads the deck's settings from the Worker's vars. Called at the start of every entry point. */
export function configure(env = {}) {
  const n = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  RELEASE_DAYS = n(env.RELEASE_DAYS, 3);
  LEARNING_STEPS = n(env.LEARNING_STEPS, 2);
  RELEARNING_STEPS = n(env.RELEARNING_STEPS, 1);
  DAY_START_HOUR = n(env.DAY_START_HOUR, 4);
  FAR = env.FAR || "2027-12-31";
  TZ = env.TZ || "Europe/Amsterdam";
  ITEM = env.ITEM_PREFIX || "sfa";
  TYPE = env.TYPE_PREFIX || "sfl";
}
const DEVICE = "e7a1d0c4b9f2483a9c6e5d10f00dbeef"; // stamp tie-breaker for this planner's own events
const DEVICE_ROW = "dev_planner";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- crypto (Etude Sync v1, crypto.ts)
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const toB64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
async function eventsKey(vk) {
  const k = await crypto.subtle.importKey("raw", vk, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("etude-sync"), info: enc.encode("etude-events-v1") }, k, 256);
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function decryptEvent(key, id, ciphertext) {
  const b = b64(ciphertext);
  if (b[0] !== 1) throw new Error("unknown ciphertext version");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(1, 13), additionalData: enc.encode(`etude-event:v1:${id}`) }, key, b.slice(13));
  return JSON.parse(dec.decode(pt));
}
async function encryptEvent(key, id, event) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`etude-event:v1:${id}`) }, key, enc.encode(JSON.stringify(event))));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1; out.set(nonce, 1); out.set(ct, 13);
  return toB64(out);
}

// ---------------------------------------------------------------- registers
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || String(a[2]).localeCompare(String(b[2]));
const CARD_FIELDS = ["/suspended", "/sync_due", "/sync_due_at", "/sync_reset"];
const REVIEW_FIELDS = ["/card_id", "/ts", "/rating", "/score", "/practice", "/attempt_id"];
/** The fields of an event this planner keeps, or null when the event is of no use to it. */
export function keep(ev) {
  const f = ev.fields ?? {};
  const pick = (names) => Object.fromEntries(Object.entries(f).filter(([k]) => names.includes(k)));
  if (ev.table === "items") return ev.key.startsWith(`${ITEM}.oefen.`) || f["/type"] === `${TYPE}-oefen` ? pick(["/type", "/archived", "/fields/teaches"]) : null;
  if (ev.table === "cards") return ev.key.startsWith(`["${ITEM}.`) ? pick(CARD_FIELDS) : null;
  if (ev.table === "reviews") return pick(REVIEW_FIELDS);
  if (ev.table === "attempts") {
    if (!("/grade" in f)) return {};
    let g = f["/grade"];
    try { g = typeof g === "string" ? JSON.parse(g) : g; } catch { g = null; }
    return { "/grade": g && typeof g === "object" ? { score: g.score ?? null, gok: !!g.details?.gok } : null };
  }
  return null;
}
/** Merges an event's kept fields into a stored row ({regs, del}); true when anything changed. */
export function merge(row, ev, fields) {
  let changed = false;
  if (ev.deleted && (!row.del || cmp(ev.stamp, row.del) > 0)) { row.del = ev.stamp; changed = true; }
  for (const [k, v] of Object.entries(fields)) {
    const old = row.regs[k];
    if (!old || cmp(ev.stamp, old[1]) > 0) { row.regs[k] = [v, ev.stamp]; changed = true; }
  }
  return changed;
}
const val = (row, f) => { const v = row?.regs?.[f]?.[0]; return v && typeof v === "object" && v.__etude_sync_deleted__ ? undefined : v; };
const live = (row) => !!row && !row.del;
const itemOfCard = (cardKey) => { try { return JSON.parse(cardKey)[0]; } catch { return null; } };

// ---------------------------------------------------------------- a card's learning state (ts-fsrs 5 learning steps)
// New/learning: Again -> step 0, Hard -> same step, Good -> next step or review, Easy -> review.
// Review: Again -> relearning (when there are relearning steps). Relearning works like learning with its own steps.
const suggest = (score) => (score == null ? null : score >= 0.95 ? 3 : score >= 0.5 ? 2 : 1);
export function learningState(reviews, reset) {
  let state = 0, step = 0; // 0 new, 1 learning, 2 review, 3 relearning
  for (const r of reviews) {
    if (r.practice || (reset && r.ts <= reset)) continue;
    const g = r.rating || suggest(r.score) || 3;
    if (state === 2) { if (g === 1 && RELEARNING_STEPS > 0) { state = 3; step = 0; } continue; }
    const steps = state === 3 ? RELEARNING_STEPS : LEARNING_STEPS;
    if (state === 0) state = 1;
    if (g === 1) step = 0;
    else if (g === 3) { if (step + 1 < steps) step++; else { state = 2; step = 0; } }
    else if (g === 4) { state = 2; step = 0; }
  }
  return state;
}

// ---------------------------------------------------------------- dates
function amsterdamDate(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  // The study day starts at 04:00: before that it is still yesterday's study day.
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  if (+p.hour < DAY_START_HOUR) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/** The instant a study day starts, as `etude card due --date <day>` sets it. */
export function dayStartIso(day) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, DAY_START_HOUR);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    t += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(t).toISOString();
}
const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- storage
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS planner_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS planner_rows (tbl TEXT NOT NULL, key TEXT NOT NULL, ref TEXT, regs TEXT NOT NULL, del TEXT, PRIMARY KEY (tbl, key))",
  "CREATE INDEX IF NOT EXISTS planner_rows_ref ON planner_rows (tbl, ref)",
  "CREATE TABLE IF NOT EXISTS planner_cards (card TEXT PRIMARY KEY, item TEXT NOT NULL, state INTEGER NOT NULL, first_ts TEXT, answered INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS planner_cards_item ON planner_cards (item)",
  "CREATE TABLE IF NOT EXISTS planner_handled (review TEXT PRIMARY KEY, at TEXT NOT NULL)",
];
async function meta(db) {
  const { results } = await db.prepare("SELECT k, v FROM planner_meta").all();
  return Object.fromEntries(results.map((r) => [r.k, JSON.parse(r.v)]));
}
const setMeta = (db, k, v) => db.prepare("INSERT INTO planner_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v));
const rowRef = (tbl, key, regs) => (tbl === "cards" ? itemOfCard(key) : tbl === "reviews" ? regs["/card_id"]?.[0] ?? null : null);
async function loadRows(db, keys) {
  const out = new Map();
  const list = [...keys];
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const stmts = part.map(([tbl, key]) => db.prepare("SELECT tbl, key, regs, del FROM planner_rows WHERE tbl = ? AND key = ?").bind(tbl, key));
    for (const r of await db.batch(stmts)) for (const x of r.results) out.set(`${x.tbl}\u0000${x.key}`, { regs: JSON.parse(x.regs), del: x.del ? JSON.parse(x.del) : null });
  }
  return out;
}

// ---------------------------------------------------------------- one run
export async function run(env, { now = new Date(), batch = BATCH, budget = BUDGET } = {}) {
  configure(env);
  const db = env.DB;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  const m = await meta(db);
  const acct = await db.prepare("SELECT a.id, v.server_vk FROM accounts a JOIN vaults v ON v.account_id = a.id WHERE a.email = ?").bind(env.ACCOUNT_EMAIL).first();
  if (!acct?.server_vk) throw new Error("no account or no server-kept vault key for " + env.ACCOUNT_EMAIL);
  const key = await eventsKey(b64url(acct.server_vk));
  let cursor = m.cursor ?? 0, wall = m.wall ?? 0, counter = m.counter ?? 0, maxRemote = m.maxRemote ?? 0;
  const summary = { at: now.toISOString(), read: 0, kept: 0, released: 0, refreshed: 0, held: 0, misses: 0 };
  // A run that hit the CPU limit never got to clear "inflight": the next one reads half as much.
  if (m.inflight) budget = Math.max(2048, Math.floor(m.inflight / 2));
  else if (m.budget) budget = Math.min(budget, m.budget);
  await setMeta(db, "inflight", budget).run();

  // 1. Ingest new events.
  const { results: evs } = await db.prepare("SELECT seq, id, ciphertext FROM events WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?").bind(acct.id, cursor, batch).all();
  const touched = new Map(); // "tbl\0key" -> {tbl, key}
  const plain = [];
  let bytes = 0;
  for (const e of evs) {
    if (summary.read && bytes + e.ciphertext.length > budget) break;
    bytes += e.ciphertext.length;
    cursor = e.seq;
    summary.read++;
    let ev;
    try { ev = await decryptEvent(key, e.id, e.ciphertext); } catch { continue; }
    if (Array.isArray(ev.stamp) && ev.stamp[0] > maxRemote) maxRemote = ev.stamp[0];
    const fields = keep(ev);
    if (!fields) continue;
    plain.push({ ev, fields });
    touched.set(`${ev.table}\u0000${ev.key}`, [ev.table, ev.key]);
  }
  const rows = await loadRows(db, touched.values());
  const changed = new Set(), cardsToReplay = new Set();
  for (const { ev, fields } of plain) {
    const k = `${ev.table}\u0000${ev.key}`;
    const row = rows.get(k) ?? { regs: {}, del: null };
    rows.set(k, row);
    if (merge(row, ev, fields)) {
      changed.add(k);
      if (ev.table === "reviews") { const c = val(row, "/card_id"); if (c) cardsToReplay.add(c); }
      if (ev.table === "cards" && "/sync_reset" in fields) cardsToReplay.add(ev.key);
    }
  }
  const writes = [];
  for (const k of changed) {
    const [tbl, key2] = k.split("\u0000");
    const row = rows.get(k);
    writes.push(db.prepare("INSERT INTO planner_rows (tbl, key, ref, regs, del) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tbl, key) DO UPDATE SET ref = excluded.ref, regs = excluded.regs, del = excluded.del")
      .bind(tbl, key2, rowRef(tbl, key2, row.regs), JSON.stringify(row.regs), row.del ? JSON.stringify(row.del) : null));
  }
  summary.kept = changed.size;
  if (writes.length) for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));

  // 2. Replay the learning state of cards whose reviews changed.
  if (cardsToReplay.size) {
    const list = [...cardsToReplay];
    const stmts = [];
    for (const card of list) {
      const { results } = await db.prepare("SELECT key, regs, del FROM planner_rows WHERE tbl = 'reviews' AND ref = ?").bind(card).all();
      const cardRow = await db.prepare("SELECT regs FROM planner_rows WHERE tbl = 'cards' AND key = ?").bind(card).first();
      const reset = cardRow ? val({ regs: JSON.parse(cardRow.regs) }, "/sync_reset") : null;
      const reviews = results.filter((r) => !r.del).map((r) => { const g = { regs: JSON.parse(r.regs) }; return { key: r.key, ts: val(g, "/ts"), rating: val(g, "/rating"), score: val(g, "/score"), practice: val(g, "/practice") }; })
        .filter((r) => r.ts).sort((a, b) => a.ts.localeCompare(b.ts) || a.key.localeCompare(b.key));
      const counted = reviews.filter((r) => !r.practice && !(reset && r.ts <= reset));
      stmts.push(db.prepare("INSERT INTO planner_cards (card, item, state, first_ts, answered) VALUES (?, ?, ?, ?, ?) ON CONFLICT(card) DO UPDATE SET state = excluded.state, first_ts = excluded.first_ts, answered = excluded.answered")
        .bind(card, itemOfCard(card) ?? "", learningState(reviews, reset), counted[0]?.ts ?? null, counted.length));
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  }

  const head = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE account_id = ?").bind(acct.id).first();
  const caughtUp = cursor >= head.s;
  const dirty = (m.dirty ?? true) || changed.size > 0;
  let out = { release: [], refresh: [], hold: [], handled: [] };

  // 3. Plan, once the backlog is read and something changed (or once a day).
  const today = amsterdamDate(now);
  // Planning gets a run of its own: one that read nothing new (the next run after any activity, at most 10 minutes later).
  if (caughtUp && summary.read === 0 && (dirty || m.plannedOn !== today)) {
    out = await plan(db, now, today);
    // 4. Write the due-date changes as sync events (what `etude card due` records).
    const stamp = () => {
      const w = Math.max(now.getTime(), wall, maxRemote);
      counter = w === wall ? counter + 1 : 0;
      wall = w;
      return [wall, counter, DEVICE];
    };
    const nowIso = now.toISOString();
    const changes = [
      ...out.release.map(([card, day]) => [card, dayStartIso(day)]),
      ...out.hold.map((card) => [card, dayStartIso(FAR)]),
      ...out.refresh.map((card) => [card, nowIso]),
    ];
    const stmts = [];
    for (const [card, due] of changes) {
      const st = stamp();
      const id = `${DEVICE}:${st[0]}:${st[1]}`;
      const ev = { v: 1, table: "cards", key: card, stamp: st, fields: { "/sync_due": due, "/sync_due_at": nowIso } };
      stmts.push(db.prepare("INSERT OR IGNORE INTO events (account_id, id, device, ciphertext) VALUES (?, ?, ?, ?)").bind(acct.id, id, DEVICE_ROW, await encryptEvent(key, id, ev)));
      // Apply it to the planner's own registers too, so the next plan sees it before the event comes back.
      const k = `cards\u0000${card}`;
      const row = (await loadRows(db, [["cards", card]])).get(k) ?? { regs: {}, del: null };
      merge(row, ev, ev.fields);
      stmts.push(db.prepare("INSERT INTO planner_rows (tbl, key, ref, regs, del) VALUES ('cards', ?, ?, ?, ?) ON CONFLICT(tbl, key) DO UPDATE SET regs = excluded.regs").bind(card, itemOfCard(card), JSON.stringify(row.regs), row.del ? JSON.stringify(row.del) : null));
    }
    for (const r of out.handled) stmts.push(db.prepare("INSERT OR IGNORE INTO planner_handled (review, at) VALUES (?, ?)").bind(r, nowIso));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    summary.released = out.release.length; summary.refreshed = out.refresh.length; summary.held = out.hold.length; summary.misses = out.misses ?? 0;
  }

  await db.batch([
    setMeta(db, "inflight", 0), setMeta(db, "budget", m.inflight ? budget : Math.min(BUDGET, Math.ceil(budget * 1.5))),
    setMeta(db, "cursor", cursor), setMeta(db, "wall", wall), setMeta(db, "counter", counter), setMeta(db, "maxRemote", maxRemote),
    setMeta(db, "dirty", out.plannedNow ? false : dirty),
    ...(out.plannedNow ? [setMeta(db, "plannedOn", today)] : []),
    setMeta(db, "last", { ...summary, cursor, head: head.s, caughtUp, counts: out.counts ?? null }),
    ...(summary.released || summary.refreshed || summary.held ? [setMeta(db, "lastChange", { ...summary, release: out.release, refresh: out.refresh, hold: out.hold, topics: out.topics ?? [] })] : []),
  ]);
  return { ...summary, cursor, head: head.s, caughtUp, counts: out.counts ?? null };
}

/** What to change now. Reads only the planner's own tables, and only the rows that matter (the free plan has little CPU). */
export async function plan(db, now, today) {
  const parse = (r) => ({ regs: JSON.parse(r.regs), del: r.del ? JSON.parse(r.del) : null });
  const all = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
  const [itemRows, qCards, learnedRows, firstRows, answeredRows] = await Promise.all([
    all("SELECT key, regs, del FROM planner_rows WHERE tbl = 'items'"),
    all("SELECT key, ref, regs, del FROM planner_rows WHERE tbl = 'cards' AND ref LIKE ?", `${ITEM}.oefen.%`),
    all("SELECT DISTINCT item FROM planner_cards WHERE state = 2"),
    all("SELECT item, MIN(first_ts) AS first_ts FROM planner_cards WHERE first_ts IS NOT NULL GROUP BY item"),
    all("SELECT card FROM planner_cards WHERE answered > 0 AND item LIKE ?", `${ITEM}.oefen.%`),
  ]);
  const learned = new Set(learnedRows.map((r) => r.item));
  const first = new Map(firstRows.map((r) => [r.item, r.first_ts]));
  const answered = new Set(answeredRows.map((r) => r.card));
  const teaches = new Map();
  for (const r of itemRows) {
    const row = parse(r);
    if (!live(row) || val(row, "/type") !== `${TYPE}-oefen` || val(row, "/archived")) continue;
    const t = val(row, "/fields/teaches");
    teaches.set(r.key, Array.isArray(t) ? t : []);
  }
  const out = { release: [], refresh: [], hold: [], handled: [], misses: 0, plannedNow: true, topics: [], counts: { locked: 0, waiting: 0, released: 0, answered: 0, misses: 0 } };
  for (const r of qCards) {
    const need = teaches.get(r.ref);
    const c = parse(r);
    if (!need || !live(c) || val(c, "/suspended")) continue;
    if (answered.has(r.key)) { out.counts.answered++; continue; }
    const due = val(c, "/sync_due");
    if (need.length && need.every((i) => learned.has(i))) {
      const last = need.map((i) => first.get(i)).filter(Boolean).sort().at(-1);
      const day = last ? addDays(amsterdamDate(new Date(last)), RELEASE_DAYS) : today;
      if (!due || String(due).slice(0, 10) >= FAR) { out.release.push([r.key, day < today ? today : day]); out.counts.released++; }
      else out.counts.waiting++;
    } else {
      out.counts.locked++;
      if (!due) out.hold.push(r.key);
    }
  }
  // Answers to practice questions not handled yet.
  const pending = await all("SELECT r.key, r.ref, r.regs, r.del FROM planner_rows r WHERE r.tbl = 'reviews' AND r.ref LIKE ? AND NOT EXISTS (SELECT 1 FROM planner_handled h WHERE h.review = r.key)", `["${ITEM}.oefen.%`);
  const needItems = new Set();
  for (const p of pending) {
    out.handled.push(p.key);
    const row = parse(p);
    if (!live(row) || val(row, "/practice")) continue;
    const a = val(row, "/attempt_id");
    const g = a ? val((await db.prepare("SELECT regs FROM planner_rows WHERE tbl = 'attempts' AND key = ?").bind(a).first().then((x) => (x ? { regs: JSON.parse(x.regs) } : null))), "/grade") : null;
    const score = val(row, "/score") ?? g?.score ?? null;
    if (score == null || (score >= 0.95 && !g?.gok)) continue;
    out.misses++; out.counts.misses++;
    for (const i of teaches.get(itemOfCard(p.ref)) ?? []) needItems.add(i);
  }
  if (needItems.size) {
    const list = [...needItems];
    out.topics = list;
    const marks = list.map(() => "?").join(",");
    const rows = await all(`SELECT p.card, r.regs, r.del FROM planner_cards p LEFT JOIN planner_rows r ON r.tbl = 'cards' AND r.key = p.card WHERE p.state = 2 AND p.item IN (${marks})`, ...list);
    for (const r of rows) { const c = r.regs ? parse(r) : { regs: {}, del: null }; if (live(c) && !val(c, "/suspended")) out.refresh.push(r.card); }
  }
  return out;
}

/**
 * Starts the planner from a device's merged registers instead of replaying the whole log (seed.mjs):
 * rows and card states in chunks, then `meta` with the cursor those registers cover. Events after the cursor are
 * read as usual; reading one again is harmless (last writer wins).
 */
export async function seed(env, body) {
  configure(env);
  const db = env.DB;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  const stmts = [];
  if (body.reset) for (const t of ["planner_meta", "planner_rows", "planner_cards", "planner_handled"]) stmts.push(db.prepare(`DELETE FROM ${t}`));
  for (const [tbl, key, regs, del] of body.rows ?? [])
    stmts.push(db.prepare("INSERT INTO planner_rows (tbl, key, ref, regs, del) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tbl, key) DO UPDATE SET ref = excluded.ref, regs = excluded.regs, del = excluded.del").bind(tbl, key, rowRef(tbl, key, regs), JSON.stringify(regs), del ? JSON.stringify(del) : null));
  for (const [card, item, state, first, answered] of body.cards ?? [])
    stmts.push(db.prepare("INSERT INTO planner_cards (card, item, state, first_ts, answered) VALUES (?, ?, ?, ?, ?) ON CONFLICT(card) DO UPDATE SET state = excluded.state, first_ts = excluded.first_ts, answered = excluded.answered").bind(card, item, state, first, answered));
  for (const r of body.handled ?? []) stmts.push(db.prepare("INSERT OR IGNORE INTO planner_handled (review, at) VALUES (?, ?)").bind(r, new Date().toISOString()));
  for (const [k, v] of Object.entries(body.meta ?? {})) stmts.push(setMeta(db, k, v));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return { ok: true, rows: body.rows?.length ?? 0, cards: body.cards?.length ?? 0, meta: Object.keys(body.meta ?? {}) };
}

const json = (status, data) => new Response(JSON.stringify(data, null, 1), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const authorized = (env, req) => {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!env.RUN_TOKEN && t.length === env.RUN_TOKEN.length && [...t].every((c, i) => c === env.RUN_TOKEN[i]);
};

export default {
  async fetch(req, env) {
    configure(env);
    const url = new URL(req.url);
    if (!authorized(env, req)) return json(401, { error: "unauthorized" });
    try {
      if (url.pathname === "/run" && req.method === "POST") return json(200, await run(env, { budget: Math.min(256 * 1024, Number(url.searchParams.get("budget")) || BUDGET) }));
      if (url.pathname === "/seed" && req.method === "POST") return json(200, await seed(env, await req.json()));
      if (url.pathname === "/status") {
        await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
        return json(200, await meta(env.DB));
      }
      return json(404, { error: "not_found" });
    } catch (e) {
      return json(500, { error: String(e?.message || e) });
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
