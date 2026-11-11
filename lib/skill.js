// Etude's own agent skill (skill/SKILL.md + skill/references/ from the pinned Etude tarball),
// served to DSH as the skill `etude`. The upstream files stay byte-for-byte as released, so an
// Etude bump is a clean replace; the DSH-specific preface (skill/dsh.md in this repo) is
// prepended when the body is loaded.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'etude'
export const PROVIDER = 'dsh-etude'
const PREFACE = fileURLToPath(new URL('../skill/dsh.md', import.meta.url))

/** `---\nname: x\ndescription: y\n---\nbody` -> { meta, body }. Only flat `key: value` lines. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { meta, body: text.slice(m[0].length) }
}

/** The skill as DSH sees it, read from an Etude root; null when the root has no skill. */
export function loadEtudeSkill(etudeRoot, version) {
  const file = join(etudeRoot, 'skill', 'SKILL.md')
  if (!existsSync(file)) return null
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  const preface = readFileSync(PREFACE, 'utf8').replaceAll('{{ETUDE_VERSION}}', version)
  return {
    path: file,
    name: SKILL_NAME,
    description: meta.description || 'Create, organize and study flashcards in Etude.',
    whenToUse:
      "The user mentions flashcards, Etude, spaced repetition, studying or revising, being quizzed, making cards from notes, decks, or their study progress and weak spots. Use with the `etude` tool.",
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: PROVIDER,
    resourceBase: { kind: 'directory', path: join(etudeRoot, 'skill') },
    metadata: { etudeVersion: version, upstream: 'https://github.com/Zibhelina/etude/tree/v' + version + '/skill' },
    content: `${preface}${body}`,
  }
}

/**
 * A ctx.skills provider. `getRuntime()` resolves to { etudeRoot, version } (it may wait for the
 * runtime download); until then the catalog is reported incomplete so DSH asks again.
 */
export function createEtudeSkillProvider({ getRuntime, rank = 600 }) {
  return {
    name: PROVIDER,
    async list() {
      let rt
      try {
        rt = await getRuntime()
      } catch {
        return { candidates: [], complete: false }
      }
      const skill = rt && loadEtudeSkill(rt.etudeRoot, rt.version)
      if (!skill) return { candidates: [], complete: false }
      const { content: _content, ...summary } = skill
      return [{ ...summary, rank, locator: rt.etudeRoot }]
    },
    async get(candidate) {
      const rt = await getRuntime().catch(() => null)
      if (!rt || rt.etudeRoot !== candidate.locator) return undefined
      return loadEtudeSkill(rt.etudeRoot, rt.version) ?? undefined
    },
  }
}
