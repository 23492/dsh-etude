// Certification planner: releases practice questions and follows up misses in every certification deck of every
// account on a self-hosted Etude Sync server (etude-cloudflare), inside the Sync Worker's own cron.
// See ../../../references/planner.md for the rules and design/evidence in ../../../references/design.md.
//
// For each account whose server keeps the vault key (Sync without a password) it reads the account's sync events
// from D1, decrypts them, and writes due-date changes back as ordinary encrypted sync events from its own device id,
// the same ones `etude card due` makes. Every device picks them up at its next sync. It never rates a card.
//
// Nothing is configured per deck. A practice question is any item with a private `teaches` field (a list of concept
// item ids; the etude-cert pack builder writes it). Settings come from the collection itself:
//   - learning and relearning steps: the deck's preset and deck overrides (`learningSteps`, `relearningSteps`),
//     resolved like Etude does (root deck first, preset then the deck's own config), else Etude's defaults (2 and 1);
//   - days between "concepts learned" and release: `schedulerOptions.releaseDays` on the deck or preset, else the
//     `releaseDays` option default of the practice question's scheduler, else 3;
//   - the study day starts at the collection's `dayStartHour` (default 4) in PLANNER_TZ (default Europe/Amsterdam;
//     Etude does not sync the device time zone).
//
// Rules:
// 1. A practice question waits on a far due date until every concept item in its `teaches` field has a card in
//    review. It then becomes due releaseDays after the last of those items was first studied (not before today).
// 2. A practice question answered wrong, or right after the guess button, brings the concept cards that teach it
//    (those in review) back now. Each answer is handled once; answers older than two days when first seen (a
//    collection the planner meets for the first time) are only marked as handled.
// 3. Everything else (mock exams, other decks) is never touched.
//
// CPU: the free plan allows 10 ms per invocation. One invocation works on one account: it decrypts at most BUDGET
// bytes of new events, or it plans (only in a run that read nothing new). The account that waited longest goes
// first. A run killed by the CPU limit leaves `inflight` set and the next run on that account reads half as much.

const BATCH = 200;
const BUDGET = 24 * 1024;
const MAX_BUDGET = 64 * 1024; // grows towards this while runs finish; a run killed by the CPU limit halves it
const FAR = "2027-12-31";
const DEVICE = "e7a1d0c4b9f2483a9c6e5d10f00dbeef"; // stamp tie-breaker for the planner's own events
const DEVICE_ROW = "dev_planner";
const STALE_MS = 2 * 86400e3;
const DEFAULTS = { learningSteps: 2, relearningSteps: 1, releaseDays: 3, dayStartHour: 4 };

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- crypto (Etude Sync v1, crypto.ts)
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const toB64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
export async function eventsKey(vk) {
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

// ---------------------------------------------------------------- registers (last writer wins per field, as Etude)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || String(a[2]).localeCompare(String(b[2]));
const CARD_FIELDS = ["/suspended", "/sync_due", "/sync_due_at", "/sync_reset"];
const REVIEW_FIELDS = ["/card_id", "/ts", "/rating", "/score", "/practice", "/attempt_id"];
const CFG = ["learningSteps", "relearningSteps", "schedulerOptions/releaseDays"];
const CFG_FIELDS = ["/config", ...CFG.map((k) => `/config/${k}`)];
/** The fields of an event the planner keeps, or null when the event is of no use to it. */
export function keep(ev) {
  const f = ev.fields ?? {};
  const pick = (names) => {
    const o = {};
    for (const [k, v] of Object.entries(f)) if (names.includes(k)) o[k] = v;
    return Object.keys(o).length || ev.deleted ? o : null;
  };
  switch (ev.table) {
    case "items": return pick(["/type", "/archived", "/deck_id", "/fields/teaches"]);
    case "cards": return pick(CARD_FIELDS);
    case "reviews": return pick(REVIEW_FIELDS);
    case "attempts": {
      if (!("/grade" in f)) return ev.deleted ? {} : null;
      let g = f["/grade"];
      try { g = typeof g === "string" ? JSON.parse(g) : g; } catch { g = null; }
      return { "/grade": g && typeof g === "object" ? { score: g.score ?? null, gok: !!g.details?.gok } : null };
    }
    case "decks": return pick(["/name", "/preset_id", ...CFG_FIELDS]);
    case "presets": return pick(CFG_FIELDS);
    case "types": return pick(["/def/scheduler"]);
    case "schedulers": return pick(["/def/options"]);
    case "settings": return ev.key === "settings" ? pick(["/value/dayStartHour"]) : null;
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
const gone = (v) => v && typeof v === "object" && v.__etude_sync_deleted__;
const val = (row, f) => { const v = row?.regs?.[f]?.[0]; return gone(v) ? undefined : v; };
const live = (row) => !!row && !row.del;
const itemOfCard = (cardKey) => { try { return JSON.parse(cardKey)[0]; } catch { return null; } };
const rowRef = (tbl, key, regs) => (tbl === "cards" ? itemOfCard(key) : tbl === "reviews" ? regs["/card_id"]?.[0] ?? null : null);
const parseRow = (r) => ({ regs: JSON.parse(r.regs), del: r.del ? JSON.parse(r.del) : null });
const hasTeaches = (row) => live(row) && Array.isArray(val(row, "/fields/teaches")) && !val(row, "/archived");

// ---------------------------------------------------------------- a card's learning state (ts-fsrs learning steps)
// New/learning: Again -> step 0, Hard -> same step, Good -> next step or review, Easy -> review.
// Review: Again -> relearning (when there are relearning steps). Relearning works like learning with its own steps.
const suggest = (score) => (score == null ? null : score >= 0.95 ? 3 : score >= 0.5 ? 2 : 1);
export function learningState(reviews, reset, learningSteps = DEFAULTS.learningSteps, relearningSteps = DEFAULTS.relearningSteps) {
  let state = 0, step = 0; // 0 new, 1 learning, 2 review, 3 relearning
  for (const r of reviews) {
    if (r.practice || (reset && r.ts <= reset)) continue;
    const g = r.rating || suggest(r.score) || 3;
    if (state === 2) { if (g === 1 && relearningSteps > 0) { state = 3; step = 0; } continue; }
    const steps = state === 3 ? relearningSteps : learningSteps;
    if (state === 0) state = 1;
    if (g === 1) step = 0;
    else if (g === 3) { if (step + 1 < steps) step++; else { state = 2; step = 0; } }
    else if (g === 4) { state = 2; step = 0; }
  }
  return state;
}

// ---------------------------------------------------------------- dates (study days start at dayStartHour in tz)
export function studyDay(at, tz = "Europe/Amsterdam", hour = DEFAULTS.dayStartHour) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  if (+p.hour < hour) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/** The instant a study day starts, as `etude card due --date <day>` sets it. */
export function dayStartIso(day, tz = "Europe/Amsterdam", hour = DEFAULTS.dayStartHour) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hour);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    t += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(t).toISOString();
}
const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- the collection's settings
/** Decks, presets, types, schedulers and settings of one account, from the planner's registers. */
async function loadContext(db, acct) {
  const { results } = await db.prepare("SELECT tbl, key, regs, del FROM plan_rows WHERE account_id = ? AND tbl IN ('decks','presets','types','schedulers','settings')").bind(acct).all();
  const ctx = { decks: new Map(), byName: new Map(), presets: new Map(), types: new Map(), schedulers: new Map(), dayStartHour: DEFAULTS.dayStartHour, cache: new Map() };
  for (const r of results) {
    const row = parseRow(r);
    if (!live(row)) continue;
    if (r.tbl === "decks") { ctx.decks.set(r.key, row); const n = val(row, "/name"); if (typeof n === "string") ctx.byName.set(n, row); }
    else if (r.tbl === "settings") { const h = Number(val(row, "/value/dayStartHour")); if (Number.isInteger(h) && h >= 0 && h < 24) ctx.dayStartHour = h; }
    else ctx[r.tbl].set(r.key, row);
  }
  return ctx;
}
/** A config value of a deck or preset row, unless a later write replaced the whole config with {}. */
function cfgVal(row, key) {
  const r = row?.regs?.[`/config/${key}`];
  if (!r || gone(r[0])) return undefined;
  const whole = row.regs["/config"];
  if (whole && whole[0] && typeof whole[0] === "object" && !Array.isArray(whole[0]) && !Object.keys(whole[0]).length && cmp(whole[1], r[1]) > 0) return undefined;
  return r[0];
}
/** Learning steps and releaseDays of a deck: Etude's layers, root deck first, preset then the deck's own config. */
export function deckSettings(ctx, deckId) {
  if (ctx.cache.has(deckId)) return ctx.cache.get(deckId);
  const name = val(ctx.decks.get(deckId), "/name");
  const out = {};
  if (typeof name === "string") {
    const parts = name.split("::");
    for (let i = 1; i <= parts.length; i++) {
      const deck = ctx.byName.get(parts.slice(0, i).join("::"));
      if (!deck) continue;
      const pid = val(deck, "/preset_id");
      for (const layer of [pid ? ctx.presets.get(pid) : null, deck]) {
        if (!layer) continue;
        for (const k of CFG) { const v = cfgVal(layer, k); if (v !== undefined) out[k] = v; }
      }
    }
  }
  const rd = out["schedulerOptions/releaseDays"];
  const res = {
    learningSteps: Array.isArray(out.learningSteps) ? out.learningSteps.length : DEFAULTS.learningSteps,
    relearningSteps: Array.isArray(out.relearningSteps) ? out.relearningSteps.length : DEFAULTS.relearningSteps,
    releaseDays: rd != null && Number.isFinite(Number(rd)) ? Number(rd) : null,
  };
  ctx.cache.set(deckId, res);
  return res;
}
function releaseDaysFor(ctx, item) {
  const own = deckSettings(ctx, val(item, "/deck_id")).releaseDays;
  if (own != null) return own;
  const sid = val(ctx.types.get(val(item, "/type")), "/def/scheduler");
  const opts = sid ? val(ctx.schedulers.get(sid), "/def/options") : null;
  const o = Array.isArray(opts) ? opts.find((x) => x && x.name === "releaseDays") : null;
  return o && o.default != null && Number.isFinite(Number(o.default)) ? Number(o.default) : DEFAULTS.releaseDays;
}

// ---------------------------------------------------------------- storage
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS plan_meta (account_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (account_id, k))",
  "CREATE TABLE IF NOT EXISTS plan_rows (account_id TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, ref TEXT, regs TEXT NOT NULL, del TEXT, PRIMARY KEY (account_id, tbl, key))",
  "CREATE INDEX IF NOT EXISTS plan_rows_ref ON plan_rows (account_id, tbl, ref)",
  "CREATE TABLE IF NOT EXISTS plan_cards (account_id TEXT NOT NULL, card TEXT NOT NULL, item TEXT NOT NULL, state INTEGER NOT NULL, first_ts TEXT, answered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, card))",
  "CREATE INDEX IF NOT EXISTS plan_cards_item ON plan_cards (account_id, item)",
  "CREATE TABLE IF NOT EXISTS plan_handled (account_id TEXT NOT NULL, review TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (account_id, review))",
];
const UPSERT_ROW = "INSERT INTO plan_rows (account_id, tbl, key, ref, regs, del) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, tbl, key) DO UPDATE SET ref = excluded.ref, regs = excluded.regs, del = excluded.del";
const UPSERT_CARD = "INSERT INTO plan_cards (account_id, card, item, state, first_ts, answered) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, card) DO UPDATE SET state = excluded.state, first_ts = excluded.first_ts, answered = excluded.answered";
const setState = (db, acct, st) => db.prepare("INSERT INTO plan_meta (account_id, k, v) VALUES (?, 'state', ?) ON CONFLICT(account_id, k) DO UPDATE SET v = excluded.v").bind(acct, JSON.stringify(st));
async function chunked(db, stmts, n = 50) { for (let i = 0; i < stmts.length; i += n) await db.batch(stmts.slice(i, i + n)); }
async function loadRows(db, acct, keys) {
  const out = new Map();
  const list = [...keys];
  for (let i = 0; i < list.length; i += 50) {
    const stmts = list.slice(i, i + 50).map(([tbl, key]) => db.prepare("SELECT tbl, key, regs, del FROM plan_rows WHERE account_id = ? AND tbl = ? AND key = ?").bind(acct, tbl, key));
    for (const r of await db.batch(stmts)) for (const x of r.results) out.set(`${x.tbl}\u0000${x.key}`, parseRow(x));
  }
  return out;
}

// ---------------------------------------------------------------- one cron run: one account
/** Picks the account that waited longest among those with unread events or a plan due, and works on it. */
export async function runPlanner(env, { now = new Date(), budget = BUDGET, account = null } = {}) {
  const db = env.DB;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  const tz = env.PLANNER_TZ || "Europe/Amsterdam";
  const { results } = await db.prepare(
    `SELECT a.id, a.email, v.server_vk AS vk, (SELECT MAX(seq) FROM events e WHERE e.account_id = a.id) AS head,
       (SELECT m.v FROM plan_meta m WHERE m.account_id = a.id AND m.k = 'state') AS st
     FROM accounts a JOIN vaults v ON v.account_id = a.id
     WHERE v.server_vk IS NOT NULL AND v.server_vk <> '' AND a.email NOT IN (SELECT email FROM blocked)`,
  ).all();
  const list = results.map((a) => ({ ...a, head: a.head ?? 0, st: a.st ? JSON.parse(a.st) : {} }));
  const ready = list.filter((a) => (account ? a.id === account || a.email === account : true)).filter((a) => {
    const behind = (a.st.cursor ?? 0) < a.head;
    const planDue = (a.st.dirty ?? true) || a.st.plannedOn !== studyDay(now, tz, a.st.dayStartHour ?? DEFAULTS.dayStartHour);
    return behind || planDue || account;
  });
  if (!ready.length) return { idle: true, accounts: list.length };
  ready.sort((x, y) => String(x.st.at ?? "").localeCompare(String(y.st.at ?? "")));
  return { account: ready[0].id, ...(await runAccount(db, ready[0], { now, tz, budget })) };
}

async function runAccount(db, a, { now, tz, budget }) {
  const acct = a.id;
  const st = { cursor: 0, wall: 0, counter: 0, maxRemote: 0, dirty: true, dayStartHour: DEFAULTS.dayStartHour, ...a.st };
  if (st.inflight) budget = Math.max(2048, Math.floor(st.inflight / 2));
  else if (st.budget) budget = Math.min(budget, st.budget);
  await setState(db, acct, { ...st, inflight: budget, at: now.toISOString() }).run();
  const key = await eventsKey(b64url(a.vk));
  const summary = { at: now.toISOString(), read: 0, kept: 0, released: 0, refreshed: 0, held: 0, misses: 0 };

  // 1. Ingest new events.
  const { results: evs } = await db.prepare("SELECT seq, id, ciphertext FROM events WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?").bind(acct, st.cursor, BATCH).all();
  const touched = new Map();
  const plain = [];
  let bytes = 0;
  for (const e of evs) {
    if (summary.read && bytes + e.ciphertext.length > budget) break;
    bytes += e.ciphertext.length;
    st.cursor = e.seq;
    summary.read++;
    if (e.id.startsWith(DEVICE + ":")) continue; // our own due-date events are already in the registers
    let ev;
    try { ev = await decryptEvent(key, e.id, e.ciphertext); } catch { continue; }
    if (Array.isArray(ev.stamp) && ev.stamp[0] > st.maxRemote) st.maxRemote = ev.stamp[0];
    const fields = keep(ev);
    if (!fields) continue;
    plain.push({ ev, fields });
    touched.set(`${ev.table}\u0000${ev.key}`, [ev.table, ev.key]);
  }
  const rows = await loadRows(db, acct, touched.values());
  const changed = new Set(), replay = new Set();
  for (const { ev, fields } of plain) {
    const k = `${ev.table}\u0000${ev.key}`;
    const row = rows.get(k) ?? { regs: {}, del: null };
    rows.set(k, row);
    if (merge(row, ev, fields)) {
      changed.add(k);
      if (ev.table === "reviews") { const c = val(row, "/card_id"); if (c) replay.add(c); }
      if (ev.table === "cards" && "/sync_reset" in fields) replay.add(ev.key);
    }
  }
  await chunked(db, [...changed].map((k) => {
    const [tbl, k2] = k.split("\u0000");
    const row = rows.get(k);
    return db.prepare(UPSERT_ROW).bind(acct, tbl, k2, rowRef(tbl, k2, row.regs), JSON.stringify(row.regs), row.del ? JSON.stringify(row.del) : null);
  }));
  summary.kept = changed.size;

  // 2. Replay the learning state of cards whose reviews changed, with their own deck's learning steps.
  if (replay.size) {
    const ctx = await loadContext(db, acct);
    st.dayStartHour = ctx.dayStartHour;
    const cards = [...replay];
    const items = await loadRows(db, acct, cards.map((c) => ["items", itemOfCard(c) ?? ""]));
    const stmts = [];
    for (const card of cards) {
      const { results: rs } = await db.prepare("SELECT key, regs, del FROM plan_rows WHERE account_id = ? AND tbl = 'reviews' AND ref = ?").bind(acct, card).all();
      const cardRow = await db.prepare("SELECT regs FROM plan_rows WHERE account_id = ? AND tbl = 'cards' AND key = ?").bind(acct, card).first();
      const reset = cardRow ? val({ regs: JSON.parse(cardRow.regs) }, "/sync_reset") : null;
      const reviews = rs.filter((r) => !r.del).map((r) => { const g = { regs: JSON.parse(r.regs) }; return { key: r.key, ts: val(g, "/ts"), rating: val(g, "/rating"), score: val(g, "/score"), practice: val(g, "/practice") }; })
        .filter((r) => r.ts).sort((x, y) => x.ts.localeCompare(y.ts) || x.key.localeCompare(y.key));
      const counted = reviews.filter((r) => !r.practice && !(reset && r.ts <= reset));
      const s = deckSettings(ctx, val(items.get(`items\u0000${itemOfCard(card)}`), "/deck_id"));
      stmts.push(db.prepare(UPSERT_CARD).bind(acct, card, itemOfCard(card) ?? "", learningState(reviews, reset, s.learningSteps, s.relearningSteps), counted[0]?.ts ?? null, counted.length));
    }
    await chunked(db, stmts);
  }

  const caughtUp = st.cursor >= a.head;
  st.dirty = st.dirty || changed.size > 0;
  let out = { release: [], refresh: [], hold: [], handled: [] };

  // 3. Plan, in a run of its own: one that read nothing new, when something changed or once a study day.
  if (caughtUp && summary.read === 0) {
    const ctx = await loadContext(db, acct);
    st.dayStartHour = ctx.dayStartHour;
    const today = studyDay(now, tz, ctx.dayStartHour);
    if (st.dirty || st.plannedOn !== today) {
      out = await plan(db, acct, now, today, ctx, tz);
      // 4. Write the due-date changes as sync events (what `etude card due` records).
      const stamp = () => {
        const w = Math.max(now.getTime(), st.wall, st.maxRemote);
        st.counter = w === st.wall ? st.counter + 1 : 0;
        st.wall = w;
        return [st.wall, st.counter, DEVICE];
      };
      const nowIso = now.toISOString();
      const changes = [
        ...out.release.map(([card, day]) => [card, dayStartIso(day, tz, ctx.dayStartHour)]),
        ...out.hold.map((card) => [card, dayStartIso(FAR, tz, ctx.dayStartHour)]),
        ...out.refresh.map((card) => [card, nowIso]),
      ];
      const own = await loadRows(db, acct, changes.map(([card]) => ["cards", card]));
      const stmts = [];
      for (const [card, due] of changes) {
        const s2 = stamp();
        const id = `${DEVICE}:${s2[0]}:${s2[1]}`;
        const ev = { v: 1, table: "cards", key: card, stamp: s2, fields: { "/sync_due": due, "/sync_due_at": nowIso } };
        stmts.push(db.prepare("INSERT OR IGNORE INTO events (account_id, id, device, ciphertext) VALUES (?, ?, ?, ?)").bind(acct, id, DEVICE_ROW, await encryptEvent(key, id, ev)));
        // Apply it to the planner's own registers too, so the next plan sees it at once.
        const k = `cards\u0000${card}`;
        const row = own.get(k) ?? { regs: {}, del: null };
        own.set(k, row);
        merge(row, ev, ev.fields);
        stmts.push(db.prepare(UPSERT_ROW).bind(acct, "cards", card, itemOfCard(card), JSON.stringify(row.regs), row.del ? JSON.stringify(row.del) : null));
      }
      for (const r of out.handled) stmts.push(db.prepare("INSERT OR IGNORE INTO plan_handled (account_id, review, at) VALUES (?, ?, ?)").bind(acct, r, nowIso));
      await chunked(db, stmts);
      Object.assign(summary, { released: out.release.length, refreshed: out.refresh.length, held: out.hold.length, misses: out.misses });
      st.dirty = false;
      st.plannedOn = today;
    }
  }
  st.inflight = 0;
  st.budget = a.st.inflight ? budget : Math.min(MAX_BUDGET, Math.ceil(budget * 1.5));
  st.last = { ...summary, cursor: st.cursor, head: a.head, caughtUp, counts: out.counts ?? null };
  if (summary.released || summary.refreshed || summary.held) st.lastChange = { ...summary, release: out.release.slice(0, 50), refresh: out.refresh.slice(0, 50), hold: out.hold.length };
  // The head may have moved while we ran; the next run reads on from the cursor.
  st.at = now.toISOString();
  await setState(db, acct, st).run();
  return st.last;
}

/** What to change now, for one account. Reads only the planner's own tables. */
export async function plan(db, acct, now, today, ctx, tz = "Europe/Amsterdam") {
  const all = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
  const PRACTICE = "i.account_id = ? AND i.tbl = 'items' AND i.regs LIKE '%\"/fields/teaches\"%'";
  const [itemRows, qCards, learnedRows, firstRows, answeredRows] = await Promise.all([
    all("SELECT i.key, i.regs, i.del FROM plan_rows i WHERE " + PRACTICE, acct),
    all("SELECT c.key, c.ref, c.regs, c.del FROM plan_rows c JOIN plan_rows i ON i.key = c.ref WHERE c.account_id = ? AND c.tbl = 'cards' AND " + PRACTICE, acct, acct),
    all("SELECT DISTINCT item FROM plan_cards WHERE account_id = ? AND state = 2", acct),
    all("SELECT item, MIN(first_ts) AS first_ts FROM plan_cards WHERE account_id = ? AND first_ts IS NOT NULL GROUP BY item", acct),
    all("SELECT p.card FROM plan_cards p JOIN plan_rows i ON i.key = p.item WHERE p.account_id = ? AND p.answered > 0 AND " + PRACTICE, acct, acct),
  ]);
  const learned = new Set(learnedRows.map((r) => r.item));
  const first = new Map(firstRows.map((r) => [r.item, r.first_ts]));
  const answered = new Set(answeredRows.map((r) => r.card));
  const practice = new Map();
  for (const r of itemRows) {
    const row = parseRow(r);
    if (hasTeaches(row)) practice.set(r.key, { teaches: val(row, "/fields/teaches"), releaseDays: releaseDaysFor(ctx, row) });
  }
  const out = { release: [], refresh: [], hold: [], handled: [], misses: 0, counts: { decks: 0, locked: 0, waiting: 0, released: 0, answered: 0, misses: 0 } };
  out.counts.decks = new Set([...itemRows].map((r) => val(parseRow(r), "/deck_id"))).size;
  for (const r of qCards) {
    const q = practice.get(r.ref);
    const c = parseRow(r);
    if (!q || !live(c) || val(c, "/suspended")) continue;
    if (answered.has(r.key)) { out.counts.answered++; continue; }
    const due = val(c, "/sync_due");
    const need = q.teaches;
    if (need.length && need.every((i) => learned.has(i))) {
      const last = need.map((i) => first.get(i)).filter(Boolean).sort().at(-1);
      const day = last ? addDays(studyDay(new Date(last), tz, ctx.dayStartHour), q.releaseDays) : today;
      if (!due || String(due).slice(0, 10) >= FAR) { out.release.push([r.key, day < today ? today : day]); out.counts.released++; }
      else out.counts.waiting++;
    } else {
      out.counts.locked++;
      if (!due) out.hold.push(r.key);
    }
  }
  // Answers to practice questions not handled yet.
  const pending = await all(
    "SELECT r.key, r.ref, r.regs, r.del FROM plan_rows r JOIN plan_rows i ON i.key = json_extract(r.ref, '$[0]') WHERE r.account_id = ? AND r.tbl = 'reviews' AND " + PRACTICE +
      " AND NOT EXISTS (SELECT 1 FROM plan_handled h WHERE h.account_id = r.account_id AND h.review = r.key)",
    acct, acct,
  );
  const need = new Set();
  for (const p of pending) {
    out.handled.push(p.key);
    const row = parseRow(p);
    if (!live(row) || val(row, "/practice")) continue;
    const ts = val(row, "/ts");
    if (!ts || now.getTime() - Date.parse(ts) > STALE_MS) continue; // an old answer, from before the planner knew this collection
    const aid = val(row, "/attempt_id");
    const at = aid ? await db.prepare("SELECT regs FROM plan_rows WHERE account_id = ? AND tbl = 'attempts' AND key = ?").bind(acct, aid).first() : null;
    const g = at ? val({ regs: JSON.parse(at.regs) }, "/grade") : null;
    const score = val(row, "/score") ?? g?.score ?? null;
    if (score == null || (score >= 0.95 && !g?.gok)) continue;
    out.misses++; out.counts.misses++;
    for (const i of practice.get(itemOfCard(p.ref))?.teaches ?? []) need.add(i);
  }
  if (need.size) {
    const list = [...need];
    for (let i = 0; i < list.length; i += 80) {
      const part = list.slice(i, i + 80);
      const rows = await all(`SELECT p.card, r.regs, r.del FROM plan_cards p LEFT JOIN plan_rows r ON r.account_id = p.account_id AND r.tbl = 'cards' AND r.key = p.card WHERE p.account_id = ? AND p.state = 2 AND p.item IN (${part.map(() => "?").join(",")})`, acct, ...part);
      for (const r of rows) { const c = r.regs ? parseRow(r) : { regs: {}, del: null }; if (live(c) && !val(c, "/suspended")) out.refresh.push(r.card); }
    }
  }
  return out;
}

/**
 * Starts an account from a device's merged registers instead of replaying its whole log (seed.mjs): rows and card
 * states in chunks, then `state` with the cursor those registers cover. Reading an event again later is harmless.
 */
export async function seedAccount(env, acct, body) {
  const db = env.DB;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  const stmts = [];
  if (body.reset) for (const t of ["plan_meta", "plan_rows", "plan_cards", "plan_handled"]) stmts.push(db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).bind(acct));
  for (const [tbl, key, regs, del] of body.rows ?? []) stmts.push(db.prepare(UPSERT_ROW).bind(acct, tbl, key, rowRef(tbl, key, regs), JSON.stringify(regs), del ? JSON.stringify(del) : null));
  for (const [card, item, state, firstTs, answered] of body.cards ?? []) stmts.push(db.prepare(UPSERT_CARD).bind(acct, card, item, state, firstTs, answered));
  for (const r of body.handled ?? []) stmts.push(db.prepare("INSERT OR IGNORE INTO plan_handled (account_id, review, at) VALUES (?, ?, ?)").bind(acct, r, new Date().toISOString()));
  if (body.state) stmts.push(setState(db, acct, body.state));
  await chunked(db, stmts, 100);
  return { ok: true, rows: body.rows?.length ?? 0, cards: body.cards?.length ?? 0 };
}

/** Every account's planner state, for the operator. */
export async function plannerStatus(env) {
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const { results } = await env.DB.prepare("SELECT a.email, m.v FROM plan_meta m JOIN accounts a ON a.id = m.account_id WHERE m.k = 'state'").all();
  return results.map((r) => ({ email: r.email, ...JSON.parse(r.v) }));
}
