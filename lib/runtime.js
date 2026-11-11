// Installs the pinned Etude runtime (Node 24 + Etude source + the few npm packages its CLI
// imports) under <dataDir>/runtime, with every download hash-checked. No npm, no build:
// downloads stream to disk, `tar` extracts, peak memory stays in the tens of MiB.
//
// Layout:
//   runtime/node-v<version>/bin/node
//   runtime/etude-<version>/{bin,src,runtime,types,schedulers,examples,skill,docs,package.json,LICENSE}
//   runtime/etude-<version>/node_modules/<pkg>
//   runtime/etude-<version>/.ready-2       written last; its presence means "complete". The number
//                                          is the layout: a changed file list bumps it and reinstalls.
//   runtime/etude-<version>/catalog.json   `etude commands`, cached

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'
import { MANIFEST } from './manifest.js'

const run = promisify(execFile)
const ETUDE_PARTS = ['bin', 'src', 'runtime', 'types', 'schedulers', 'examples', 'skill', 'docs', 'package.json', 'LICENSE']

/** Stream `url` to `file`, checking a hex sha256 or an SRI sha512 integrity string. */
export async function download(url, file, { sha256, integrity }, fetchImpl = fetch) {
  const algo = sha256 ? 'sha256' : 'sha512'
  const want = sha256 ? sha256 : String(integrity).replace(/^sha512-/, '')
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const hash = createHash(algo)
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(`${file}.part`))
  const got = sha256 ? hash.digest('hex') : hash.digest('base64')
  if (got !== want) {
    rmSync(`${file}.part`, { force: true })
    throw new Error(`${url}: checksum mismatch`)
  }
  renameSync(`${file}.part`, file)
}

export function runtimePaths(dataDir, manifest = MANIFEST) {
  const base = join(dataDir, 'runtime')
  const nodeDir = join(base, `node-v${manifest.node.version}`)
  const etudeRoot = join(base, `etude-${manifest.etude.version}`)
  return { base, nodeDir, nodePath: join(nodeDir, 'bin', 'node'), etudeRoot, ready: join(etudeRoot, '.ready-2'), catalog: join(etudeRoot, 'catalog.json') }
}

async function installNode(paths, manifest, log, fetchImpl) {
  if (existsSync(paths.nodePath)) return
  const build = manifest.node.builds[arch()]
  if (!build) throw new Error(`no pinned Node build for ${arch()}; set nodePath in the config`)
  mkdirSync(paths.base, { recursive: true })
  const tgz = join(paths.base, `node-v${manifest.node.version}.tar.gz`)
  log.info(`dsh-etude: downloading Node ${manifest.node.version}`)
  await download(build.url, tgz, { sha256: build.sha256 }, fetchImpl)
  const tmp = `${paths.nodeDir}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  await run('tar', ['-xzf', tgz, '-C', tmp, '--strip-components=1'])
  rmSync(paths.nodeDir, { recursive: true, force: true })
  renameSync(tmp, paths.nodeDir)
  rmSync(tgz, { force: true })
}

async function installEtude(paths, manifest, log, fetchImpl) {
  const tmp = `${paths.etudeRoot}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const tgz = join(paths.base, `etude-${manifest.etude.version}.tar.gz`)
  log.info(`dsh-etude: downloading Etude ${manifest.etude.version}`)
  await download(manifest.etude.url, tgz, { sha256: manifest.etude.sha256 }, fetchImpl)
  const top = `etude-${manifest.etude.version}`
  // docs/ is for the skill, which points at docs/cli.md, packs.md and types.md; its screenshots are not.
  await run('tar', ['-xzf', tgz, '-C', tmp, '--strip-components=1', `--exclude=${top}/docs/screenshots`, ...ETUDE_PARTS.map((p) => `${top}/${p}`)])
  rmSync(tgz, { force: true })
  for (const pkg of manifest.packages) {
    const dir = join(tmp, 'node_modules', pkg.name)
    mkdirSync(dir, { recursive: true })
    const file = join(paths.base, `${pkg.name.replace('/', '__')}-${pkg.version}.tgz`)
    await download(pkg.url, file, { integrity: pkg.integrity }, fetchImpl)
    await run('tar', ['-xzf', file, '-C', dir, '--strip-components=1'])
    rmSync(file, { force: true })
  }
  rmSync(paths.etudeRoot, { recursive: true, force: true })
  renameSync(tmp, paths.etudeRoot)
}

/** `etude commands` through the given Node, cached next to the install. */
export async function loadCatalog({ nodePath, etudeRoot, cacheFile }) {
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'))
  const { stdout } = await run(nodePath, ['--no-warnings', join(etudeRoot, 'src', 'cli', 'main.ts'), 'commands', '--compact'], {
    env: { PATH: process.env.PATH, ETUDE_HOME: join(etudeRoot, '.catalog-home'), ETUDE_TELEMETRY: '0' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  })
  const catalog = JSON.parse(stdout)
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(catalog))
  return catalog
}

/**
 * Make sure a runtime exists. Config `nodePath`/`etudeRoot` skip the matching download.
 * @returns {Promise<{ nodePath: string, etudeRoot: string, catalog: object }>}
 */
export async function ensureRuntime({ dataDir, nodePath, etudeRoot, log = console, fetchImpl = fetch, manifest = MANIFEST }) {
  const paths = runtimePaths(dataDir, manifest)
  const node = nodePath || paths.nodePath
  const root = etudeRoot || paths.etudeRoot
  if (!nodePath) await installNode(paths, manifest, log, fetchImpl)
  if (!etudeRoot && !existsSync(paths.ready)) {
    await installEtude(paths, manifest, log, fetchImpl)
    writeFileSync(paths.ready, JSON.stringify({ etude: manifest.etude.version, node: manifest.node.version, at: new Date().toISOString() }) + '\n')
  }
  const { stdout } = await run(node, ['--version'])
  if (Number(stdout.trim().replace(/^v/, '').split('.')[0]) < 24) throw new Error(`${node} is ${stdout.trim()}; Etude needs Node 24`)
  const catalog = await loadCatalog({ nodePath: node, etudeRoot: root, cacheFile: etudeRoot ? null : paths.catalog })
  return { nodePath: node, etudeRoot: root, catalog }
}
