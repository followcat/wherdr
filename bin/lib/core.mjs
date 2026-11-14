// Shared by every wherdr command: paths, options, server environment, port
// checks and terminal output. No dependency: this runs before anything else.
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporaryInstall } from './runtime.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SERVER = path.join(ROOT, '.output', 'server', 'index.mjs')
export const BIN = path.join(ROOT, 'bin', 'wherdr.mjs')
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
export const DEFAULT_PORT = '7683'

// Installed by the Homebrew formula: the package lives in <prefix>/Cellar/wherdr/<version>/libexec.
export function homebrewInstall(file) {
  return /[\\/]Cellar[\\/]wherdr[\\/]/.test(file)
}

// How this copy of wherdr was installed (shared/updates.ts InstallMode), from
// the path of its bin/wherdr.mjs: the Homebrew Cellar; `npm i -g`
// (<prefix>/lib/node_modules/wherdr); another npm package (npx, bunx, pnpm
// dlx, a project's node_modules); otherwise a source checkout ('native').
export function installKind(bin) {
  if (homebrewInstall(bin)) return 'brew'
  const root = path.resolve(bin, '..', '..')
  if (temporaryInstall(bin)) return 'npm'
  if (/[\\/]lib[\\/]node_modules[\\/]wherdr$/.test(root)) return 'npm-global'
  if (/[\\/]node_modules[\\/]wherdr$/.test(root)) return 'npm'
  return 'native'
}

export const COMMANDS = ['run', 'start', 'stop', 'restart', 'status', 'logs', 'open', 'phone', 'panel', 'service', 'dictation', 'doctor', 'help', 'version']
const VALUE_OPTIONS = { '--port': 'port', '--host': 'host', '--data-dir': 'dataDir', '--hc-socket': 'hcSocket', '--session': 'session', '--lines': 'lines', '-n': 'lines' }
// Herdr sessions are gone in wherdr 3: --session is read, then ignored with a warning.
export const SESSION_IGNORED = '--session is ignored: wherdr 3 drives a herdr-core (hc) session, chosen with --hc-socket <path>.'
const FLAGS = { '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version', '-f': 'follow', '--follow': 'follow' }

// argv without the runtime and script → { command, sub, sets, port, host, dataDir, hcSocket, lines, follow, help, version, warnings }.
// Throws an Error with a user-facing message on bad input.
export function parseArgs(argv) {
  const out = {}
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (FLAGS[arg]) { out[FLAGS[arg]] = true; continue }
    if (!arg.startsWith('-')) { words.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const key = VALUE_OPTIONS[name]
    if (!key) throw new Error(`unknown option: ${arg} (see wherdr --help)`)
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) throw new Error(`${name} needs a value`)
    if (key === 'session') (out.warnings ??= []).push(SESSION_IGNORED)
    else out[key] = value
  }
  const [command = 'run', sub, ...extra] = words
  if (!COMMANDS.includes(command)) throw new Error(`unknown command: ${command} (see wherdr --help)`)
  out.command = command
  if (command === 'service') {
    if (sub !== 'install' && sub !== 'uninstall') throw new Error('usage: wherdr service install|uninstall')
    out.sub = sub
  } else if (command === 'dictation') {
    if (sub !== 'fetch') throw new Error('usage: wherdr dictation fetch [set...]')
    out.sub = sub
    out.sets = extra.splice(0)
  } else if (sub !== undefined) throw new Error(`unexpected argument: ${sub}`)
  if (extra.length) throw new Error(`unexpected argument: ${extra[0]}`)
  if (out.port !== undefined && !/^\d+$/.test(out.port)) throw new Error(`--port must be a number (got: ${out.port})`)
  if (out.port !== undefined && (Number(out.port) < 1 || Number(out.port) > 65535)) throw new Error(`--port must be between 1 and 65535 (got: ${out.port})`)
  if (out.lines !== undefined && !/^\d+$/.test(out.lines)) throw new Error(`--lines must be a number (got: ${out.lines})`)
  if (out.help) out.command = 'help'
  else if (out.version) out.command = 'version'
  return out
}

export function expandHome(p, home = os.homedir()) {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p
}

// Folder of wherdr's own files (pid, log, settings, data): $WHERDR_DIR or ~/wherdr.
export function wherdrDir(env = process.env, home = os.homedir()) {
  return path.resolve(expandHome(env.WHERDR_DIR || path.join(home, 'wherdr'), home))
}

// KEY=VALUE lines of ~/wherdr/wherdr.env (comments and blank lines ignored).
export function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line)
    if (!m || line.startsWith('#')) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export function settingsFile(dir) { return path.join(dir, 'wherdr.env') }

// The environment, completed by ~/wherdr/wherdr.env (the environment wins).
export function withSettings(env, dir) {
  const file = settingsFile(dir)
  if (!existsSync(file)) return env
  try { return { ...parseEnvFile(readFileSync(file, 'utf8')), ...env } } catch { return env }
}

// Environment of the server: options win over the environment, which wins over the defaults.
export function serverEnv(opts, env, home = os.homedir(), bin = BIN) {
  const out = { ...env }
  const dir = wherdrDir(env, home)
  out.PORT = opts.port ?? env.PORT ?? DEFAULT_PORT
  out.HOST = opts.host ?? env.HOST ?? '127.0.0.1'
  out.DATA_DIR = path.resolve(expandHome(opts.dataDir ?? env.DATA_DIR ?? path.join(dir, 'data'), home))
  const hc = opts.hcSocket ?? env.HC_SOCKET
  if (hc) out.HC_SOCKET = path.resolve(expandHome(hc, home))
  out.NODE_ENV = 'production'
  // Update command, or one-tap update, offered in the app (shared/updates.ts):
  // the package to replace and the folder of its state and log (bin/lib/updater.mjs).
  out.WHERDR_INSTALL = installKind(bin)
  out.WHERDR_ROOT = path.resolve(bin, '..', '..')
  out.WHERDR_DIR = dir
  if (out.CLAUDE_CONFIG_DIR) out.CLAUDE_CONFIG_DIR = path.resolve(home, expandHome(out.CLAUDE_CONFIG_DIR, home))
  // Nitro reads NITRO_PORT / NITRO_HOST before PORT / HOST.
  delete out.NITRO_PORT
  delete out.NITRO_HOST
  return out
}

// Free → null; taken → 'wherdr' when it answers like wherdr, 'other' otherwise;
// unusable for another reason (privileged port, unknown address) → { error }.
export function portTaken(port, host) {
  const { promise, resolve } = Promise.withResolvers()
  const srv = net.createServer()
  srv.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') { resolve({ error: `cannot listen on ${host}:${port} (${err.code || err.message}).` }); return }
    resolve(await probe(port, host))
  })
  srv.listen(Number(port), host, () => srv.close(() => resolve(null)))
  return promise
}

function loopback(host) {
  const h = host === '0.0.0.0' || host === '::' || !host ? '127.0.0.1' : host
  return h.includes(':') ? `[${h}]` : h
}

// 'wherdr' when a wherdr answers on the port, 'other' for anything else that
// answers, null when nothing does.
export async function probe(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${loopback(host)}:${port}/manifest.webmanifest`, { signal: AbortSignal.timeout(2000) })
    // A locked wherdr answers 401 on its API, not on its manifest.
    return res.ok && (await res.text()).includes('wherdr') ? 'wherdr' : 'other'
  } catch (e) {
    return e?.cause?.code === 'ECONNREFUSED' ? null : 'other'
  }
}

export const localUrl = port => `http://localhost:${port}`

// ------------------------------------------------------------------ output
const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const paint = code => s => color ? `\x1b[${code}m${s}\x1b[0m` : String(s)
export const c = { bold: paint('1'), dim: paint('2'), green: paint('32'), yellow: paint('33'), red: paint('31'), cyan: paint('36') }

export const say = (s = '') => process.stdout.write(`${s}\n`)
export const ok = s => say(`  ${c.green('✓')} ${s}`)
export const warn = s => say(`  ${c.yellow('!')} ${s}`)
export const bad = s => say(`  ${c.red('✗')} ${s}`)
// A labelled line of `status` / `doctor`.
export const row = (label, value) => say(`  ${c.dim(label.padEnd(9))}${value}`)

export class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code }
}
