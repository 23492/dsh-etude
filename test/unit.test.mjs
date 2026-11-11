import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccessVerifier } from '../lib/access.js'
import { createIdentityStore, userKey } from '../lib/identity.js'
import { checkInvocation, indexCatalog, PolicyError } from '../lib/policy.js'
import { startTeam, DSH_AUD } from './support/edge.mjs'

let team
before(async () => {
  team = await startTeam()
})
after(() => team.close())

const cfg = () => ({ teamDomain: team.origin, audiences: [DSH_AUD], emails: ['alice@x.test'], allowInsecureTeam: true })

test('access: accepts a valid JWT and lowercases the email', async () => {
  const verify = createAccessVerifier()
  const r = await verify(team.sign({ email: 'Alice@X.test' }), cfg())
  assert.equal(r.ok, true)
  assert.equal(r.email, 'alice@x.test')
  assert.equal(typeof r.exp, 'number')
})

test('access: rejects forged, wrong aud, wrong iss, expired, no email, not allowed, garbage', async () => {
  const verify = createAccessVerifier()
  const cases = {
    'bad signature': team.sign({ email: 'alice@x.test', key: 'rogue' }),
    'wrong audience': team.sign({ email: 'alice@x.test', aud: 'cockpit-aud' }),
    'wrong issuer': team.sign({ email: 'alice@x.test', iss: 'https://evil.example' }),
    expired: team.sign({ email: 'alice@x.test', exp: 1000 }),
    'no email (service token)': team.sign({}),
    'identity not allowed': team.sign({ email: 'bob@x.test' }),
    'no assertion': 'x.y',
  }
  for (const [reason, jwt] of Object.entries(cases)) {
    const r = await verify(jwt, cfg())
    assert.equal(r.ok, false, reason)
    assert.equal(r.reason, reason)
  }
})

test('access: an http team origin needs the test switch', async () => {
  const verify = createAccessVerifier()
  const r = await verify(team.sign({ email: 'alice@x.test' }), { ...cfg(), allowInsecureTeam: false })
  assert.equal(r.ok, false)
})

test('identity: one live email resolves; a disallowed email is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'etude-id-'))
  const store = createIdentityStore({ usersDir: dir, allowedEmails: ['alice@x.test'] })
  const exp = Math.floor(Date.now() / 1000) + 3600
  assert.equal(store.remember('mallory@x.test', 'jwt-m', exp), false)
  assert.throws(() => store.resolveOwner(), /No Cloudflare Access identity/)
  store.remember('alice@x.test', 'jwt-a', exp)
  const owner = store.resolveOwner()
  assert.equal(owner.email, 'alice@x.test')
  assert.equal(owner.jwt, 'jwt-a')
  assert.equal(owner.home, join(dir, userKey('alice@x.test')))
  assert.deepEqual(JSON.parse(readFileSync(join(owner.home, 'owner.json'), 'utf8')), { email: 'alice@x.test' })
  rmSync(dir, { recursive: true })
})

test('identity: two live emails refuse; an older JWT does not replace a newer one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'etude-id-'))
  const store = createIdentityStore({ usersDir: dir, allowedEmails: ['alice@x.test', 'bob@x.test'] })
  const t = Math.floor(Date.now() / 1000)
  store.remember('alice@x.test', 'new', t + 3600)
  assert.equal(store.remember('alice@x.test', 'old', t + 100), false)
  assert.equal(store.resolveOwner().jwt, 'new')
  store.remember('bob@x.test', 'jwt-b', t + 3600)
  assert.throws(() => store.resolveOwner(), /More than one person/)
  rmSync(dir, { recursive: true })
})

test('identity: without a live JWT the single linked collection is used, local only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'etude-id-'))
  const now = { t: Date.now() }
  const store = createIdentityStore({ usersDir: dir, allowedEmails: ['alice@x.test'], now: () => now.t })
  store.remember('alice@x.test', 'jwt-a', Math.floor(now.t / 1000) + 120)
  store.resolveOwner()
  now.t += 120_000 // expired (and inside the 60 s margin)
  const owner = store.resolveOwner()
  assert.equal(owner.email, 'alice@x.test')
  assert.equal(owner.jwt, null)
  rmSync(dir, { recursive: true })
})

const catalog = indexCatalog({
  version: 'test',
  groups: [
    { name: 'deck', defaultVerb: 'list' },
    { name: 'settings', defaultVerb: 'get' },
    { name: 'sync', defaultVerb: 'status' },
    { name: 'account', defaultVerb: 'status' },
  ],
  commands: [
    { name: 'deck list' },
    { name: 'deck delete', writes: true, confirm: true, dryRun: true },
    { name: 'item add', writes: true },
    { name: 'pack import', writes: true },
    { name: 'sync status' },
    { name: 'sync now', writes: true },
    { name: 'sync setup', writes: true },
    { name: 'sync verify', writes: true },
    { name: 'account status' },
    { name: 'account delete', writes: true, confirm: true },
    { name: 'serve' },
    { name: 'settings key set', writes: true },
    { name: 'type folder delete', writes: true, confirm: true },
    { name: 'item delete', writes: true, confirm: true },
    { name: 'item archive', writes: true, dryRun: true },
    { name: 'card reset', writes: true, dryRun: true },
    { name: 'settings set', writes: true },
    { name: 'settings unset', writes: true },
    { name: 'settings test-ai' },
  ],
})

test('policy: resolves commands, group defaults and three-word verbs', () => {
  const env = { cwd: tmpdir(), dataDir: '/data/.dsh/dsh-etude' }
  assert.equal(checkInvocation(catalog, ['deck'], env).cmd.name, 'deck list')
  assert.throws(() => checkInvocation(catalog, ['type', 'folder', 'delete', 'A'], env), /type folder delete/)
  assert.equal(checkInvocation(catalog, ['item', 'add', '--deck', 'X'], env).writes, true)
})

test('policy: denies --db, sign-in, sync setup, account changes, serve, provider keys', () => {
  const env = { cwd: tmpdir(), dataDir: '/data/.dsh/dsh-etude' }
  for (const argv of [
    ['deck', 'list', '--db', '/tmp/x.db'],
    ['deck', 'list', '--db=/tmp/x.db'],
    ['sync', 'setup', '--server', 'https://evil.example'],
    ['sync', 'verify', 'lnk_x'],
    ['account', 'delete', '--yes'],
    ['serve'],
    ['settings', 'key', 'set', 'openai', 'sk'],
    ['nonsense'],
    [],
    ['--help'],
  ]) {
    assert.throws(() => checkInvocation(catalog, argv, env), PolicyError, argv.join(' '))
  }
  assert.equal(checkInvocation(catalog, ['sync', 'now'], env).cmd.name, 'sync now')
  assert.equal(checkInvocation(catalog, ['sync'], env).cmd.name, 'sync status')
})

test('policy: irreversible commands are refused with the archive equivalent, also with --yes or --dry-run', () => {
  const env = { cwd: tmpdir(), dataDir: '/data/.dsh/dsh-etude' }
  assert.throws(() => checkInvocation(catalog, ['deck', 'delete', 'Old', '--yes'], env), /irreversible.*"deck","archive"/)
  assert.throws(() => checkInvocation(catalog, ['deck', 'delete', 'Old', '--dry-run'], env), /irreversible/)
  assert.throws(() => checkInvocation(catalog, ['item', 'delete', 'x'], env), /"item","archive"/)
  assert.throws(() => checkInvocation(catalog, ['card', 'reset', '1'], env), /card","suspend"/)
  assert.throws(() => checkInvocation(catalog, ['type', 'folder', 'delete', 'A'], env), /irreversible/)
  assert.deepEqual(checkInvocation(catalog, ['item', 'archive', 'x', '--yes'], env).argv, ['item', 'archive', 'x'])
})

test('policy: AI grading settings are refused, other settings are not', () => {
  const env = { cwd: tmpdir(), dataDir: '/data/.dsh/dsh-etude' }
  for (const argv of [
    ['settings', 'set', 'ai.feedback.url=https://x'],
    ['settings', 'set', 'dayStartHour=4', 'ai.decision=null'],
    ['settings', 'set', 'ai={"feedback":null}'],
    ['settings', 'unset', 'ai.feedback'],
    ['settings', 'test-ai'],
  ]) {
    assert.throws(() => checkInvocation(catalog, argv, env), PolicyError, argv.join(' '))
  }
  assert.equal(checkInvocation(catalog, ['settings', 'set', 'dayStartHour=4'], env).cmd.name, 'settings set')
  assert.equal(checkInvocation(catalog, ['settings', 'set', 'accent=teal'], env).cmd.name, 'settings set')
})

test('policy: with aiGrading on, test-ai runs but ai.* settings and keys stay plugin-owned', () => {
  const env = { cwd: tmpdir(), dataDir: '/data/.dsh/dsh-etude', aiGrading: true }
  assert.equal(checkInvocation(catalog, ['settings', 'test-ai'], env).cmd.name, 'settings test-ai')
  for (const argv of [
    ['settings', 'set', 'ai.feedback.url=https://x'],
    ['settings', 'unset', 'ai.feedback'],
    ['settings', 'key', 'set', 'OPENROUTER_API_KEY'],
    ['settings', 'chatgpt', 'login'],
  ]) {
    assert.throws(() => checkInvocation(catalog, argv, env), PolicyError, argv.join(' '))
  }
})

test('policy: no path argument may reach into the data directory, also through a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'etude-pol-'))
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  mkdirSync(join(dataDir, 'users', 'bob'), { recursive: true })
  mkdirSync(ws)
  symlinkSync(join(dataDir, 'users', 'bob'), join(ws, 'link'))
  const env = { cwd: ws, dataDir }
  for (const argv of [
    ['pack', 'import', join(dataDir, 'users', 'bob', 'etude.db')],
    ['pack', 'import', '../data/users/bob/x.md'],
    ['pack', 'import', 'link/etude.db'],
    ['item', 'add', '--fields-file=../data/users/bob/f.json'],
    ['item', 'add', '--set-file', 'back=../data/users/bob/sync/dev.json'],
    ['pack', 'import', `file://${dataDir}/users/bob/x.md`],
  ]) {
    assert.throws(() => checkInvocation(catalog, argv, env), /data directory/, argv.join(' '))
  }
  assert.throws(() => checkInvocation(catalog, ['deck', 'list'], { cwd: join(dataDir, 'users'), dataDir }), /working directory/)
  assert.equal(checkInvocation(catalog, ['pack', 'import', 'deck.md'], env).cmd.name, 'pack import')
  rmSync(root, { recursive: true })
})
