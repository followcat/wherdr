// wherdr commands: run in the foreground, or start / stop / status a
// background server whose pid and log live in ~/wherdr, plus logs, open,
// phone, service and doctor.
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, watchFile, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MIGRATION_GUIDE, checkCore, missingHcSocket } from './hc.mjs'
import { BIN, CliError, ROOT, SERVER, VERSION, bad, c, homebrewInstall, localUrl, ok, portTaken, probe, row, say, serverEnv, settingsFile, warn, wherdrDir, withSettings } from './core.mjs'
import { RUNTIME_HELP, findRuntime, isBun, runtimeOk, runtimeVersion, temporaryInstall } from './runtime.mjs'
import { brewDoctor, brewRedirect, brewService, brewStatusRows } from './brew.mjs'
import { controlService, enableLinger, installService, lingerOn, serviceFile, servicePlatform, serviceState, uninstallService } from './service.mjs'
import { loginShellPath, userPath } from './userpath.mjs'
import { removeLegacySkill } from './skill.mjs'
import { LINKS, inspect, publishCommand, reachable } from './tailnet.mjs'

export const HELP = `${'wherdr'}: your coding agents on herdr-core (hc), from your phone and browser.

Usage: wherdr [command] [options]

Commands:
  run                Run in the foreground (default; Ctrl+C stops it)
  start              Start in the background (pid and log in ~/wherdr)
  stop | restart     Stop or restart the background wherdr (or the login service)
  status             Is wherdr running, where, and how
  logs [-f]          Last lines of the log (-n <lines>); -f follows it
  open               Open wherdr in the browser
  phone              Phone state, the app's phone setup page, QR code once it answers
  service install    Start wherdr at login (macOS LaunchAgent, Linux systemd --user)
  service uninstall  Remove it
  dictation fetch    Download the on-device dictation files into <data dir>/models
                     (default: runtime and the phone model; or name sets, or all)
  doctor             Check Node/Bun, herdr-core (hc) and its socket, the port and the service
  pm <command>       A project coordinator's board commands (token in its environment; see its AGENTS.md)

Options:
  --hc-socket <path>  Socket of the herdr-core (hc) session to drive (required, or $HC_SOCKET)
  --port <n>          Listening port (default: 7683, or $PORT)
  --host <addr>       Listening address (default: 127.0.0.1, or $HOST): loopback or this machine's tailnet address.
  --data-dir <dir>    Passkeys, push keys, settings and dictation files (default: ~/wherdr/data, or $DATA_DIR)
  -v, --version       Print the version
  -h, --help          Print this help

Settings: environment variables (HC_SOCKET, APP_URL, HOST_LABEL…), or KEY=VALUE lines in
~/wherdr/wherdr.env. Guide: https://wherdr.dev`

const files = dir => ({ pid: path.join(dir, 'wherdr.pid'), log: path.join(dir, 'wherdr.log'), last: path.join(dir, 'wherdr.json') })

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

// Command context: options > environment > settings saved by the last start
// or service install > defaults.
export function context(opts, env = process.env, home = os.homedir()) {
  const dir = wherdrDir(env, home)
  const full = withSettings(env, dir)
  const saved = readJson(files(dir).last)
  const merged = {
    port: opts.port ?? full.PORT ?? saved.port,
    host: opts.host ?? full.HOST ?? saved.host,
    dataDir: opts.dataDir ?? full.DATA_DIR ?? saved.dataDir,
    hcSocket: opts.hcSocket ?? full.HC_SOCKET ?? saved.hcSocket,
  }
  const senv = serverEnv(merged, full, home)
  return { dir, files: files(dir), env: senv, port: senv.PORT, host: senv.HOST, url: localUrl(senv.PORT) }
}

export function remember(ctx) {
  mkdirSync(ctx.dir, { recursive: true })
  const { PORT: port, HOST: host, DATA_DIR: dataDir, HC_SOCKET: hcSocket } = ctx.env
  writeFileSync(ctx.files.last, `${JSON.stringify({ port, host, dataDir, hcSocket }, null, 2)}\n`)
}

// wherdr 3 never starts without herdr-core: refuse before anything is started.
export function needCore(ctx) {
  const missing = missingHcSocket(ctx.env)
  if (missing) throw new CliError(`${missing}\n  Guide: ${path.join(ROOT, MIGRATION_GUIDE)}`)
}

// Pid of the background wherdr when it is alive and still our server.
export function livePid(pidFile) {
  let pid
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { return null }
  if (!pid) return null
  try { process.kill(pid, 0) } catch { return null }
  // Linux: /proc (busybox ps has no -p); macOS: ps.
  let cmd = ''
  try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    cmd = r.status === 0 ? r.stdout : ''
  }
  return cmd.includes('.output/server/index.mjs') ? pid : null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function tailText(file, lines, from = 0) {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  const start = Math.max(from, size - 256 * 1024)
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - start)
  readSync(fd, buf, 0, buf.length, start)
  closeSync(fd)
  return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines).join('\n')
}

function failWithLog(message, log, from) {
  const tail = tailText(log, 15, from)
  throw new CliError(`${message}${tail ? `\n  Last lines of ${log}:\n${tail.split('\n').map(l => `    ${l}`).join('\n')}` : `\n  Log: ${log}`}`)
}

async function checkPort(ctx) {
  const taken = await portTaken(ctx.port, ctx.host)
  if (taken === 'wherdr') throw new CliError(`a wherdr already runs on port ${ctx.port}: ${ctx.url} (stop it with \`wherdr stop\`, or use --port).`)
  if (taken?.error) throw new CliError(taken.error)
  if (taken) throw new CliError(`port ${ctx.port} is already taken by another program: pick another one with --port.`)
}

function needServer() {
  if (!existsSync(SERVER)) throw new CliError(`the server is missing (${SERVER}): this copy of wherdr was not built. Run \`npm run build\` in a checkout.`)
}

// ------------------------------------------------------------------- run
export async function run(opts) {
  removeLegacySkill(context(opts).env)
  needServer()
  const ctx = context(opts)
  needCore(ctx)
  if (!process.versions.bun && Number(process.versions.node.split('.')[0]) < 22) throw new CliError(`Node.js 22 or newer is required (found ${process.version}).`)
  await checkPort(ctx)
  say(`${c.bold('wherdr')} ${VERSION} · ${c.cyan(ctx.url)} · data ${ctx.env.DATA_DIR} · hc ${ctx.env.HC_SOCKET}`)
  // Bun runs the server (WebSockets, web-push, passkeys, herdr-core's Unix socket),
  // but Node stays the reference runtime: use it when it is there.
  if (process.versions.bun && ctx.env.WHERDR_RUNTIME !== 'bun') {
    const node = findRuntime({ ...ctx.env, WHERDR_RUNTIME: '' })
    if (node && !isBun(node)) {
      const child = spawn(node, [SERVER], { env: ctx.env, stdio: 'inherit' })
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
      child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)))
      return
    }
  }
  Object.assign(process.env, ctx.env)
  for (const k of ['NITRO_PORT', 'NITRO_HOST']) delete process.env[k]
  await import(pathToFileURL(SERVER).href)
}

// ----------------------------------------------------------------- start
export async function start(opts) {
  removeLegacySkill(context(opts).env)
  needServer()
  const ctx = context(opts)
  needCore(ctx)
  const brew = brewService()
  if (brew) {
    const redirect = brewRedirect('start', brew)
    if (redirect) throw new CliError(redirect)
    ok(`wherdr already runs as a Homebrew service: ${c.cyan(ctx.url)}`)
    return
  }
  const svc = serviceState()
  if (svc.installed) {
    if (svc.running && await probe(ctx.port, ctx.host)) { ok(`wherdr already runs as a login service: ${c.cyan(ctx.url)}`); return }
    controlService('start')
    if (await waitUp(ctx, () => true)) { ok(`wherdr started (login service) · ${c.cyan(ctx.url)}`); return }
    failWithLog(`the login service did not answer on port ${ctx.port} after 45 s.`, ctx.files.log, 0)
  }
  const pid = livePid(ctx.files.pid)
  if (pid) { ok(`wherdr already runs in the background (pid ${pid}): ${c.cyan(ctx.url)}`); return }
  await checkPort(ctx)
  const runtime = findRuntime(ctx.env)
  if (!runtime) throw new CliError(RUNTIME_HELP)
  mkdirSync(ctx.dir, { recursive: true })
  const from = existsSync(ctx.files.log) ? statSync(ctx.files.log).size : 0
  const log = openSync(ctx.files.log, 'a')
  // The runtime's folder first: tools the server starts find the same node.
  const env = { ...ctx.env, PATH: `${path.dirname(runtime)}${path.delimiter}${ctx.env.PATH || ''}` }
  const child = spawn(runtime, [SERVER], { cwd: ctx.dir, env, detached: true, stdio: ['ignore', log, log] })
  closeSync(log)
  child.unref()
  writeFileSync(ctx.files.pid, `${child.pid}\n`)
  remember(ctx)
  let exited = false
  child.on('exit', () => { exited = true })
  if (await waitUp(ctx, () => !exited)) {
    ok(`wherdr started · ${c.cyan(ctx.url)}`)
    say(c.dim(`    pid ${child.pid} · ${runtime} · log ${ctx.files.log}`))
    return
  }
  try { unlinkSync(ctx.files.pid) } catch {}
  if (exited) failWithLog(`wherdr exited at startup (${runtime}).`, ctx.files.log, from)
  try { process.kill(child.pid) } catch {}
  failWithLog(`wherdr (pid ${child.pid}) did not answer on port ${ctx.port} after 45 s; stopped.`, ctx.files.log, from)
}

// "Started" only once the process is alive and the port answers.
async function waitUp(ctx, alive, seconds = 45) {
  for (let i = 0; i < seconds * 4; i++) {
    if (!alive()) return false
    if (await probe(ctx.port, ctx.host) === 'wherdr') return true
    await sleep(250)
  }
  return false
}

// ------------------------------------------------------------------ stop
export async function stop(opts, { quiet = false } = {}) {
  const ctx = context(opts)
  const brew = brewService()
  const redirect = brewRedirect('stop', brew)
  if (redirect) {
    if (quiet) return false
    throw new CliError(redirect)
  }
  const svc = serviceState()
  if (svc.installed && svc.running) {
    controlService('stop')
    if (!quiet) ok('wherdr stopped (login service; it starts again at the next login).')
    return true
  }
  const pid = livePid(ctx.files.pid)
  if (pid) {
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0) } catch { break }
      await sleep(250)
    }
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {}
    try { unlinkSync(ctx.files.pid) } catch {}
    if (!quiet) ok(`wherdr stopped (pid ${pid}).`)
    return true
  }
  if (quiet) return false
  const other = await probe(ctx.port, ctx.host)
  if (other) warn(`the wherdr on port ${ctx.port} was not started by \`wherdr start\` (npm start, a terminal…): left running.`)
  else say('wherdr is not running.')
  return false
}

export async function restart(opts) {
  const redirect = brewRedirect('restart', brewService())
  if (redirect) throw new CliError(redirect)
  const svc = serviceState()
  if (svc.installed) {
    const ctx = context(opts)
    controlService('restart')
    await sleep(500)
    if (await waitUp(ctx, () => true)) { ok(`wherdr restarted (login service) · ${c.cyan(ctx.url)}`); return }
    failWithLog(`the login service did not answer on port ${ctx.port} after 45 s.`, ctx.files.log, 0)
  }
  await stop(opts, { quiet: true })
  await start(opts)
}

// ---------------------------------------------------------------- status
export async function status(opts) {
  const ctx = context(opts)
  const answer = await probe(ctx.port, ctx.host)
  const pid = livePid(ctx.files.pid)
  const svc = serviceState()
  const brew = brewService()
  const hb = brew && brewStatusRows(brew)
  say(`${c.bold('wherdr')} ${VERSION}`)
  row('Address', answer === 'wherdr' ? `${c.green('●')} ${c.cyan(ctx.url)} answers` : answer ? `${c.yellow('●')} port ${ctx.port} is taken by another program` : `${c.dim('○')} port ${ctx.port} free: not running`)
  row('Process', hb?.process ? hb.process : svc.running ? 'login service' : pid ? `pid ${pid} (wherdr start)` : answer === 'wherdr' ? 'started another way (npm start, a terminal…)' : 'none')
  row('Service', hb ? hb.service : svc.installed ? `installed (${serviceFile()})${svc.running ? '' : ', not running'}` : 'not installed · wherdr service install')
  row('Data', ctx.env.DATA_DIR)
  row('Log', hb ? hb.log : ctx.files.log)
  row('hc', ctx.env.HC_SOCKET || c.yellow('HC_SOCKET not set: wherdr cannot start (--hc-socket <path>)'))
  if (!answer) say(c.dim(hb ? hb.hint : '\n  Start it: wherdr start (background) or wherdr (foreground).'))
}

// ------------------------------------------------------------------ logs
export async function logs(opts) {
  const ctx = context(opts)
  const log = brewService()?.log ?? ctx.files.log
  if (!existsSync(log)) { say(`No log yet (${log}).`); if (!opts.follow) return }
  const text = tailText(log, Number(opts.lines ?? 50))
  if (text) say(text)
  if (!opts.follow) return
  let pos = existsSync(log) ? statSync(log).size : 0
  say(c.dim(`— following ${log} (Ctrl+C to stop)`))
  watchFile(log, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0
    if (cur.size === pos) return
    const fd = openSync(log, 'r')
    const buf = Buffer.alloc(cur.size - pos)
    readSync(fd, buf, 0, buf.length, pos)
    closeSync(fd)
    pos = cur.size
    process.stdout.write(buf)
  })
  await new Promise(() => {})
}

// ------------------------------------------------------------------ open
export function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const r = spawnSync(cmd, [url], { stdio: 'ignore' })
  return r.status === 0
}

// Does the published address answer? 'host' means wherdr answers but does not
// know that name yet (`tailscale serve` run a moment ago): a local request to
// /api/phone makes it read Tailscale again and adopt the address
// (server/utils/phone.ts), then it is asked again. `reach` / `allow` are
// injectable for the tests.
export async function phoneReach(localUrl, phoneUrl, { reach = reachable, allow = url => fetch(`${url}/api/phone`).catch(() => {}), timeoutMs = 8000 } = {}) {
  let r = await reach(phoneUrl, timeoutMs)
  if (r === 'host') { await allow(localUrl); r = await reach(phoneUrl, timeoutMs) }
  return r
}

// The address to open: the tailnet one when wherdr is already published there
// and it answers (passkeys are tied to the address they were created on),
// else the local one.
export async function openAddress(localUrl, port, { net = inspect, ...probes } = {}) {
  const phone = (await net(port)).phone
  if (!phone?.served) return localUrl
  return await phoneReach(localUrl, phone.url, { timeoutMs: 5000, ...probes }) === 'ok' ? phone.url.replace(/\/$/, '') : localUrl
}

export async function open(opts) {
  const ctx = context(opts)
  if (await probe(ctx.port, ctx.host) !== 'wherdr') warn(`wherdr does not answer on port ${ctx.port}: run \`wherdr start\` first.`)
  const url = await openAddress(ctx.url, ctx.port)
  if (openUrl(url)) ok(`opened ${c.cyan(url)}`)
  else say(url)
}

// ----------------------------------------------------------------- phone
// The phone setup lives in the app (Settings › Phone: publish on the tailnet,
// live check, APP_URL, QR code). Here: the real state, the command that
// publishes wherdr when it is not (a server without a screen has no browser
// for that page; wherdr adopts the address by itself), the link to the page,
// and the QR code only when the address answers.
export const phoneSetupUrl = url => `${url}/#/settings?section=phone`

async function qr(text) {
  try {
    const { default: qrcode } = await import('qrcode-terminal')
    const { promise, resolve } = Promise.withResolvers()
    qrcode.generate(text, { small: true }, resolve)
    return await promise
  } catch { return null }
}

// Why a published address is not usable yet, for `wherdr phone`.
export function phoneRefusal(reach, phone, running) {
  if (reach !== 'host') return running ? 'does not answer yet (the HTTPS certificate can take a minute)' : 'wherdr is not running'
  if (phone.funnel) return 'also open to the Internet by `tailscale funnel`, which wherdr never enables: turn the funnel off'
  return 'wherdr refuses it: it could not read `tailscale serve status` itself (is `tailscale` on the PATH of the wherdr server?)'
}

export async function phone(opts) {
  const ctx = context(opts)
  const setup = phoneSetupUrl(ctx.url)
  say(c.bold('wherdr · phone'))
  say()
  const local = await probe(ctx.port, ctx.host)
  if (local === 'wherdr') ok(`wherdr answers on ${c.cyan(ctx.url)}`)
  else warn('wherdr is not running: run `wherdr start` first.')
  const net = await inspect(ctx.port)
  let reach = null
  if (!net.installed) warn(`Tailscale is not installed: ${c.cyan(LINKS.download)}`)
  else if (!net.connected || !net.phone) warn('Tailscale is not connected on this machine.')
  else if (!net.phone.served) {
    warn(`${c.bold('Not reachable from your phone yet')}: wherdr is not published on your tailnet.`)
    say(`    Publish it (private, only your Tailscale devices): ${c.cyan(publishCommand(ctx.port))}`)
    say('    wherdr enables that address by itself; run `wherdr phone` again for its QR code.')
  } else {
    reach = await phoneReach(ctx.url, net.phone.url)
    if (reach === 'ok') ok(`${c.cyan(net.phone.url)} answers`)
    else warn(`${c.bold('Not reachable from your phone yet')}: ${net.phone.url} is published but ${phoneRefusal(reach, net.phone, local === 'wherdr')}.`)
  }
  if (reach === 'ok') {
    const code = await qr(net.phone.url)
    if (code) { say(); say(code.split('\n').map(l => `  ${l}`).join('\n')) }
    say(`  ${code ? 'Scan it with the iPhone camera' : `Open ${c.cyan(net.phone.url)} on the iPhone`}, then Share → Add to Home Screen.`)
    say('  In the app: Settings → Enable notifications, then Security → Enable passkey lock.')
    say(`  Enable the lock on ${c.cyan(net.phone.url)}, not on localhost: a passkey is tied to its address.`)
  }
  say()
  say(`  Set up your phone in the app, on this computer: ${c.cyan(setup)}`)
}

// --------------------------------------------------------------- service
export async function service(opts) {
  if (opts.sub === 'install') removeLegacySkill(context(opts).env)
  const ctx = context(opts)
  if (opts.sub === 'uninstall') {
    const file = uninstallService()
    if (file) ok(`login service removed (${file}); wherdr is stopped.`)
    else say('No login service installed.')
    return
  }
  if (!servicePlatform()) throw new CliError(`no login service on ${process.platform}: keep wherdr running with your own service manager.`)
  if (servicePlatform() === 'systemd' && spawnSync('systemctl', ['--user', '--version']).status !== 0) {
    throw new CliError('systemd --user is not available here: keep wherdr running with your own service manager (or wherdr start).')
  }
  needServer()
  needCore(ctx)
  const bin = realpathSync(BIN)
  if (temporaryInstall(bin)) {
    throw new CliError(`this wherdr runs from a temporary npx / bunx / pnpm dlx folder (${path.dirname(path.dirname(bin))}).
  Install it for good first, then run the service command again:
    npm install -g wherdr      (or: bun add -g wherdr, pnpm add -g wherdr)
    wherdr service install`)
  }
  // A LaunchAgent pointing into Cellar/wherdr/<version> would break at the next `brew upgrade`.
  if (homebrewInstall(bin)) throw new CliError(brewRedirect('service', {}))
  const runtime = findRuntime(ctx.env)
  if (!runtime) throw new CliError(RUNTIME_HELP)
  // The background server of `wherdr start` would hold the port.
  const stopped = await stop(opts, { quiet: true })
  if (stopped) ok('background wherdr stopped (the service takes over).')
  await checkPort(ctx)
  remember(ctx)
  const { args, env } = serviceSpec(ctx, bin, runtime, servicePath(runtime, ctx.env))
  let file
  try {
    file = installService({ runtime, args, env, log: ctx.files.log })
  } catch (e) {
    // wherdr was stopped above for the service to take over: started again,
    // as it was (the previous service, or in the background).
    let back = ''
    if (stopped) {
      try {
        await start(opts)
        back = '\n  wherdr was started again as before.'
      } catch (err) { back = `\n  wherdr could not be started again: ${err.message}` }
    }
    throw new CliError(`${e.message}${back}`)
  }
  ok(`login service installed: ${file}`)
  say(c.dim(`    ${runtime} ${args.join(' ')}`))
  if (await waitUp(ctx, () => true)) ok(`wherdr runs: ${c.cyan(ctx.url)} (and starts at every login)`)
  else failWithLog(`the service did not answer on port ${ctx.port} after 45 s.`, ctx.files.log, 0)
  if (servicePlatform() === 'systemd') {
    // Without lingering, systemd stops the user's services at logout (and
    // starts them only at the next login): a server reached over SSH or from
    // the phone would go away. Allowed for one's own user, without sudo, on
    // most systems; otherwise the command to run is printed.
    const linger = enableLinger()
    if (linger.ok) ok(linger.already ? 'lingering is on: wherdr keeps running when you log out.' : 'lingering enabled (loginctl enable-linger): wherdr keeps running when you log out.')
    else warn(`lingering is off: wherdr stops when you log out. To keep it running, run once: ${c.cyan(`sudo loginctl enable-linger ${os.userInfo().username}`)}`)
  }
}

// Command line and environment of the login service. launchd and systemd do
// not see the shell's PATH: the service gets the user's (PATH), so agents in
// user folders are found by the Board's commands.
export function serviceSpec(ctx, bin, runtime, PATH) {
  const args = [bin, 'run', '--port', ctx.port, '--host', ctx.host, '--data-dir', ctx.env.DATA_DIR]
  const env = { PATH, WHERDR_DIR: ctx.dir, WHERDR_RUNTIME: runtime }
  for (const k of ['HC_SOCKET', 'APP_URL', 'HOST_LABEL', 'CLAUDE_CONFIG_DIR', 'WHERDR_SKILL', 'HERDR_PROJECTS_DATA_DIR']) if (ctx.env[k]) env[k] = ctx.env[k]
  return { args, env }
}

// The service's PATH: the runtime's folder, then the user's PATH (the login
// shell's, asked once, herdr-projects' record and the usual folders).
export function servicePath(runtime, env = process.env, { home = os.homedir(), login = loginShellPath(env), exists } = {}) {
  return userPath({ env, home, first: [path.dirname(runtime)], login, exists })
}

// ------------------------------------------------------------- dictation
// The on-device dictation files (scripts/fetch-dictation-files.mjs, shipped in
// the package), into the same DATA_DIR as the server: it serves them at /models/.
export const DICTATION_SCRIPT = path.join(ROOT, 'scripts', 'fetch-dictation-files.mjs')

export async function dictation(opts, { log = say, load = () => import(pathToFileURL(DICTATION_SCRIPT).href) } = {}) {
  const ctx = context(opts)
  const { fetchSets, setsOf } = await load()
  let names
  try { names = setsOf(opts.sets ?? []) } catch (e) { throw new CliError(e.message, 2) }
  const modelsDir = path.join(ctx.env.DATA_DIR, 'models')
  await fetchSets(modelsDir, names, { log })
  ok(`dictation files in place: ${modelsDir}`)
}

// wherdr 2's panel was the screen of the Herdr plugin; wherdr 3 is not a Herdr plugin.
export function panel() {
  throw new CliError('`wherdr panel` is gone: it was the screen of the wherdr 2 Herdr plugin, and wherdr 3 runs on herdr-core.\n  Use `wherdr status`, `wherdr open` and `wherdr phone` instead.')
}

// ---------------------------------------------------------------- doctor
// herdr-core rows of `doctor`: [level, text], level ok | warn | fail.
export async function coreRows(env) {
  const sock = env.HC_SOCKET
  if (!sock) return [['fail', missingHcSocket(env)]]
  const rows = [['ok', `HC_SOCKET: ${sock}`]]
  try {
    const core = await checkCore(sock)
    rows.push(['ok', `herdr-core ${core.version}: protocol generation ${core.generation}, all required methods`])
  } catch (e) {
    const kind = e?.kind
    rows.push(['fail', kind === 'unavailable' ? `herdr-core socket does not connect: ${sock}. Start hc, or fix --hc-socket.`
      : kind === 'incompatible' && e.hint ? `herdr-core is missing required methods: ${e.hint}. Update hc.`
        : `herdr-core: ${e?.message || e}${e?.hint ? ` (${e.hint})` : ''}`])
  }
  return rows
}

export async function doctor(opts) {
  const ctx = context(opts)
  let problems = 0
  const fail = (s) => { problems++; bad(s) }
  say(`${c.bold('wherdr doctor')} · ${VERSION}`)
  say()
  const here = process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`
  const runtime = findRuntime(ctx.env)
  if (runtime) ok(`Runtime: ${runtime} (${runtimeVersion(runtime)})${ctx.env.WHERDR_RUNTIME && !runtimeOk(ctx.env.WHERDR_RUNTIME) ? c.yellow(` · WHERDR_RUNTIME=${ctx.env.WHERDR_RUNTIME} is not usable`) : ''}`)
  else fail(`No Node.js 22+ or Bun found (this command runs on ${here}). ${RUNTIME_HELP}`)
  if (temporaryInstall(BIN)) warn('Running from a temporary npx / bunx / pnpm dlx folder: `npm install -g wherdr` for `wherdr service install`.')

  for (const [level, text] of await coreRows(ctx.env)) ({ ok, warn, fail })[level](text)

  const answer = await probe(ctx.port, ctx.host)
  const taken = answer ? null : await portTaken(ctx.port, ctx.host)
  if (answer === 'wherdr') ok(`Port ${ctx.port}: wherdr answers (${ctx.url})`)
  else if (answer || taken) fail(`Port ${ctx.port}: ${taken?.error || 'taken by another program'}. Use --port.`)
  else warn(`Port ${ctx.port}: free, wherdr is not running (${homebrewInstall(BIN) ? 'brew services start wherdr' : 'wherdr start'}).`)

  const svc = serviceState()
  const brew = brewService()
  if (brew) {
    const [level, text] = brewDoctor(brew)
    ;({ ok, warn, fail })[level](text)
  } else if (!servicePlatform()) warn(`Login service: not available on ${process.platform}.`)
  else if (!svc.installed) warn('Login service: not installed (wherdr service install starts wherdr at login).')
  else if (svc.running) ok(`Login service: running (${serviceFile()})`)
  else fail(`Login service: installed but not running (${serviceFile()}). See wherdr logs.`)
  if (!brew && svc.installed && servicePlatform() === 'systemd' && !lingerOn()) {
    warn(`Lingering is off: wherdr stops when you log out (sudo loginctl enable-linger ${os.userInfo().username}).`)
  }

  try {
    mkdirSync(ctx.env.DATA_DIR, { recursive: true })
    accessSync(ctx.env.DATA_DIR, constants.W_OK)
    ok(`Data folder: ${ctx.env.DATA_DIR}`)
  } catch { fail(`Data folder not writable: ${ctx.env.DATA_DIR}`) }

  if (/^https:\/\//.test(ctx.env.APP_URL || '')) ok(`APP_URL: ${ctx.env.APP_URL}`)
  else warn('APP_URL not set: no phone notifications. See wherdr phone.')

  say()
  if (problems) throw new CliError(`${problems} problem(s) found.`)
  say(`  ${c.green('All good.')}`)
}
