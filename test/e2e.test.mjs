// End to end: the plugin (driven like DSH drives it) -> runner on Node 24 -> Etude CLI ->
// fake Access edge (Linked App Token) -> etude-cloudflare's real worker.js on a node:sqlite D1.
//
// Needs a Node 24 binary and an Etude checkout with its CLI dependencies:
//   ETUDE_TEST_NODE=/path/to/node24 ETUDE_TEST_ROOT=/path/to/etude node --test test/
// Without them this file is skipped.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as plugin from '../index.js'
import { userKey } from '../lib/identity.js'
import { startTeam, startEdge, DSH_AUD } from './support/edge.mjs'
import { createFakeCtx } from './support/fake-ctx.mjs'

const run = promisify(execFile)
const NODE = process.env.ETUDE_TEST_NODE
const ROOT = process.env.ETUDE_TEST_ROOT
const skip = !NODE || !ROOT || !existsSync(NODE) || !existsSync(join(ROOT, 'src', 'cli', 'run.ts')) ? 'set ETUDE_TEST_NODE and ETUDE_TEST_ROOT' : false

let team, edge, tmp
before(async () => {
  if (skip) return
  team = await startTeam()
  edge = await startEdge(team)
  tmp = mkdtempSync(join(tmpdir(), 'dsh-etude-e2e-'))
})
after(() => {
  team?.close()
  edge?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** One DSH instance with dsh-etude for `owner`. */
async function instance(name, allowedEmails) {
  const fake = createFakeCtx()
  const dataDir = join(tmp, name, 'data')
  plugin.apply(fake.ctx, {
    etudeUrl: edge.origin,
    accessTeamDomain: team.origin,
    accessAudiences: [DSH_AUD],
    allowedEmails,
    dataDir,
    nodePath: NODE,
    etudeRoot: ROOT,
    syncMaxAgeSeconds: 0,
    allowInsecureForTests: true,
  })
  const ws = join(tmp, name, 'ws')
  await run('mkdir', ['-p', ws])
  const call = (args, opts = {}) => fake.callTool(args, { cwd: ws, ...opts })
  return { ...fake, dataDir, ws, call }
}

const json = (r) => JSON.parse(r.result.stdout)

test('alice: first call links her collection, a new card reaches her other device', { skip }, async () => {
  const alice = await instance('alice', ['alice@x.test'])
  // Before any browser request there is no identity.
  const none = await alice.call({ args: ['deck', 'list'] })
  assert.match(none.result.stderr, /Open DSH in the browser/)

  await alice.request(team.sign({ email: 'alice@x.test' }))
  const first = await alice.call({ args: ['item', 'add', '--deck', 'Spanish', '--front', 'el perro', '--back', 'the dog', '--id', 'es.perro'] })
  assert.equal(first.result.exitCode, 0, first.result.stderr)
  assert.equal(json(first).result, 'created')
  assert.ok(first.result.notes.some((n) => /Linked this collection to the Etude account alice@x.test/.test(n)), first.result.notes.join('\n'))
  assert.equal(first.result.sync.pushed, true)

  // The Worker now holds alice's account with events; nothing for anyone else.
  const accounts = edge.DB.raw.prepare('SELECT a.email, (SELECT COUNT(*) FROM events e WHERE e.account_id=a.id) AS events FROM accounts a').all()
  assert.deepEqual(accounts.map((a) => a.email), ['alice@x.test'])
  assert.ok(accounts[0].events > 0)

  // The collection lives under sha256(email), with Etude's device token beside it.
  const home = join(alice.dataDir, 'users', userKey('alice@x.test'))
  assert.ok(existsSync(join(home, 'etude.db')))
  assert.ok(readdirSync(join(home, 'sync')).length >= 1)

  // A second device of alice (her browser) sees the card after a sync.
  const dev = await linkDevice('alice@x.test')
  const items = await dev.etude('item', 'list')
  assert.ok(JSON.stringify(items).includes('es.perro'), JSON.stringify(items))
})

/** Another Etude device of `email` (her browser, in real life), linked through the edge by the same runner. */
async function linkDevice(email) {
  const home = mkdtempSync(join(tmp, 'device-'))
  const jwt = team.sign({ email })
  const { runJob } = await import('../lib/exec.js')
  const job = (argv, expect, writes = false) =>
    runJob({ nodePath: NODE, home, cwd: home, job: { etudeRoot: ROOT, etudeUrl: edge.origin, jwt, argv, expect, stdin: '', writes, syncMaxAgeSeconds: 0 } })
  const etude = async (...argv) => {
    const r = await job([...argv, '--compact'], argv.slice(0, 2).join(' '))
    if (r.exitCode !== 0) throw new Error(r.stderr)
    return JSON.parse(r.stdout)
  }
  return { home, etude, job }
}

test('bob: his own DSH, his own account, none of alice\'s cards', { skip }, async () => {
  const bob = await instance('bob', ['bob@x.test'])
  // Alice's JWT on Bob's DSH is ignored: she is not in its allowedEmails.
  await bob.request(team.sign({ email: 'alice@x.test' }))
  assert.match((await bob.call({ args: ['deck', 'list'] })).result.stderr, /Open DSH in the browser/)

  await bob.request(team.sign({ email: 'bob@x.test' }))
  const list = await bob.call({ args: ['item', 'list'] })
  assert.equal(list.result.exitCode, 0, list.result.stderr)
  assert.equal(JSON.stringify(json(list)).includes('es.perro'), false)
  const emails = edge.DB.raw.prepare('SELECT email FROM accounts ORDER BY email').all().map((r) => r.email)
  assert.ok(emails.includes('bob@x.test'))
})

test('isolation: alice\'s device token is refused under bob\'s identity and without one', { skip }, async () => {
  const home = join(tmp, 'alice', 'data', 'users', userKey('alice@x.test'))
  const secret = readdirSync(join(home, 'sync')).find((f) => f.endsWith('.json'))
  const { token } = JSON.parse(readFileSync(join(home, 'sync', secret), 'utf8'))
  assert.match(token, /^etd_/)
  const as = async (jwt) =>
    (await fetch(`${edge.origin}/v1/sync/events?after=0`, { headers: { authorization: `Bearer ${token}`, ...(jwt ? { 'cf-access-token': jwt } : {}) }, redirect: 'manual' })).status
  assert.equal(await as(team.sign({ email: 'bob@x.test' })), 403, 'alice token + bob identity')
  assert.equal(await as(null), 302, 'no identity: Access login')
  assert.equal(await as(team.sign({ email: 'alice@x.test', aud: 'cockpit-aud' })), 302, 'a JWT for another app is no linked token')
  assert.equal(await as(team.sign({ email: 'alice@x.test' })), 200)
})

test('two people on one DSH: the tool refuses instead of guessing', { skip }, async () => {
  const shared = await instance('shared', ['alice@x.test', 'carol@x.test'])
  await shared.request(team.sign({ email: 'alice@x.test' }))
  await shared.request(team.sign({ email: 'carol@x.test' }))
  const r = await shared.call({ args: ['deck', 'list'] })
  assert.match(r.result.stderr, /More than one person/)
})

test('deletes are refused and change nothing; archive works and syncs', { skip }, async () => {
  const alice = await instance('alice2', ['alice@x.test'])
  await alice.request(team.sign({ email: 'alice@x.test' }))
  assert.equal((await alice.call({ args: ['item', 'add', '--deck', 'Old', '--front', 'x', '--back', 'y', '--id', 'old.x'] })).result.exitCode, 0)
  // No approval prompt exists: the tool refuses before anything runs.
  const refused = await alice.call({ args: ['deck', 'delete', 'Old', '--items', '--yes'] })
  assert.equal(refused.decision.kind, 'allow')
  assert.equal(refused.result.exitCode, 2)
  assert.match(refused.result.stderr, /deck","archive"/)
  assert.ok(json(await alice.call({ args: ['deck', 'list'] })).some((d) => d.name === 'Old'))
  assert.match((await alice.call({ args: ['item', 'delete', 'old.x', '--yes'] })).result.stderr, /item","archive"/)

  const archived = await alice.call({ args: ['item', 'archive', 'old.x'] })
  assert.equal(archived.result.exitCode, 0, archived.result.stderr)
  assert.equal(archived.result.sync.pushed, true)
  const shown = json(await alice.call({ args: ['item', 'show', 'old.x'] }))
  assert.equal(shown.archived ?? shown.item?.archived, true, JSON.stringify(shown).slice(0, 300))
})

test('AI grading stays off: settings refused, proxy never called', { skip }, async () => {
  const alice = await instance('alice5', ['alice@x.test'])
  await alice.request(team.sign({ email: 'alice@x.test' }))
  const r = await alice.call({ args: ['settings', 'set', 'ai.feedback.url=' + edge.origin + '/v1/ai/chat/completions'] })
  assert.match(r.result.stderr, /AI grading/)
  const home = join(alice.dataDir, 'users', userKey('alice@x.test'))
  assert.equal(existsSync(join(home, '.env')), false, 'no key file in the collection home')
  assert.equal(edge.stats.ai, 0, 'the Worker AI proxy was never reached')
})

test('a pack file from the workspace imports; study next and stats work', { skip }, async () => {
  const alice = await instance('alice3', ['alice@x.test'])
  await alice.request(team.sign({ email: 'alice@x.test' }))
  const scaffold = await alice.call({ args: ['pack', 'new'] })
  assert.equal(scaffold.result.exitCode, 0, scaffold.result.stderr)
  writeFileSync(join(alice.ws, 'notes.md'), scaffold.result.stdout)
  const imp = await alice.call({ args: ['pack', 'import', 'notes.md'] })
  assert.equal(imp.result.exitCode, 0, imp.result.stderr)
  assert.equal((await alice.call({ args: ['study', 'next'] })).result.exitCode, 0)
  assert.equal((await alice.call({ args: ['stats', 'overview'] })).result.exitCode, 0)
})

test('expired identity: the command still runs locally and says sync waits', { skip }, async () => {
  const alice = await instance('alice4', ['alice@x.test'])
  await alice.request(team.sign({ email: 'alice@x.test' }))
  assert.equal((await alice.call({ args: ['deck', 'list'] })).result.exitCode, 0)
  // A new instance object with the same data dir but no live JWT (DSH restarted, nobody opened it).
  const later = await instance('alice4', ['alice@x.test'])
  const r = await later.call({ args: ['item', 'add', '--deck', 'Later', '--front', 'a', '--back', 'b'] })
  assert.equal(r.result.exitCode, 0, r.result.stderr)
  assert.ok(r.result.notes.some((n) => /Sync skipped/.test(n)), r.result.notes.join('\n'))
})
