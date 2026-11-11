// Test stand-ins for Cloudflare Access and the Etude Worker, all on 127.0.0.1:
//
//  * team: serves /cdn-cgi/access/certs and signs Access-style RS256 JWTs (`sign`).
//  * edge: Access in front of etude-cloudflare's real worker.js. It lets a request through only
//    with a Linked App Token: `Cf-Access-Token` holding a JWT the team signed for the DSH app's
//    AUD. It then mints a JWT for the Etude app's AUD with the same email and passes it on as
//    Cf-Access-Jwt-Assertion, which is what Cloudflare documents for Linked App Token. Anything
//    else gets the 302 to the login page that real Access answers with.
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createD1 } from './d1.mjs'

export const DSH_AUD = 'dsh-test-aud'
export const ETUDE_AUD = 'etude-test-aud'
export const WORKER_DIR = fileURLToPath(new URL('../../../etude-cloudflare/sync-worker/', import.meta.url))

const b64u = (b) => Buffer.from(b).toString('base64url')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

export async function startTeam() {
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  let origin = ''
  const server = createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ keys: [jwk] }))
    }
    res.writeHead(404)
    res.end()
  })
  origin = await listen(server)

  function sign({ email, aud = DSH_AUD, exp, iss = origin, key = 'good', kid = 'k1' } = {}) {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', kid, typ: 'JWT' }
    const payload = { aud: [aud], iss, iat: now, nbf: now, exp: exp ?? now + 3600, type: 'app', ...(email ? { email } : {}), sub: `s-${email || 'svc'}` }
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`
    const s = createSign('RSA-SHA256')
    s.update(input)
    return `${input}.${b64u(s.sign((key === 'rogue' ? rogue : good).privateKey))}`
  }

  function check(jwt, aud) {
    const parts = String(jwt || '').split('.')
    if (parts.length !== 3) return null
    const v = createVerify('RSA-SHA256')
    v.update(`${parts[0]}.${parts[1]}`)
    if (!v.verify(good.publicKey, Buffer.from(parts[2], 'base64url'))) return null
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (p.iss !== origin || !(Array.isArray(p.aud) ? p.aud : [p.aud]).includes(aud) || p.exp < Date.now() / 1000) return null
    return p
  }

  return { origin, sign, check, close: () => server.close() }
}

export async function startEdge(team, { linkedApps = [DSH_AUD] } = {}) {
  const worker = (await import(pathToFileURL(join(WORKER_DIR, 'src', 'worker.js')).href)).default
  const DB = createD1(join(WORKER_DIR, 'schema.sql'))
  const env = { DB, ACCESS_TEAM_DOMAIN: team.origin, ACCESS_AUD: ETUDE_AUD, ADMIN_TOKEN: 'test-admin' }
  const stats = { linked: 0, refused: 0, ai: 0 }
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/v1/ai/')) stats.ai++
    // Linked App Token: only a JWT for one of the linked apps gets in.
    const forwarded = req.headers['cf-access-token']
    let payload = null
    for (const aud of linkedApps) payload ??= team.check(forwarded, aud)
    if (!payload || !payload.email) {
      stats.refused++
      res.writeHead(302, { location: `${team.origin}/cdn-cgi/access/login` })
      return res.end()
    }
    stats.linked++
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== 'string') continue
      if (k.startsWith('cf-access-')) continue // the client never chooses these
      headers.set(k, v)
    }
    headers.set('cf-access-jwt-assertion', team.sign({ email: payload.email, aud: ETUDE_AUD }))
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body })
    const response = await worker.fetch(request, env, { waitUntil() {} })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  const origin = await listen(server)
  return { origin, DB, stats, close: () => server.close() }
}
