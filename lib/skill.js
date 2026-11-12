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
const AI_RULE_OFF =
  "- **AI grading is off for this collection.** Grade answers yourself in the chat: show the card with `study next`, compare the user's answer with the private fields, then record the result with `study rate <card> <again|hard|good|easy>`. `settings set ai.*`, `settings test-ai`, `settings key` and `settings chatgpt` are refused."
const AI_RULE_ON =
  '- **AI grading is on, through the Etude server.** `study answer <card> <answer>` grades open answers (free, draw, hybrid types) with AI and returns feedback; script-graded types are checked as usual. The server fixes the model and holds the key, so `settings set ai.*`, `settings key` and `settings chatgpt` are refused; `settings test-ai` checks that grading works. If grading fails because the Access identity is stale, tell the user to open DSH in the browser, or grade in the chat and record it with `study rate`.'

export function loadEtudeSkill(etudeRoot, version, { aiGrading = false } = {}) {
  const file = join(etudeRoot, 'skill', 'SKILL.md')
  if (!existsSync(file)) return null
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  const preface = readFileSync(PREFACE, 'utf8').replaceAll('{{ETUDE_VERSION}}', version).replace('{{AI_RULE}}', aiGrading ? AI_RULE_ON : AI_RULE_OFF)
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
export function createEtudeSkillProvider({ getRuntime, rank = 600, aiGrading = false }) {
  return {
    name: PROVIDER,
    async list() {
      let rt
      try {
        rt = await getRuntime()
      } catch {
        return { candidates: [], complete: false }
      }
      const skill = rt && loadEtudeSkill(rt.etudeRoot, rt.version, { aiGrading })
      if (!skill) return { candidates: [], complete: false }
      const { content: _content, ...summary } = skill
      return [{ ...summary, rank, locator: rt.etudeRoot }]
    },
    async get(candidate) {
      const rt = await getRuntime().catch(() => null)
      if (!rt || rt.etudeRoot !== candidate.locator) return undefined
      return loadEtudeSkill(rt.etudeRoot, rt.version, { aiGrading }) ?? undefined
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The certification-deck skill `etude-cert` (cert/ in this repo): our own workflow and kit, not
// upstream Etude, so it ships with the plugin and survives Etude bumps.

export const CERT_SKILL_NAME = 'etude-cert'
const CERT_DIR = fileURLToPath(new URL('../cert/', import.meta.url))

export function loadCertSkill(dir = CERT_DIR) {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  return {
    path: file,
    name: meta.name || CERT_SKILL_NAME,
    description: meta.description || 'Build an Etude deck for a certification exam.',
    whenToUse:
      'The user wants to prepare for or pass a certification or vendor exam (Salesforce, AWS, Azure, CompTIA, ...) with Etude or flashcards, turn exam dumps, practice tests or a study guide into a deck, repair or extend such a deck, or decide when to book the exam.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: PROVIDER,
    resourceBase: { kind: 'directory', path: dir },
    metadata: { kit: join(dir, 'kit') },
    content: `${body.trimStart()}\n\nThis skill's base directory is \`${dir}\`; \`<kit>\` is \`${join(dir, 'kit')}\`. Use the \`etude\` tool for the collection (see the \`etude\` skill for the DSH rules).\n`,
  }
}

/** A ctx.skills provider for etude-cert. Static files: no runtime needed. */
export function createCertSkillProvider({ dir = CERT_DIR, rank = 610 } = {}) {
  return {
    name: `${PROVIDER}-cert`,
    async list() {
      const skill = loadCertSkill(dir)
      if (!skill) return []
      const { content: _content, ...summary } = skill
      return [{ ...summary, rank, locator: dir }]
    },
    async get(candidate) {
      if (candidate.locator !== dir) return undefined
      return loadCertSkill(dir) ?? undefined
    },
  }
}
