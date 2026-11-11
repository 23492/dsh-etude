// Who the Etude collection belongs to, for one tool call.
//
// DSH has no per-turn user identity: a Peer's principal is only { kind: 'owner' }, and agent
// turns, schedules and subagents carry no request. The human shows up only in the Cloudflare
// Access JWT on browser requests to /api. This store keeps the newest verified JWT per email,
// in memory only (it is a bearer credential for DSH itself), and decides the owner:
//
//   1. exactly one allowed email with a live JWT  -> that email, with the JWT (can sync)
//   2. live JWTs for two or more emails           -> refuse: DSH cannot tell who drives the turn
//   3. no live JWT, exactly one linked collection -> that email, without a JWT (local only)
//   4. otherwise                                  -> refuse: the user must open DSH in the browser

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** A JWT this close to its expiry is not handed out: a sync started now could outlive it. */
const MIN_REMAINING_S = 60

export const userKey = (email) => createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex')

export class IdentityError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

export function createIdentityStore({ usersDir, allowedEmails, now = () => Date.now() }) {
  const allowed = new Set((allowedEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))
  /** email -> { jwt, exp } */
  const live = new Map()

  function remember(email, jwt, exp) {
    if (!allowed.has(email)) return false
    const prev = live.get(email)
    if (prev && prev.exp > exp) return false
    live.set(email, { jwt, exp })
    return true
  }

  function liveEmails() {
    const t = Math.floor(now() / 1000)
    const out = []
    for (const [email, entry] of live) {
      if (entry.exp - MIN_REMAINING_S > t) out.push(email)
      else live.delete(email)
    }
    return out
  }

  function homeFor(email) {
    return join(usersDir, userKey(email))
  }

  /** Emails with a collection on disk (the marker is written when a home is created). */
  function linkedEmails() {
    if (!existsSync(usersDir)) return []
    const out = []
    for (const key of readdirSync(usersDir)) {
      try {
        const { email } = JSON.parse(readFileSync(join(usersDir, key, 'owner.json'), 'utf8'))
        if (typeof email === 'string' && userKey(email) === key && allowed.has(email)) out.push(email)
      } catch {
        // not a home
      }
    }
    return out
  }

  function ensureHome(email) {
    const home = homeFor(email)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const marker = join(home, 'owner.json')
    if (!existsSync(marker)) {
      writeFileSync(`${marker}.tmp`, JSON.stringify({ email }) + '\n', { mode: 0o600 })
      renameSync(`${marker}.tmp`, marker)
    }
    return home
  }

  /**
   * @returns {{ email: string, jwt: string|null, home: string }}
   * @throws {IdentityError}
   */
  function resolveOwner() {
    if (allowed.size === 0) throw new IdentityError('dsh-etude has no allowedEmails configured.', 'not_configured')
    const emails = liveEmails()
    if (emails.length > 1) {
      throw new IdentityError(
        'More than one person is signed in to this DSH through Cloudflare Access, so the Etude tool cannot tell whose collection to use. It works on instances with one owner.',
        'ambiguous_identity',
      )
    }
    if (emails.length === 1) {
      const email = emails[0]
      return { email, jwt: live.get(email).jwt, home: ensureHome(email) }
    }
    const linked = linkedEmails()
    if (linked.length === 1) return { email: linked[0], jwt: null, home: homeFor(linked[0]) }
    throw new IdentityError(
      'No Cloudflare Access identity is known yet. Open DSH in the browser (any page), then try again.',
      'no_identity',
    )
  }

  return { remember, resolveOwner, liveEmails, linkedEmails, homeFor, allowed }
}
