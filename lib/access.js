// Cloudflare Access JWT verification. Adapted from dsh-mcp/lib/access.js (2026-11-11).
// Differences: a token without an email (a service token) is always refused, the result
// carries `exp`, and an http:// team origin is accepted only with `allowInsecureTeam`
// (tests run a fake Access team on localhost).
//
// Access puts a signed RS256 JWT in the Cf-Access-Jwt-Assertion header of every request it
// lets through. We check the signature against the team's public keys, the issuer, the
// audience (the AUD tag of the Access application), the expiry and an email allowlist.

import { createPublicKey, createVerify } from 'node:crypto'

const CERT_TTL_MS = 60 * 60 * 1000
const SKEW_S = 60

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/** `team.cloudflareaccess.com` or a full origin -> `https://team.cloudflareaccess.com`. */
export function teamOrigin(team, allowInsecureTeam = false) {
  const value = String(team || '').trim().replace(/\/+$/, '')
  if (/^https:\/\//i.test(value)) return value
  if (/^http:\/\//i.test(value)) {
    if (!allowInsecureTeam) throw new Error('an http:// Access team is only allowed in tests')
    return value
  }
  return `https://${value}`
}

export function createAccessVerifier({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  /** origin -> { at, keys: Map<kid, KeyObject> } */
  const certs = new Map()

  async function loadKeys(origin, force) {
    const hit = certs.get(origin)
    if (hit && !force && now() - hit.at < CERT_TTL_MS) return hit.keys
    const res = await fetchImpl(`${origin}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`certs HTTP ${res.status}`)
    const body = await res.json()
    const keys = new Map()
    for (const jwk of body.keys ?? []) {
      if (jwk && jwk.kid && jwk.kty === 'RSA') keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
    }
    certs.set(origin, { at: now(), keys })
    return keys
  }

  /**
   * @param {string|undefined} token - the Cf-Access-Jwt-Assertion header
   * @param {{ teamDomain: string, audiences: string[], emails: string[], allowInsecureTeam?: boolean }} cfg
   * @returns {Promise<{ ok: true, email: string, exp: number } | { ok: false, reason: string }>}
   */
  return async function verify(token, cfg) {
    if (!cfg || !cfg.teamDomain || !Array.isArray(cfg.audiences) || cfg.audiences.length === 0) {
      return { ok: false, reason: 'access not configured' }
    }
    if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, reason: 'no assertion' }
    const [h, p, s] = token.split('.')
    let header, payload
    try {
      header = b64urlJson(h)
      payload = b64urlJson(p)
    } catch {
      return { ok: false, reason: 'malformed assertion' }
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'unsupported alg' }

    let origin
    try {
      origin = teamOrigin(cfg.teamDomain, cfg.allowInsecureTeam === true)
    } catch (e) {
      return { ok: false, reason: e.message }
    }
    let keys
    try {
      keys = await loadKeys(origin, false)
      if (!keys.has(header.kid)) keys = await loadKeys(origin, true)
    } catch (e) {
      return { ok: false, reason: `cannot load Access keys: ${e?.message || e}` }
    }
    const key = keys.get(header.kid)
    if (!key) return { ok: false, reason: 'unknown key' }

    const v = createVerify('RSA-SHA256')
    v.update(`${h}.${p}`)
    if (!v.verify(key, Buffer.from(s, 'base64url'))) return { ok: false, reason: 'bad signature' }

    const t = Math.floor(now() / 1000)
    if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < t) return { ok: false, reason: 'expired' }
    if (typeof payload.nbf === 'number' && payload.nbf - SKEW_S > t) return { ok: false, reason: 'not yet valid' }
    if (payload.iss !== origin) return { ok: false, reason: 'wrong issuer' }
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.some((a) => cfg.audiences.includes(a))) return { ok: false, reason: 'wrong audience' }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!email) return { ok: false, reason: 'no email (service token)' }
    const allow = (cfg.emails ?? []).map((e) => String(e).trim().toLowerCase())
    if (!allow.includes(email)) return { ok: false, reason: 'identity not allowed' }
    return { ok: true, email, exp: payload.exp }
  }
}
