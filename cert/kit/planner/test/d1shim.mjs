// A small D1-compatible wrapper over node:sqlite, for tests and the local backfill.
import { DatabaseSync } from "node:sqlite";

export function d1(path) {
  const db = new DatabaseSync(path);
  const stmt = (sql) => {
    let args = [];
    const s = {
      bind: (...a) => { args = a.map((x) => (x === undefined ? null : x)); return s; },
      all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
      first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
      _exec: () => (/^\s*(select|with)/i.test(sql) ? { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) } : { meta: { changes: Number(db.prepare(sql).run(...args).changes) }, results: [] }),
    };
    return s;
  };
  return {
    raw: db,
    prepare: stmt,
    batch: async (list) => { db.exec("BEGIN"); try { const out = list.map((s) => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
