// One-tap update (Update button of the app): runs
// detached from the server it replaces, so it outlives the restart. Installs
// the new version, restarts wherdr, waits for /api/health to report the new
// version, and goes back to the previous one when it does not. Progress goes
// to <wherdr dir>/update.json (read by the server for the app) and
// <wherdr dir>/update.log.
//
//   node updater.mjs <plan.json>
//
// The server copies this file out of the package before running it (npm and
// Homebrew replace the package folder): it imports Node built-ins only.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Plan (written by the server):
//   kind      plugin | npm-global | brew
//   from, to  installed and target versions
//   root      package folder of the running wherdr (holds bin/ and .output/)
//   dir       wherdr folder (~/wherdr): state, log, pid file
//   runtime   node (or bun) running the server
//   serverPid pid of the server to replace
//   port, host  where it answers
//   registry  npm registry (npm_config_registry, default registry.npmjs.org)
//   healthMs  how long the new version has to answer (default 60 s)

export const HEALTH_MS = 60_000

const healthHost = host => !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
// v3 reports its own version (3.0.0-dev+<commit>) and the package one in `release`.
export const healthReports = (body, version) => body?.version === version || body?.release === version
export const healthUrl = plan => `http://${healthHost(plan.host)}:${plan.port}/api/health`

// --------------------------------------------------------------- drivers
// What each install mode does to install, put in place and go back. `io.run`
// throws on a non-zero exit (the message ends with the command's output).

function pluginDriver(plan, io) {
  const staged = `${plan.root}.new`
  const previous = `${plan.root}.prev`
  return {
    // The checksummed GitHub package, unpacked next to the running copy.
    async install() {
      const tgz = path.join(plan.dir, 'update', `wherdr-${plan.to}.tgz`)
      if (!plan.releaseBase) throw new Error('Release source is missing from the update plan')
      if (!/^\d+\.\d+\.\d+$/.test(plan.to)) throw new Error('Invalid release version')
      const url = `${plan.releaseBase}/v${plan.to}/wherdr-${plan.to}.tgz`
      await io.download(url, tgz)
      await io.download(`${url}.sha256`, `${tgz}.sha256`)
      await io.verify(tgz, `${tgz}.sha256`)
      io.rm(`${tgz}.sha256`)
      io.rm(staged)
      io.mkdir(staged)
      await io.run('tar', ['-xzf', tgz, '-C', staged, '--strip-components=1'])
      io.rm(tgz)
      if (!io.exists(path.join(staged, '.output', 'server', 'index.mjs'))) throw new Error(`wherdr ${plan.to}: the package has no built server`)
      // The panel's QR code package (the plugin install copies it the same way).
      const qr = path.join(plan.root, 'node_modules', 'qrcode-terminal')
      if (io.exists(qr)) io.copy(qr, path.join(staged, 'node_modules', 'qrcode-terminal'))
    },
    // Server stopped: the previous copy is kept as <root>.prev.
    async activate() {
      io.rm(previous)
      io.rename(plan.root, previous)
      io.rename(staged, plan.root)
    },
    async rollback() {
      if (!io.exists(previous)) throw new Error(`no previous copy to go back to (${previous})`)
      io.rm(plan.root)
      io.rename(previous, plan.root)
    },
    start: () => cliStart(plan, io),
  }
}

function npmDriver(plan, io) {
  const local = path.join(path.dirname(plan.runtime), 'npm')
  const npm = io.exists(local) ? local : 'npm'
  const install = version => io.run(npm, ['install', '--global', `wherdr@${version}`, '--no-audit', '--no-fund'])
  return {
    install: () => install(plan.to),
    async activate() {},
    rollback: () => install(plan.from),
    start: () => cliStart(plan, io),
  }
}

// <prefix>/Cellar/wherdr/<version>/libexec/lib/node_modules/wherdr (the
// formula's npm install) → <prefix> and the keg <prefix>/Cellar/wherdr/<version>.
function brewDriver(plan, io) {
  const m = /^(.*)[\\/]Cellar[\\/]wherdr[\\/][^\\/]+/.exec(plan.root)
  if (!m) throw new Error(`not a Homebrew keg: ${plan.root}`)
  const keg = m[0]
  const prefix = m[1]
  const brew = path.join(prefix, 'bin', 'brew')
  const opt = path.join(prefix, 'opt', 'wherdr')
  // The old keg stays in the Cellar for the way back.
  const env = { HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ENV_HINTS: '1' }
  const optVersion = () => path.basename(io.realpath(opt))
  return {
    async install() {
      await io.run(brew, ['upgrade', 'wherdr'], env)
      const now = optVersion()
      if (now !== plan.to && !now.startsWith(`${plan.to}_`)) throw new Error(`Homebrew installed ${now}, not ${plan.to}: its formula may not offer ${plan.to} yet`)
    },
    async activate() {},
    // `brew link` (and opt/, which brew services runs) follows the newest keg:
    // the keg that does not start is removed, then the previous one is linked.
    // Homebrew then sees the previous version installed, and the update offered again.
    async rollback() {
      if (!io.exists(keg)) throw new Error(`the previous Homebrew version (${keg}) was removed: reinstall it with brew install wherdr`)
      const failed = io.realpath(opt)
      await io.run(brew, ['unlink', 'wherdr'], env)
      if (failed !== keg && path.dirname(failed) === path.dirname(keg)) io.rm(failed)
      await io.run(brew, ['link', '--overwrite', 'wherdr'], env)
    },
    async start() {
      // The service's CLI refreshes its own package. No opt lookup or duplicate
      // helper invocation can prevent the service restart.
      return io.run(brew, ['services', 'restart', 'wherdr'], env)
    },
  }
}

// `wherdr start` of the package now in place: the pid file, or the login service.
export async function refreshInstalledSkill(plan, io, root = plan.root) {
  try {
    const helper = path.join(root, 'bin', 'lib', 'install-skill.sh')
    if (io.exists(helper)) {
      await io.run('sh', [helper, 'refresh', root], { WHERDR_DIR: plan.dir }, { timeout: 5000 })
      return true
    }
  } catch {} // A skill refresh never prevents an update or rollback.
}

async function cliStart(plan, io) {
  const refreshed = await refreshInstalledSkill(plan, io)
  return io.run(plan.runtime, [path.join(plan.root, 'bin', 'wherdr.mjs'), 'start'], refreshed ? { WHERDR_SKILL_REFRESHED: '1' } : {})
}

export function driverFor(plan, io) {
  if (plan.kind === 'plugin') return pluginDriver(plan, io)
  if (plan.kind === 'npm-global') return npmDriver(plan, io)
  if (plan.kind === 'brew') return brewDriver(plan, io)
  throw new Error(`no one-tap update for ${plan.kind}`)
}

// ------------------------------------------------------- shown on the phone
// The reason of a failed start as one short sentence: the line that says why,
// without the command that reported it nor any absolute path (the whole
// reason is in update.log).
export function shortReason(reason) {
  const why = String(reason || '')
    .replace(/^.*? exited with \d+: /, '')
    .replace(/^wherdr: /, '')
    .replace(/\s*\((?:[A-Za-z]:)?[\\/][^()]*\)/g, '')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/:]+[\\/])+([^\s\\/:]+)/g, '$1')
    .replace(/[\s.]+$/, '')
  return why.length > 200 ? `${why.slice(0, 199)}…` : why
}

function didNotStart(plan, reason) {
  const why = shortReason(reason)
  if (why.startsWith(`wherdr ${plan.to} `)) return why
  return `wherdr ${plan.to} did not start${why ? `: ${why}` : ''}`
}

// ---------------------------------------------------------- state machine
// installing → restarting → checking → done; a failed install leaves the old
// server running (failed); a new version that does not start or answer goes
// back: rolling-back → rolled-back (or failed when the old one does not come back).
export async function runUpdate(plan, io) {
  const d = driverFor(plan, io)
  const healthMs = plan.healthMs ?? HEALTH_MS
  io.log(`update ${plan.from} → ${plan.to} (${plan.kind}, ${plan.root})`)
  io.state('installing')
  try { await d.install() } catch (e) {
    io.log(`install failed: ${e.message}`)
    io.state('failed', `The update could not be installed: ${e.message}. Still on ${plan.from}.`)
    return 'failed'
  }
  io.state('restarting')
  let reason = ''
  try {
    await io.stopServer()
    await d.activate()
    await d.start()
    io.state('checking')
    if (await io.healthy(plan.to, healthMs)) {
      io.log(`wherdr ${plan.to} answers: done`)
      io.state('done')
      return 'done'
    }
    reason = `wherdr ${plan.to} did not answer within ${Math.round(healthMs / 1000)} s`
  } catch (e) { reason = e.message }
  io.log(`${reason}: going back to ${plan.from}`)
  io.state('rolling-back', `${didNotStart(plan, reason)}.`)
  try {
    await io.stopServer()
    await d.rollback()
    await d.start()
    if (await io.healthy(plan.from, healthMs)) {
      io.log(`wherdr ${plan.from} answers again: rolled back`)
      io.state('rolled-back', `${didNotStart(plan, reason)}. Rolled back to ${plan.from}.`)
      return 'rolled-back'
    }
    throw new Error(`wherdr ${plan.from} did not answer either`)
  } catch (e) {
    io.log(`rollback failed: ${e.message}`)
    io.state('failed', `${didNotStart(plan, reason)}. Going back to ${plan.from} failed too: ${shortReason(e.message)}. See update.log in the wherdr folder on the server.`)
    return 'failed'
  }
}

// ------------------------------------------------------------- real I/O
const sleep = ms => new Promise(r => setTimeout(r, ms))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function realIo(plan, now = Date.now) {
  const stateFile = path.join(plan.dir, 'update.json')
  const logFile = path.join(plan.dir, 'update.log')
  const startedAt = now()
  const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) } catch {} }
  // The commands see the runtime first on the PATH (npm's `#!/usr/bin/env node`).
  const PATH = `${path.dirname(plan.runtime)}${path.delimiter}${process.env.PATH || ''}`
  return {
    log,
    state(state, message) {
      const job = { state, from: plan.from, to: plan.to, mode: plan.kind, startedAt, updatedAt: now(), ...(message ? { message } : {}) }
      writeFileSync(`${stateFile}.tmp`, `${JSON.stringify(job)}\n`)
      renameSync(`${stateFile}.tmp`, stateFile)
    },
    run(cmd, args, env = {}, { timeout } = {}) {
      log(`$ ${[cmd, ...args].join(' ')}`)
      const { promise, resolve, reject } = Promise.withResolvers()
      const child = spawn(cmd, args, { cwd: plan.dir, env: { ...process.env, PATH, ...env }, detached: Boolean(timeout), stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = timeout ? setTimeout(() => {
        // The shell's own children must not keep copying or hold log pipes open.
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        reject(new Error(`${path.basename(cmd)} timed out after ${timeout} ms`))
      }, timeout) : undefined
      let out = ''
      const keep = (b) => { out = (out + b).slice(-4000); try { appendFileSync(logFile, b) } catch {} }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      child.on('error', e => { clearTimeout(timer); reject(new Error(`${path.basename(cmd)}: ${e.message}`)) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve(out)
        // The lines that say what went wrong (`wherdr: …`, `Error: …`), not a stack trace.
        const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
        const why = lines.filter(l => /^(wherdr: |error\b|\w*Error: )/i.test(l)).slice(0, 2)
        const tail = (why.length ? why : lines.slice(-1)).join(' / ')
        reject(new Error(`${path.basename(cmd)} ${path.basename(args[0] ?? '')} exited with ${code}${tail ? `: ${tail}` : ''}`))
      })
      return promise
    },
    async download(url, file) {
      log(`GET ${url}`)
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    },
    verify(file, checksum) {
      const expected = readFileSync(checksum, 'utf8').trim().split(/\s+/)[0]
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (!/^[a-f0-9]{64}$/.test(expected || '') || actual !== expected) throw new Error('Release SHA-256 mismatch')
    },
    // The server being replaced, then whatever `wherdr start` left (pid file).
    async stopServer() {
      const pids = [plan.serverPid]
      try { pids.push(Number(readFileSync(path.join(plan.dir, 'wherdr.pid'), 'utf8').trim())) } catch {}
      for (const pid of new Set(pids.filter(p => p && p !== process.pid && alive(p)))) {
        log(`stopping pid ${pid}`)
        try { process.kill(pid, 'SIGTERM') } catch {}
        // 25 s: the server first waits for a merge that runs (server/plugins/pm.ts).
        for (let i = 0; i < 100 && alive(pid); i++) await sleep(250)
        if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch {}
      }
      rmSync(path.join(plan.dir, 'wherdr.pid'), { force: true })
    },
    async healthy(version, ms) {
      const until = now() + ms
      const get = async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null }
      }
      while (now() < until) {
        try {
          const health = await get(healthUrl(plan))
          if (healthReports(health.body, version)) return true
          // Versions up to 1.3.1 have no /api/health: their version is in
          // /api/update (unless the app is locked).
          if (health.body?.version === undefined && (await get(healthUrl(plan).replace(/health$/, 'update'))).body?.current === version) return true
        } catch {}
        await sleep(1000)
      }
      return false
    },
    exists: p => existsSync(p),
    rm: p => rmSync(p, { recursive: true, force: true }),
    mkdir: p => mkdirSync(p, { recursive: true }),
    rename: (a, b) => renameSync(a, b),
    copy: (a, b) => cpSync(a, b, { recursive: true }),
    realpath: p => realpathSync(p),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const io = realIo(plan)
  runUpdate(plan, io).then(r => process.exit(r === 'done' ? 0 : 1), (e) => {
    io.log(`updater crashed: ${e?.stack || e}`)
    try { io.state('failed', `The updater crashed: ${e?.message || e}`) } catch {}
    process.exit(1)
  })
}
