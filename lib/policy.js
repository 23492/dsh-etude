// Which `etude` invocations the agent may run.
//
// The catalog is Etude's own (`etude commands`, cached at install). The runner checks the
// resolved command again with Etude's parser, so a mismatch fails closed.
//
// Nothing irreversible runs (owner's decision, 2026-11-11): every command Etude marks `confirm`
// (it needs --yes), plus the few irreversible ones it does not mark, is refused outright, with
// no approval path. The refusal names the archive equivalent where one exists.

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

/** Commands the plugin owns or that reach outside the collection. Prefix match on whole words. */
const DENIED = [
  { prefix: 'serve', why: 'the plugin runs Etude as a CLI; the browser app is at the Etude URL' },
  { prefix: 'update', why: 'the Etude version is pinned by dsh-etude' },
  { prefix: 'settings key', why: 'AI provider keys are not managed through the agent' },
  { prefix: 'settings chatgpt', why: 'AI provider sign-in is not managed through the agent' },
  { prefix: 'settings test-ai', why: 'AI grading is off for this collection; grade answers in the chat' },
  { prefix: 'market publish', why: 'publishing to the public market is done by the user' },
  { prefix: 'market index', why: 'market maintenance is not part of this tool' },
  { prefix: 'agent ask', why: "Etude's own assistant needs an AI key; you are the assistant here" },
]
/** In these groups only the listed verbs run; the plugin owns sign-in and the Sync connection. */
const GROUP_ALLOW = {
  sync: ['sync status', 'sync now'],
  account: ['account status', 'account devices'],
}
/** Irreversible commands Etude does not mark `confirm`. */
const IRREVERSIBLE = ['card reset', 'market comment-delete']
/** Where to point the agent instead. */
const INSTEAD = {
  'deck delete': 'Archive the deck instead: ["deck","archive",<deck>] (undo with "deck unarchive").',
  'item delete': 'Archive the items instead: ["item","archive",<ids or --query>] (undo with "item unarchive").',
  'note delete': 'Archive the page instead: ["note","archive",<page>] (undo with "note unarchive").',
  'card prune': 'Suspend the leftover cards instead: ["card","suspend","--query","is:leftover"] (undo with "card unsuspend").',
  'card reset': 'To take cards out of study, suspend them: ["card","suspend",...]; to move them, use ["card","due",...,"--in","1d"].',
  'media prune': 'Unused media files can stay; they take no study time.',
}
/** Settings keys the agent may not change: AI grading stays off for this collection. */
const AI_KEY = /^(fields\.)?ai(\.|=|$)/

export class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.code = 'denied'
  }
}

/** name -> command spec, plus group defaults, from the `etude commands` JSON. */
export function indexCatalog(catalog) {
  const commands = new Map()
  for (const c of catalog.commands || []) commands.set(c.name, c)
  const groups = new Map()
  for (const g of catalog.groups || []) groups.set(g.name, g)
  return { commands, groups, version: catalog.version }
}

/**
 * The command an argv names: the longest run of leading words that is a command, or a bare
 * group (its default verb). Mirrors Etude's own `locate`; the runner re-checks with Etude.
 */
export function resolveCommand(index, argv) {
  const words = []
  for (const token of argv) {
    if (token.startsWith('-')) break
    words.push(token)
    if (words.length === 3) break
  }
  for (let n = words.length; n >= 1; n--) {
    const name = words.slice(0, n).join(' ')
    if (index.commands.has(name)) return index.commands.get(name)
  }
  if (words.length >= 1 && index.groups.has(words[0])) {
    const g = index.groups.get(words[0])
    if (g.defaultVerb) return index.commands.get(`${g.name} ${g.defaultVerb}`) || null
  }
  return null
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** The real path, following symlinks of the longest existing ancestor. */
function realish(path) {
  let current = path
  const tail = []
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      tail.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

/** Candidate path strings in one token: the token, `--flag=value`, `field=path`, `file://...`. */
function pathCandidates(token) {
  const out = [token]
  const eq = token.indexOf('=')
  if (eq > 0) out.push(token.slice(eq + 1))
  for (const value of [...out]) if (value.startsWith('file://')) {
    try {
      out.push(new URL(value).pathname)
    } catch {
      // not a URL
    }
  }
  return out.filter((v) => v && v !== '-')
}

/**
 * Check one invocation.
 * @returns {{ cmd: object, argv: string[], writes: boolean }}
 * @throws {PolicyError}
 */
export function checkInvocation(index, argv, { cwd, dataDir }) {
  if (!Array.isArray(argv) || argv.length === 0) throw new PolicyError('Give the etude command as args, e.g. ["deck","list"].')
  if (argv.some((a) => typeof a !== 'string')) throw new PolicyError('Every argument must be a string.')
  if (argv[0].startsWith('-')) throw new PolicyError('Put the command first, flags after it, e.g. ["item","list","--format","table"].')
  for (const a of argv) {
    if (a === '--db' || a.startsWith('--db=')) throw new PolicyError('--db is not available: the tool always uses your own collection.')
    if (a === '--') break
  }
  const cmd = resolveCommand(index, argv)
  if (!cmd) throw new PolicyError(`Unknown etude command "${argv.slice(0, 2).join(' ')}". Run ["commands"] or ["<group>","--help"].`)
  for (const d of DENIED) {
    if (cmd.name === d.prefix || cmd.name.startsWith(d.prefix + ' ')) throw new PolicyError(`\`etude ${cmd.name}\` is not available here: ${d.why}.`)
  }
  const group = cmd.name.split(' ')[0]
  if (GROUP_ALLOW[group] && !GROUP_ALLOW[group].includes(cmd.name)) {
    throw new PolicyError(
      `\`etude ${cmd.name}\` is not available here: dsh-etude connects this collection to the user's Etude account itself. Allowed: ${GROUP_ALLOW[group].join(', ')}.`,
    )
  }

  const root = realish(resolve(dataDir))
  if (within(realish(resolve(cwd)), root)) throw new PolicyError('The agent working directory is inside the dsh-etude data directory; run from a workspace folder.')
  for (const token of argv) {
    for (const candidate of pathCandidates(token)) {
      const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
      if (within(realish(abs), root)) throw new PolicyError('Paths inside the dsh-etude data directory are not available to the tool.')
    }
  }

  if (cmd.confirm === true || IRREVERSIBLE.includes(cmd.name)) {
    const instead = INSTEAD[cmd.name] || 'Ask the user to do it in the Etude app if they want it.'
    throw new PolicyError(`\`etude ${cmd.name}\` is not available here: the agent never runs irreversible commands (deletes, resets, prunes). ${instead}`)
  }
  if (cmd.name === 'settings set' || cmd.name === 'settings unset') {
    const positional = argv.slice(2).filter((a) => !a.startsWith('-'))
    if (positional.some((a) => AI_KEY.test(a))) {
      throw new PolicyError('AI grading settings (ai.*) are not available here: AI grading is off for this collection. Grade answers in the chat instead.')
    }
  }

  // --yes is never needed: nothing that asks for it runs.
  const clean = argv.filter((a) => a !== '--yes' && a !== '-y')
  const dry = argv.includes('--dry-run')
  return { cmd, argv: clean, writes: cmd.writes === true && !dry }
}
