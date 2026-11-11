// dsh-etude runner: one Etude CLI invocation for one person, run under Node 24.
//
// The plugin starts this file per tool call with ETUDE_HOME set to that person's home and the
// job as JSON on fd 3 (never argv or env, so the Access JWT does not show in `ps`):
//
//   { etudeRoot, etudeUrl, jwt|null, argv, expect, stdin, writes, syncMaxAgeSeconds }
//
// It (1) wraps fetch so requests to the Etude origin, and only those, carry the user's DSH
// Access JWT as Cf-Access-Token (Cloudflare Access swaps it for an Etude-scoped JWT with the same
// email: Linked App Token), (2) links the collection to the user's Etude account on first use,
// (3) syncs before and after, and (4) prints one JSON result on stdout.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const MAX_OUTPUT = 200 * 1024

function readJob() {
  return JSON.parse(readFileSync(3, 'utf8'))
}

function clip(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[truncated]` : s
}

function installFetchHook(etudeUrl, jwt, aiGrading) {
  const origin = new URL(etudeUrl).origin
  const original = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== origin) return original(input, init)
    // Without `aiGrading` the agent's device never uses the Worker's AI proxy. Grading settings can
    // arrive through sync from the browser, so the proxy is refused here, not only in settings.
    if (url.pathname.startsWith('/v1/ai/') && !aiGrading) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'ai_off', message: 'AI grading is off for this collection in DSH; grade in the chat and record it with study rate.' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    // Never let a caller-supplied identity header through; only ours.
    for (const name of ['cf-access-token', 'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret']) headers.delete(name)
    if (jwt) headers.set('cf-access-token', jwt)
    // A redirect from Etude's origin is the Access login page: the identity was not accepted.
    return original(input, { ...init, headers, redirect: 'manual' }).then((res) => {
      if (res.status >= 300 && res.status < 400) {
        return new Response(JSON.stringify({ error: { code: 'access_redirect', message: 'Cloudflare Access did not accept the forwarded identity (Linked App Token).' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return res
    })
  }
}

async function main() {
  const job = readJob()
  const { run, parseInvocation } = await import(pathToFileURL(join(job.etudeRoot, 'src', 'cli', 'run.ts')).href)

  // Re-check with Etude's own parser: the plugin's policy resolved `job.expect`.
  let parsed
  try {
    parsed = parseInvocation(job.argv)
  } catch (e) {
    parsed = null
    if (e && e.code !== undefined) {
      // A usage error: let `run` report it in Etude's own words below.
    }
  }
  if (parsed && parsed.cmd.name !== job.expect) {
    return { exitCode: 2, stdout: '', stderr: `dsh-etude: command resolved to "${parsed.cmd.name}", expected "${job.expect}"; refused.\n`, notes: [] }
  }
  if (parsed && parsed.values && parsed.values.db !== undefined) {
    return { exitCode: 2, stdout: '', stderr: 'dsh-etude: --db is not available.\n', notes: [] }
  }

  installFetchHook(job.etudeUrl, job.jwt, job.aiGrading === true)

  const notes = []
  async function etude(argv, stdin = '') {
    let out = ''
    let err = ''
    const io = { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: process.env }
    const code = await run(argv, io)
    return { code, out, err }
  }
  async function etudeJson(argv) {
    const r = await etude([...argv, '--compact'])
    if (r.code !== 0) {
      let message = r.err.trim()
      try {
        message = JSON.parse(message).error ?? message
      } catch {
        // plain text
      }
      throw Object.assign(new Error(`etude ${argv.join(' ')}: ${message}`), { exitCode: r.code })
    }
    return JSON.parse(r.out)
  }

  // AI grading through the Worker's proxy (/v1/ai/chat/completions on the Etude origin). The
  // provider key stays a Worker secret; the forwarded Access identity is what the proxy checks, so
  // the collection only gets a placeholder key. Model and effort are fixed by the Worker.
  async function ensureAiGrading() {
    const want = { kind: 'openai-chat', url: `${job.etudeUrl}/v1/ai/chat/completions`, apiKeyEnv: 'SELFHOST_AI_KEY' }
    const cur = (await etudeJson(['settings', 'get', 'ai'])).value ?? {}
    const ok = cur.feedback?.url === want.url && cur.feedback?.apiKeyEnv === want.apiKeyEnv && cur.decision?.kind === 'llm'
    if (ok) return
    const server = await fetch(`${job.etudeUrl}/v1/server`, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!server?.ai) {
      notes.push('AI grading is on in dsh-etude, but the Etude server offers no AI proxy; grade in the chat instead.')
      return
    }
    const keyRun = await etude(['settings', 'key', 'set', want.apiKeyEnv], 'via-access')
    if (keyRun.code !== 0) throw new Error(`could not set the placeholder AI key: ${keyRun.err.trim()}`)
    const feedback = { ...want, model: server.ai.model || 'server', vision: false, timeoutMs: 90000, temperature: 0.3 }
    await etudeJson(['settings', 'set', `ai.decision=${JSON.stringify({ kind: 'llm' })}`, `ai.feedback=${JSON.stringify(feedback)}`, 'ai.vision=null'])
    notes.push(`AI grading set up through the Etude server (${server.ai.model}, effort ${server.ai.effort}).`)
  }

  let sync = { linked: false, synced: false }
  let status = await etudeJson(['sync', 'status'])
  const linked = () => status.configured && status.signedIn && status.unlocked && status.server === job.etudeUrl
  if (!job.jwt) {
    notes.push(
      linked()
        ? 'Sync skipped: no fresh Cloudflare Access identity. Changes stay on this device until the user opens DSH in the browser.'
        : 'Not linked to Etude yet: open DSH in the browser once, then try again. Working on a local collection.',
    )
  } else {
    try {
      if (!linked()) {
        if (!status.configured || status.server !== job.etudeUrl) status = await etudeJson(['sync', 'setup', '--server', job.etudeUrl])
        if (!status.signedIn) {
          const res = await fetch(`${job.etudeUrl}/v1/auth/access`, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.token) throw new Error(`Etude did not accept the Access identity (${res.status} ${body?.error?.code ?? ''}).`)
          status = await etudeJson(['sync', 'verify', body.token])
          notes.push(`Linked this collection to the Etude account ${body.email}.`)
        }
        if (!status.unlocked) status = (await etudeJson(['sync', 'unlock'])).status ?? (await etudeJson(['sync', 'status']))
      }
      if (job.aiGrading === true) await ensureAiGrading()
      const last = status.lastSync ? Date.parse(status.lastSync) : 0
      if (Date.now() - last > (job.syncMaxAgeSeconds ?? 60) * 1000) status = await etudeJson(['sync', 'now'])
      sync = { linked: true, synced: true }
    } catch (e) {
      sync = { linked: linked(), synced: false, error: String(e?.message || e) }
      notes.push(`Sync before the command failed: ${sync.error} The command ran on the local collection.`)
    }
  }

  const main = await etude(job.argv, job.stdin ?? '')

  if (job.writes && main.code === 0 && job.jwt && sync.linked) {
    try {
      await etudeJson(['sync', 'now'])
      sync.pushed = true
    } catch (e) {
      sync.pushed = false
      notes.push(`The change is saved locally but did not reach Etude yet: ${String(e?.message || e)} It goes up on the next sync.`)
    }
  }
  return { exitCode: main.code, stdout: clip(main.out), stderr: clip(main.err), sync, notes }
}

let result
try {
  result = await main()
} catch (e) {
  result = { exitCode: typeof e?.exitCode === 'number' ? e.exitCode : 1, stdout: '', stderr: `dsh-etude runner: ${String(e?.message || e)}\n`, notes: [] }
}
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0))
