// Starts runner/runner.mjs under Node 24 for one call. The job (including the Access JWT) goes
// over fd 3, so it never appears in argv, the environment or a file.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const RUNNER = fileURLToPath(new URL('../runner/runner.mjs', import.meta.url))

/** Environment for the runner: only what Node and Etude need, never DSH's own secrets. */
export function runnerEnv(home) {
  const env = { ETUDE_HOME: home, ETUDE_TELEMETRY: '0', NO_COLOR: '1', HOME: home }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/**
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, sync?: object, notes: string[], timedOut?: boolean }>}
 */
export function runJob({ nodePath, home, cwd, job, timeoutMs = 120_000, signal, maxOldSpaceMb = 256 }) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [`--max-old-space-size=${maxOldSpaceMb}`, '--no-warnings', RUNNER], {
      cwd,
      env: runnerEnv(home),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d) => {
      if (err.length < 64 * 1024) err += d
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdio[3].end(JSON.stringify(job))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ exitCode: 1, stdout: '', stderr: `cannot start the Etude runner: ${e.message}`, notes: [] })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const line = out.trim().split('\n').pop()
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({
          exitCode: code ?? 1,
          stdout: '',
          stderr: timedOut ? `etude timed out after ${timeoutMs} ms` : signal?.aborted ? 'cancelled' : `the Etude runner failed (exit ${code}): ${err.slice(-2000)}`,
          notes: [],
          timedOut,
        })
      }
    })
  })
}
