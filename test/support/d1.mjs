// A Cloudflare D1 stand-in over node:sqlite, enough for etude-cloudflare's worker.js:
// prepare().bind().first()/all()/run(), and batch() in one transaction.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

function normalise(v) {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

function rowOut(row) {
  if (!row) return row
  for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = row[k].buffer.slice(row[k].byteOffset, row[k].byteOffset + row[k].byteLength)
  return row
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map(normalise))
  }
  stmt() {
    return this.db.prepare(this.sql)
  }
  async first() {
    return rowOut(this.stmt().get(...this.params)) ?? null
  }
  async all() {
    return { results: this.stmt().all(...this.params).map(rowOut), success: true, meta: {} }
  }
  async run() {
    return this.runSync()
  }
  runSync() {
    const r = this.stmt().run(...this.params)
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }
}

export function createD1(schemaFile) {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(schemaFile, 'utf8'))
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec('BEGIN')
      try {
        const out = stmts.map((s) => s.runSync())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}
