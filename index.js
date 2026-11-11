// dsh-etude: the user's own Etude collection as the agent tool `etude`.
//
// Identity. DSH carries no per-turn user identity, so this plugin reads the Cloudflare Access
// JWT on every browser request to /api (`connection/request` waterfall), verifies it against
// this DSH's Access app (team certs, iss, aud, exp, allowedEmails) and keeps the newest one per
// email in memory. A tool call uses the collection of the one allowed person with a live JWT
// (lib/identity.js). Two different live emails make the tool refuse.
//
// Sync. The runner forwards that JWT to the Etude Worker as `Cf-Access-Token`. With a Linked App
// Token policy on the Etude Access app, Access swaps it for an Etude-scoped JWT with the same
// email, so the Worker's own checks (`/v1/auth/access`, identity-bound device tokens) apply
// unchanged. Each email has its own Etude home under <dataDir>/users/<sha256(email)>.
//
// Safety. Irreversible commands (deletes, resets, prunes) are refused with no approval path; the
// refusal points at the archive equivalent. AI grading settings, sign-in, Sync setup, --db and
// paths into <dataDir> are refused too (lib/policy.js). The runtime (Node 24 + pinned Etude) is downloaded with hash checks
// (lib/runtime.js) in the background on start.

import { join, resolve } from 'node:path'
import { createAccessVerifier } from './lib/access.js'
import { createIdentityStore, IdentityError } from './lib/identity.js'
import { checkInvocation, indexCatalog, PolicyError } from './lib/policy.js'
import { ensureRuntime } from './lib/runtime.js'
import { runJob } from './lib/exec.js'
import { createEtudeSkillProvider } from './lib/skill.js'

export const name = 'dsh-etude'
// Array form: this cordis reads an object `inject` by its keys.
export const inject = ['tools']

const TOOL = 'etude'
const LOG = 'dsh-etude:'

const DESCRIPTION = [
  "Work with the user's own Etude collection (spaced-repetition flashcards): decks, items, cards, study, stats, tags, presets, card types and packs. It is the same collection the user studies in the Etude app; changes sync to it.",
  'Pass the arguments after `etude` as an array: ["deck","list"], ["item","add","--deck","Spanish","--front","el perro","--back","the dog","-t","vocab"], ["stats","weak"], ["study","next","--deck","Spanish"], ["item","list","deck:\\"Networks\\" tag:delay"]. Output is JSON.',
  'Find commands with ["commands"] (full catalog) or ["<group>","--help"] / ["<group>","<verb>","--help"]; do not guess flags. Groups: deck preset item card tag note type scheduler study stats settings theme pack anki media market db sync(status, now).',
  'Model: an item has fields, a type (basic, typed, numeric, mcq, order, match, cloze, free, draw), a deck ("A::B"), tags ("a::b"); each item has one card per face with FSRS state. For more than a few cards write a pack file and run ["pack","import","file.md"] (see ["pack","new"]). Relative paths resolve against the session working directory.',
  'Quizzing in chat: ["study","next","--deck","X"] shows the next due card (private fields stay hidden), ["study","answer",<card>,<answer>] grades it, or ["study","rate",<card>,"good"] for self-graded cards.',
  'Remove things by archiving (["item","archive",...], ["deck","archive",...]); deletes, resets and prunes are refused. Sign-in and Sync setup are handled by the plugin. AI grading is off: grade answers yourself in the chat.',
].join('\n')

function truthy(v) {
  return v === true || v === 'true'
}

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const dataDir = resolve(config.dataDir || '/data/.dsh/dsh-etude')
  const etudeUrl = String(config.etudeUrl || '').replace(/\/+$/, '')
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 120_000
  const syncMaxAgeSeconds = Number(config.syncMaxAgeSeconds) >= 0 ? Number(config.syncMaxAgeSeconds) : 60
  const allowInsecure = truthy(config.allowInsecureForTests)
  const access = {
    teamDomain: config.accessTeamDomain,
    audiences: Array.isArray(config.accessAudiences) ? config.accessAudiences.map(String) : [],
    emails: Array.isArray(config.allowedEmails) ? config.allowedEmails.map(String) : [],
    allowInsecureTeam: allowInsecure,
  }

  const problems = []
  if (!/^https:\/\//.test(etudeUrl) && !(allowInsecure && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(etudeUrl))) problems.push('etudeUrl must be an https:// URL')
  if (!access.teamDomain) problems.push('accessTeamDomain is required')
  if (access.audiences.length === 0) problems.push('accessAudiences needs the AUD tag of this DSH\'s Access app')
  if (access.emails.length === 0) problems.push('allowedEmails needs the owner\'s email')
  if (problems.length) {
    log.warn(`${LOG} not configured (${problems.join('; ')}); the etude tool is not registered`)
    return
  }

  const verify = createAccessVerifier()
  const identity = createIdentityStore({ usersDir: join(dataDir, 'users'), allowedEmails: access.emails })
  /** Last JWT string seen, so a burst of /api requests verifies once. */
  let lastSeen = ''

  ctx.on('connection/request', async (req, _res, next) => {
    const jwt = req?.headers?.['cf-access-jwt-assertion']
    if (typeof jwt === 'string' && jwt !== lastSeen) {
      lastSeen = jwt
      // Not awaited: identity capture must never delay or break a DSH request.
      verify(jwt, access)
        .then((r) => {
          if (r.ok && identity.remember(r.email, jwt, r.exp)) log.debug?.(`${LOG} Access identity refreshed (exp ${new Date(r.exp * 1000).toISOString()})`)
        })
        .catch(() => {})
    }
    return next()
  })

  let runtime = null
  let runtimeError = null
  let installing = null
  function startInstall() {
    installing ??= ensureRuntime({ dataDir, nodePath: config.nodePath, etudeRoot: config.etudeRoot, log })
      .then((r) => {
        runtime = { ...r, index: indexCatalog(r.catalog) }
        runtimeError = null
        log.info(`${LOG} Etude ${r.catalog.version} ready (${r.catalog.commands.length} commands)`)
        return runtime
      })
      .catch((e) => {
        runtimeError = String(e?.message || e)
        installing = null
        log.warn(`${LOG} runtime install failed: ${runtimeError}`)
        throw e
      })
    return installing
  }
  startInstall()
    .then(() => skillControl?.invalidate())
    .catch(() => {})

  // Etude's own skill, from the same pinned runtime. Optional: a profile without a skill
  // registry still gets the tool.
  let skillControl = null
  ctx.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(
      () =>
        skillsCtx.skills.registerProvider((control) => {
          skillControl = control
          return createEtudeSkillProvider({
            getRuntime: async () => {
              const rt = runtime ?? (await startInstall())
              return { etudeRoot: rt.etudeRoot, version: rt.catalog.version }
            },
          })
        }),
      'dsh-etude: skill provider',
    )
  })

  function cwdOf(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd ? cwd : dataDir === '/' ? '/tmp' : resolve(dataDir, '..')
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL,
        description: DESCRIPTION,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['args'],
          properties: {
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments after `etude`, one element per shell token.' },
            stdin: { type: 'string', description: 'Text for an argument given as "-" (a field, a pack, a fields JSON).' },
          },
        },
        timeoutMs: timeoutMs + 10_000,
        output: {
          schema: { type: 'object' },
          render: (_args, v) => {
            const parts = [`exit ${v.exitCode}${v.timedOut ? ' (timed out)' : ''}`]
            if (v.stdout) parts.push(v.stdout.replace(/\n$/, ''))
            if (v.stderr) parts.push(`[stderr]\n${v.stderr.replace(/\n$/, '')}`)
            if (v.notes && v.notes.length) parts.push(`[dsh-etude]\n${v.notes.join('\n')}`)
            return [{ type: 'text', text: parts.join('\n') }]
          },
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.()
          const fail = (message) => ({ exitCode: 2, stdout: '', stderr: message, notes: [] })
          let rt = runtime
          if (!rt) {
            try {
              rt = await Promise.race([startInstall(), new Promise((_, reject) => setTimeout(() => reject(new Error('still installing')), 90_000))])
            } catch (e) {
              return fail(`Etude is not ready: ${runtimeError || e.message}. Try again in a minute.`)
            }
          }
          const argv = Array.isArray(args.args) ? args.args.map(String) : []
          const cwd = cwdOf(exec)
          let checked
          try {
            checked = checkInvocation(rt.index, argv, { cwd, dataDir })
          } catch (e) {
            if (e instanceof PolicyError) return fail(e.message)
            throw e
          }
          let owner
          try {
            owner = identity.resolveOwner()
          } catch (e) {
            if (e instanceof IdentityError) return fail(e.message)
            throw e
          }
          const finalArgv = checked.argv
          const result = await runJob({
            nodePath: rt.nodePath,
            home: owner.home,
            cwd,
            timeoutMs,
            signal: exec?.signal,
            job: {
              etudeRoot: rt.etudeRoot,
              etudeUrl,
              jwt: owner.jwt,
              argv: finalArgv,
              expect: checked.cmd.name,
              stdin: typeof args.stdin === 'string' ? args.stdin : '',
              writes: checked.writes,
              syncMaxAgeSeconds,
            },
          })
          return JSON.parse(JSON.stringify({ ...result, notes: result.notes || [] }))
        },
      }),
    'dsh-etude: tool',
  )

  log.info(`${LOG} tool "${TOOL}" registered for ${access.emails.length} allowed email(s), Etude at ${etudeUrl}, data in ${dataDir}`)
}
