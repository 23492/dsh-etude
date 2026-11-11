// The Etude skill: registered through ctx.skills from the pinned runtime, upstream text kept
// verbatim behind the DSH preface, and the pinned version equal to etude-cloudflare's etude.ref.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'
import { MANIFEST } from '../lib/manifest.js'
import { loadEtudeSkill, parseFrontmatter } from '../lib/skill.js'
import { createFakeCtx } from './support/fake-ctx.mjs'

const ETUDE_REF = fileURLToPath(new URL('../../etude-cloudflare/etude.ref', import.meta.url))
const ROOT = process.env.ETUDE_TEST_ROOT

test('the pinned Etude version equals etude-cloudflare etude.ref', { skip: existsSync(ETUDE_REF) ? false : 'no ../etude-cloudflare checkout' }, () => {
  const ref = readFileSync(ETUDE_REF, 'utf8').trim()
  assert.equal(MANIFEST.etude.tag, ref)
  assert.equal(`v${MANIFEST.etude.version}`, ref)
  assert.match(MANIFEST.etude.url, new RegExp(`/refs/tags/${ref.replace(/\./g, '\\.')}$`))
})

/** A minimal Etude root with a skill, standing in for the downloaded tarball. */
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'etude-skill-'))
  mkdirSync(join(root, 'skill', 'references'), { recursive: true })
  const upstream = '---\nname: etude\ndescription: Use when a user wants flashcards.\n---\n\n# Etude\n\nRun `etude db path` and pass `--db PATH`.\n'
  writeFileSync(join(root, 'skill', 'SKILL.md'), upstream)
  writeFileSync(join(root, 'skill', 'references', 'authoring.md'), '# Authoring\n')
  return { root, upstream }
}

test('loadEtudeSkill: DSH preface first, upstream body verbatim, version filled in', () => {
  const { root, upstream } = fakeRoot()
  const skill = loadEtudeSkill(root, '3.1.2')
  assert.equal(skill.name, 'etude')
  assert.equal(skill.description, 'Use when a user wants flashcards.')
  assert.equal(skill.metadata.etudeVersion, '3.1.2')
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: join(root, 'skill') })
  assert.ok(skill.content.startsWith('# Etude in DSH (read this first)'))
  assert.match(skill.content, /unchanged from Etude 3\.1\.2/)
  assert.doesNotMatch(skill.content, /\{\{ETUDE_VERSION\}\}/)
  assert.ok(skill.content.endsWith(parseFrontmatter(upstream).body), 'upstream body is appended unchanged')
  assert.match(skill.content, /Never pass `--db`/)
  assert.match(skill.content, /Nothing irreversible/)
  assert.match(skill.content, /AI grading is off/)
  assert.doesNotMatch(skill.content, /\{\{AI_RULE\}\}/)
  const on = loadEtudeSkill(root, '3.1.2', { aiGrading: true })
  assert.match(on.content, /AI grading is on, through the Etude server/)
  assert.doesNotMatch(on.content, /AI grading is off/)
  rmSync(root, { recursive: true })
})

test('the plugin registers the etude skill provider, and it lists and loads the skill', async () => {
  const { root } = fakeRoot()
  const fake = createFakeCtx()
  const providers = []
  fake.ctx.inject = (deps, fn) => {
    assert.deepEqual(deps, ['skills'])
    fn({ effect: (f) => f(), skills: { registerProvider: (create) => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) } })
  }
  // A catalog-only runtime: nodePath/etudeRoot point at fakes so no download starts.
  const dataDir = mkdtempSync(join(tmpdir(), 'etude-skill-data-'))
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: '3.1.2', groups: [], commands: [] }))
  const nodeStub = join(dataDir, 'node')
  writeFileSync(nodeStub, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.22.2; else cat "${join(root, 'catalog.json')}"; fi\n`, { mode: 0o755 })
  plugin.apply(fake.ctx, {
    etudeUrl: 'https://etude.example.test',
    accessTeamDomain: 'team.example.test',
    accessAudiences: ['aud'],
    allowedEmails: ['a@x.test'],
    dataDir,
    nodePath: nodeStub,
    etudeRoot: root,
  })
  assert.equal(providers.length, 1)
  const provider = providers[0]
  assert.equal(provider.name, 'dsh-etude')
  const listed = await provider.list({})
  const candidates = Array.isArray(listed) ? listed : listed.candidates
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'etude')
  assert.equal(candidates[0].metadata.etudeVersion, '3.1.2')
  assert.equal(candidates[0].invocation.modelInvocable, true)
  assert.equal('content' in candidates[0], false, 'the catalog entry carries no body')
  const body = await provider.get(candidates[0], {})
  assert.match(body.content, /^# Etude in DSH/)
  rmSync(root, { recursive: true })
  rmSync(dataDir, { recursive: true })
})

test('the downloaded skill matches etude.ref and keeps its references', { skip: ROOT ? false : 'set ETUDE_TEST_ROOT' }, () => {
  const ref = existsSync(ETUDE_REF) ? readFileSync(ETUDE_REF, 'utf8').trim() : `v${MANIFEST.etude.version}`
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(`v${pkg.version}`, ref)
  const skill = loadEtudeSkill(ROOT, pkg.version)
  assert.equal(skill.name, 'etude')
  for (const ref of ['authoring.md', 'scheduling.md', 'types.md']) assert.ok(existsSync(join(ROOT, 'skill', 'references', ref)), ref)
  assert.ok(skill.content.includes(readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf8').split('\n---\n').slice(1).join('\n---\n').trim()))
})
