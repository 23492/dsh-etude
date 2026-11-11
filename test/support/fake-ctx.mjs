// The slice of a cordis Context that dsh-etude uses: on (waterfall listeners), effect,
// tools.register, logger. Enough to drive the plugin the way DSH does.
export function createFakeCtx() {
  const listeners = new Map()
  const tools = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    effect(fn) {
      fn()
    },
    // No optional services (skills) unless a test provides them.
    inject() {},
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
  }

  /** Simulate one browser /api request carrying an Access JWT. */
  async function request(jwt) {
    const req = { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} }
    let reached = false
    const fns = listeners.get('connection/request') || []
    const call = (i) => (i < fns.length ? fns[i](req, {}, () => call(i + 1)) : ((reached = true), Promise.resolve()))
    await call(0)
    // Verification runs in the background; give it a moment.
    await new Promise((r) => setTimeout(r, 150))
    return reached
  }

  /** Run pre-execute (with DSH's default `allow`) and, when allowed or approved, execute. */
  async function callTool(args, { approve = true, cwd = process.cwd() } = {}) {
    const exec = { name: 'etude', arguments: args, agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
    const fns = listeners.get('tools/pre-execute') || []
    const call = (i) => (i < fns.length ? fns[i](exec, () => call(i + 1)) : Promise.resolve({ kind: 'allow' }))
    const decision = await call(0)
    if (decision.kind === 'ask' && !approve) return { decision, result: null }
    if (decision.kind !== 'allow' && decision.kind !== 'ask') return { decision, result: null }
    const result = await tools.get('etude').execute(args, exec)
    return { decision, result }
  }

  return { ctx, tools, logs, request, callTool }
}
