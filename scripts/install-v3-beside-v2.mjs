#!/usr/bin/env node
// Installs wherdr v3 (herdr-core backend) next to a running wherdr v2, then
// imports what v3 can use (scripts/v2-import.mjs). Never stops, changes or
// writes anything of v2. Linux with systemd --user. Run through
// scripts/install-v3-beside-v2.sh; `--help` lists the options.
//
// Output for people and agents: one line per step ("STEP", "OK", "SKIP"),
// "ERROR <code>: <what>" and "NEXT: <what the user must do>". --json prints
// one summary object on stdout (the lines go to stderr).
// Exit codes: 0 done (or plan printed), 2 bad usage, 3 missing prerequisite,
// 4 conflict (port, folder, service, tailscale entry taken), 5 a step failed,
// 6 installed, but something is left for the user (see NEXT lines).
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import v8 from 'node:v8'
import { fileURLToPath } from 'node:url'
import { defaultRun, describeV2, detectV2, runImport } from './v2-import.mjs'

export const EXIT = { ok: 0, usage: 2, missing: 3, conflict: 4, failed: 5, todo: 6 }
const MANIFEST = 'install-manifest.json'
// The repository this script comes from (package.json's repository field).
const REPO = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).repository.url.replace(/^git\+/, '') }
  catch { return '' }
})()
const HELP = `Usage: install-v3-beside-v2.sh [--yes] [options]

Without --yes, prints the plan and changes nothing (--dry-run says so explicitly).
  --yes                 apply the plan
  --uninstall           remove what this installer created (with --yes; --keep-data keeps <dir>/data)
  --json                one JSON summary on stdout
  --dir <dir>           v3 folder (default ~/wherdr-v3: src/, data/, update.sh)
  --name <name>         service name (default wherdr-v3; the hc service is <name>-hc)
  --port <n>            v3's local port (default 7684)
  --https-port <n>      tailscale serve HTTPS port (default: the first free one from 8104); --no-tailscale to skip
  --hc-session <s>      herdr-core session (default: default); --hc-bin <path>
  --repo <url|path>     wherdr repository (default: package.json's repository); --branch <b> (v3)
  --skip-import         do not import from v2
  --auto-deploy <url>   never build here: install prebuilt v3 builds from <url> (scripts/v3-builder.sh
                        on another machine) and keep up with them: <name>-deploy.timer, every 3 min
  v2 (default: found here): --v2-dir <dir> --v2-unit <file> --herdr-projects <dir> --herdr-bin <path>`

export function parseArgs(argv, home = os.homedir()) {
  const o = { dir: path.join(home, 'wherdr-v3'), name: 'wherdr-v3', port: '7684', httpsPort: null, hcSession: 'default', repo: REPO, branch: 'v3' }
  const flags = { '--yes': 'yes', '--dry-run': 'dryRun', '--json': 'json', '--uninstall': 'uninstall', '--keep-data': 'keepData', '--no-tailscale': 'noTailscale', '--skip-import': 'skipImport', '--help': 'help', '-h': 'help' }
  const values = { '--dir': 'dir', '--name': 'name', '--port': 'port', '--https-port': 'httpsPort', '--hc-session': 'hcSession', '--hc-bin': 'hcBin', '--repo': 'repo', '--branch': 'branch', '--v2-dir': 'v2Dir', '--v2-unit': 'unit', '--herdr-projects': 'hpDir', '--herdr-bin': 'herdrBin', '--auto-deploy': 'deploySource' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags[a]) o[flags[a]] = true
    else if (values[a] && argv[i + 1] !== undefined) o[values[a]] = argv[++i]
    else throw new Error(`unknown option: ${a}`)
  }
  if (o.dryRun) o.yes = false
  for (const k of ['port', 'httpsPort']) if (o[k] !== null && (!/^\d+$/.test(o[k]) || +o[k] < 1 || +o[k] > 65535)) throw new Error(`--${k === 'port' ? 'port' : 'https-port'} must be a port number`)
  if (!/^[\w.-]{1,40}$/.test(o.name)) throw new Error('--name: letters, digits, . _ -')
  if (!/^[\w.-]{1,32}$/.test(o.hcSession)) throw new Error('--hc-session: letters, digits, . _ -')
  if (o.deploySource !== undefined && !/^(https?|file):\/\/\S+$|^\/\S*$/.test(o.deploySource)) throw new Error('--auto-deploy: an http(s):// URL or a folder')
  o.dir = path.resolve(o.dir.replace(/^~(?=\/|$)/, home))
  return o
}

// systemd quoting: double quotes, \ and " escaped, % doubled.
const sq = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const UNSET = 'UnsetEnvironment=CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT HC_SCOPE HC_TERMINAL_ID HC_TERMINAL_SOCKET'

// The hc session as a service: started from systemd, never from the shell
// (or agent) running this installer, so no CLAUDE_CODE_CHILD_SESSION leaks in.
export function hcUnit({ hc, session, pathEnv }) {
  return `# herdr-core session for wherdr v3 (install-v3-beside-v2). Remove with: install-v3-beside-v2.sh --uninstall --yes
[Unit]
Description=herdr-core session ${session} for wherdr v3

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${sq(`HC_SESSION=${session}`)}
Environment=${sq(`PATH=${pathEnv}`)}
${UNSET}
ExecStart=${sq(hc)} server start
ExecStop=${sq(hc)} server stop

[Install]
WantedBy=default.target
`
}

// The resource protections of v2's unit, so that both survive a memory or CPU
// squeeze the same way; sensible defaults when v2's unit has none.
export const PROTECT_DEFAULTS = { OOMScoreAdjust: '-900', MemoryLow: '256M', CPUWeight: '200' }
export function unitProtections(text) {
  const out = { ...PROTECT_DEFAULTS }
  const from = []
  for (const k of Object.keys(out)) {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)\\s*$`, 'm').exec(String(text || ''))
    if (m) { out[k] = m[1]; from.push(k) }
  }
  return { ...out, from: from.length ? "v2's unit" : 'defaults' }
}

// herdr-core's build name for this machine (releases.herdr.dev): linux-aarch64, linux-x86_64…
export const hcTarget = (platform = process.platform, arch = process.arch) => `${platform}-${{ arm64: 'aarch64', x64: 'x86_64' }[arch] || arch}`
export const HC_INSTALL = 'curl -fsSL https://releases.herdr.dev/core/install.sh | sh'

// The Nuxt build needs about 1.5 GB of heap; Node's default is smaller on
// small machines (574 MB on a 4 GB Raspberry Pi), and the build then dies.
export const BUILD_HEAP_MB = 1536
export function buildTuning(heapLimit = v8.getHeapStatistics().heap_size_limit, ionice = true) {
  if (heapLimit >= BUILD_HEAP_MB * 1024 * 1024) return null
  return { heapMb: Math.round(heapLimit / 1048576), nodeOptions: `--max-old-space-size=${BUILD_HEAP_MB}`, prefix: ionice ? 'nice -n 19 ionice -c3' : 'nice -n 19' }
}
export function buildCommand(src, tuning) {
  const p = tuning ? `${tuning.prefix} ` : ''
  const env = tuning ? `export NODE_OPTIONS="${'$'}{NODE_OPTIONS:-} ${tuning.nodeOptions}"; ` : ''
  return `cd ${JSON.stringify(src)} && ${env}{ ${p}npm ci --no-audit --no-fund --loglevel=error && ${p}npm run build; } > ../build.log 2>&1`
}

// The tailscale serve HTTPS port: the one asked for, else the one this v3 already
// has (a re-run), else the first one from 8104 that no serve entry uses.
export function pickHttpsPort({ entries = [], port, wanted = null, previous = null, start = 8104 }) {
  const ours = e => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(e.proxy)
  const taken = new Set(entries.map(e => e.https))
  let free = start
  while (taken.has(String(free))) free++
  free = String(free)
  const pick = wanted || previous || entries.find(ours)?.https || free
  const entry = entries.find(e => e.https === pick)
  if (entry && !ours(entry)) return { port: pick, free, conflict: entry }
  return { port: pick, free, done: !!entry }
}

export function v3Unit({ node, dir, socket, port, hcService, appUrl = null, protect = PROTECT_DEFAULTS }) {
  return `# wherdr v3 beside v2 (install-v3-beside-v2). Remove with: install-v3-beside-v2.sh --uninstall --yes
[Unit]
Description=wherdr v3 (herdr-core), beside wherdr v2
After=network.target${hcService ? ` ${hcService}` : ''}
${hcService ? `Wants=${hcService}\n` : ''}
[Service]
Type=simple
WorkingDirectory=${dir}/src
${['NODE_ENV=production', `HC_SOCKET=${socket}`, 'HOST=127.0.0.1', `PORT=${port}`, `DATA_DIR=${dir}/data`, ...(appUrl ? [`APP_URL=${appUrl}`] : [])].map(e => `Environment=${sq(e)}`).join('\n')}
${UNSET}
ExecStart=${sq(node)} .output/server/index.mjs
${Object.keys(PROTECT_DEFAULTS).map(k => `${k}=${protect[k]}`).join('\n')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

export function updateScript({ branch, name, port }) {
  return `#!/usr/bin/env bash
# Update wherdr v3 (installed beside v2): fetch ${branch}, rebuild, restart. Data in ./data is kept.
set -euo pipefail
cd "$(dirname "$0")/src"
git fetch -q origin ${branch}
git checkout -q -f --detach origin/${branch}
# Small machines: Node's default heap is too small for the build (about ${BUILD_HEAP_MB} MB needed).
run=""
if [ "$(node -p 'require("v8").getHeapStatistics().heap_size_limit')" -lt ${BUILD_HEAP_MB * 1024 * 1024} ]; then
  export NODE_OPTIONS="${'$'}{NODE_OPTIONS:-} --max-old-space-size=${BUILD_HEAP_MB}"
  run="nice -n 19"; if command -v ionice >/dev/null 2>&1; then run="$run ionice -c3"; fi
fi
{ $run npm ci --no-audit --no-fund --loglevel=error && $run npm run build; } > ../build.log 2>&1 || { tail -20 ../build.log; echo "ERROR build-failed: see $(cd .. && pwd)/build.log"; exit 5; }
systemctl --user restart ${name}.service
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:${port}/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:${port}/api/health >/dev/null || { echo "ERROR not-answering: ${name} does not answer; journalctl --user -u ${name}"; exit 5; }
echo "OK wherdr v3 at $(git rev-parse --short HEAD) answers on http://127.0.0.1:${port}"
`
}

// Auto-deploy (--auto-deploy): a oneshot service run every 3 minutes by its timer.
export const DEPLOY_SCRIPT = 'pi-deploy-v3.sh'
export function deployUnits({ dir, name, port, source }) {
  const env = [`WHERDR_V3_SOURCE=${source}`, `WHERDR_V3_DIR=${dir}`, `WHERDR_V3_SERVICE=${name}`, `WHERDR_V3_PORT=${port}`]
  const head = `# wherdr v3 auto-deploy (install-v3-beside-v2 --auto-deploy). Off: systemctl --user disable --now ${name}-deploy.timer`
  return {
    service: `${head}
[Unit]
Description=Install the latest prebuilt wherdr v3
After=network-online.target

[Service]
Type=oneshot
${env.map(e => `Environment=${sq(e)}`).join('\n')}
${UNSET}
Nice=10
ExecStart=/bin/bash ${sq(path.join(dir, DEPLOY_SCRIPT))}
`,
    timer: `${head}
[Unit]
Description=Check for a new wherdr v3 build every 3 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=3min
Persistent=false

[Install]
WantedBy=timers.target
`,
  }
}

const portFree = port => new Promise(resolve => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
  s.listen(Number(port), '127.0.0.1')
})
const socketAlive = file => new Promise(resolve => {
  if (!fs.existsSync(file)) return resolve(false)
  const c = net.connect(file).once('connect', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
  setTimeout(() => { c.destroy(); resolve(false) }, 2000)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function health(url, tries = 1) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const j = await r.json()
      if (j?.name === 'wherdr') return j
    } catch {}
    if (i < tries - 1) await sleep(1000)
  }
  return null
}

export class Stop extends Error { constructor(code, id, msg) { super(msg); this.code = code; this.id = id } }

export async function main(argv = process.argv.slice(2), io = {}) {
  const run = io.run || defaultRun
  const env = io.env || process.env
  const home = io.home || os.homedir()
  let o
  try { o = parseArgs(argv, home) } catch (e) { console.error(`ERROR usage: ${e.message}`); return EXIT.usage }
  if (o.help) { console.log(HELP); return EXIT.ok }
  const say = (...l) => (o.json ? console.error : console.log)(...l)
  const summary = { mode: o.uninstall ? 'uninstall' : 'install', applied: !!o.yes, dir: o.dir, steps: [], next: [] }
  const step = (kind, text) => { summary.steps.push(`${kind} ${text}`); say(`${kind} ${text}`) }
  const next = text => { summary.next.push(text); say(`NEXT: ${text}`) }
  const unitDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user')
  const manifestFile = path.join(o.dir, MANIFEST)
  const manifest = (() => { try { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { return null } })()
  const save = m => { fs.mkdirSync(o.dir, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n') }
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`
  const hcState = s => path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'herdr-core', s)
  const sctl = (...a) => run('systemctl', ['--user', ...a])
  let code = EXIT.ok
  try {
    if (o.uninstall) await uninstall()
    else code = await install()
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    say(`ERROR ${e.id}: ${e.message}`)
    summary.error = { id: e.id, message: e.message }
    code = e.code
  }
  if (o.json) console.log(JSON.stringify({ ...summary, exit: code }, null, 2))
  return code

  async function install() {
    let leftForUser = false
    // 1. What is there.
    const v2 = detectV2({ ...o, home, env, run })
    say(describeV2(v2))
    summary.v2 = { found: v2.found, unit: v2.unit, dir: v2.dir, dataDir: v2.dataDir, port: v2.port, https: v2.tailscale.v2Https, board: v2.board, machines: v2.machines.length }
    if (!v2.found && !o.skipImport) next('no v2 install found: give --v2-dir / --v2-unit, or --skip-import for a plain v3 install')

    // 2. Prerequisites and 3. conflicts, all checked in one pass: every problem is one ERROR line.
    if (process.platform !== 'linux') throw new Stop(EXIT.missing, 'unsupported-os', 'this installer sets up systemd --user services (Linux); on macOS follow docs/installation.md')
    const errors = []
    const problem = (code, id, msg) => errors.push(new Stop(code, id, msg))
    const major = Number(process.versions.node.split('.')[0])
    if (major < 22) problem(EXIT.missing, 'missing-node', `Node.js 22 or newer is required (this is ${process.version})`)
    for (const [bin, id] of [['git', 'missing-git'], ['npm', 'missing-npm']]) {
      if (!run('sh', ['-c', `command -v ${bin}`]).ok) problem(EXIT.missing, id, `${bin} is not installed`)
    }
    if (!sctl('show-environment').ok) problem(EXIT.missing, 'missing-systemd-user', 'systemctl --user does not answer (no user systemd session)')
    // hc's official installer puts it in ~/.local/bin, often not on a non-interactive PATH.
    const localHc = path.join(home, '.local', 'bin', 'hc')
    const hcFound = o.hcBin || run('sh', ['-c', 'command -v hc']).out || (fs.existsSync(localHc) ? localHc : '')
    const hcVer = hcFound ? run(hcFound, ['--version']) : { ok: false }
    if (!hcVer.ok) problem(EXIT.missing, 'missing-hc', `herdr-core (hc) not found: install it with its official installer, ${HC_INSTALL} (build ${hcTarget()}, into ~/.local/bin, 0.1.16 or newer), or pass --hc-bin, then run this again`)
    const hc = hcVer.ok ? path.resolve(hcFound) : null

    // A previous run of this installer is not a conflict: re-runs are safe.
    const mine = manifest || {}
    const name = o.name, hcName = `${o.name}-hc`
    if (!manifest && fs.existsSync(o.dir) && fs.readdirSync(o.dir).length) problem(EXIT.conflict, 'dir-exists', `${o.dir} exists and was not made by this installer: choose another --dir`)
    for (const n of [name, hcName]) {
      if (fs.existsSync(path.join(unitDir, `${n}.service`)) && !(mine.units || []).includes(n)) problem(EXIT.conflict, 'service-exists', `${n}.service already exists and is not this installer's: choose another --name`)
    }
    if (v2.unit && path.basename(v2.unit) === `${name}.service`) problem(EXIT.conflict, 'service-exists', `${name} is v2's service: choose another --name`)
    const running = sctl('is-active', `${name}.service`).out === 'active'
    const freeLocal = async p => { for (let i = +p + 1; i < +p + 50; i++) if (String(i) !== v2.port && await portFree(i)) return i; return null }
    if (o.port === v2.port) problem(EXIT.conflict, 'port-taken', `port ${o.port} is v2's: choose another --port (${await freeLocal(o.port)} is free)`)
    else if (!(await portFree(o.port)) && !(manifest && running)) problem(EXIT.conflict, 'port-taken', `port ${o.port} is in use: choose another --port (${await freeLocal(o.port)} is free)`)
    const ts = !o.noTailscale && run('sh', ['-c', 'command -v tailscale']).ok
    const target = `http://127.0.0.1:${o.port}`
    let serveDone = false, httpsPort = null
    if (ts) {
      const p = pickHttpsPort({ entries: v2.tailscale.entries, port: o.port, wanted: o.httpsPort, previous: mine.tailscale })
      if (p.conflict) problem(EXIT.conflict, 'https-port-taken', `tailscale serve already uses https port ${p.port} (${p.conflict.proxy || 'tcp'}): choose another --https-port (${p.free} is free)`)
      httpsPort = p.port
      serveDone = !!p.done
    }
    if (errors.length) {
      for (const e of errors) say(`ERROR ${e.id}: ${e.message}`)
      summary.errors = errors.map(e => ({ id: e.id, message: e.message }))
      summary.error = summary.errors[0]
      return errors.some(e => e.code === EXIT.missing) ? EXIT.missing : EXIT.conflict
    }
    step('OK', `prerequisites: node ${process.version}, git, npm, systemd --user, ${hcVer.out}`)
    const socket = path.join(runtime, 'herdr-core', `${o.hcSession}.sock`)
    const hcUp = await socketAlive(socket)
    const ownHc = (mine.units || []).includes(hcName) || !hcUp

    // What the plan uses: the commit, the build's memory, the HTTPS address, v2's protections.
    const src = path.join(o.dir, 'src')
    const git = (...a) => run('git', ['-C', src, ...a])
    const short = sha => (sha ? sha.slice(0, 7) : 'unknown')
    const remote = run('git', ['ls-remote', o.repo, `refs/heads/${o.branch}`], { timeout: 60000 }).out.split(/\s/)[0] || null
    const hasSrc = fs.existsSync(src)
    const head = hasSrc ? git('rev-parse', 'HEAD').out || null : null
    // Kept on re-runs: once on, the installer never builds here again.
    const deploySource = o.deploySource || mine.deploySource || null
    const autoDeploy = !!deploySource
    // With auto-deploy, src/ is only the service's folder: the build comes from the source.
    const follow = hasSrc && !!mine.createdSrc && !autoDeploy
    const moves = follow && remote && remote !== head
    const built = fs.existsSync(path.join(src, '.output', 'server', 'index.mjs'))
    const needsBuild = !built || moves || (!!mine.builtCommit && mine.builtCommit !== head)
    const tuning = buildTuning(io.heapLimit, run('sh', ['-c', 'command -v ionice']).ok)
    const self = ts ? (() => { try { return JSON.parse(run('tailscale', ['status', '--json']).out).Self.DNSName.replace(/\.$/, '') } catch { return null } })() : null
    const appUrl = self && httpsPort ? `https://${self}:${httpsPort}/` : null
    const protect = unitProtections(v2.unit && !v2.unit.endsWith('.plist') ? fs.readFileSync(v2.unit, 'utf8') : '')
    const protectText = Object.keys(PROTECT_DEFAULTS).map(k => `${k}=${protect[k]}`).join(' ')

    // 4. The plan.
    const plan = [
      ownHc ? `start herdr-core session "${o.hcSession}" as ${hcName}.service (${socket})` : `use the running herdr-core session "${o.hcSession}" (${socket})`,
      !hasSrc ? `clone ${o.repo} (${o.branch} at ${short(remote)}) into ${src}`
        : !follow ? `keep ${src} at ${short(head)} (not cloned by this installer: not updated)`
          : moves ? `update ${src}: git fetch, then ${short(head)} → origin/${o.branch} at ${short(remote)}`
            : `keep ${src} at ${short(head)}${remote ? ` (= origin/${o.branch})` : ` (git ls-remote ${o.repo} failed)`}`,
      autoDeploy ? `install the latest prebuilt v3 from ${deploySource} into ${src}/.output (no build here)`
        : !needsBuild ? 'keep the existing build'
        : `npm ci && npm run build (log: ${o.dir}/build.log)${tuning ? `; Node's heap is ${tuning.heapMb} MB, the build needs ~1.5 GB: NODE_OPTIONS=${tuning.nodeOptions}, ${tuning.prefix}` : ''}`,
      o.skipImport || !v2.found ? 'no import' : `import from v2 into ${o.dir}/data (v2 is only read)`,
      `${running ? 'restart' : 'start'} ${name}.service on ${target} (DATA_DIR ${o.dir}/data${appUrl ? `, APP_URL ${appUrl}` : ''}; ${protectText} from ${protect.from})`,
      !ts ? 'no tailscale serve (tailscale not found or --no-tailscale)' : serveDone ? `keep tailscale serve https:${httpsPort}` : `tailscale serve --bg --https=${httpsPort} ${target} (added beside the existing entries${v2.tailscale.entries.length ? `, which use ${[...new Set(v2.tailscale.entries.map(e => e.https))].join(', ')}` : ''})`,
      `write ${o.dir}/update.sh`,
      ...(autoDeploy ? [`auto-deploy: ${name}-deploy.timer runs ${o.dir}/${DEPLOY_SCRIPT} every 3 min (log: ${o.dir}/deploy/deploy.log)`] : []),
    ]
    if (!o.skipImport && v2.found) {
      const r = runImport({ ...o, v2, run, dataDir: path.join(o.dir, 'data'), hcSession: o.hcSession, hcBin: hc, dryRun: true, hcReachable: hcUp })
      plan.splice(4, 0, `  projects: ${r.projects.added.map(p => `${p.key} (${p.path})`).join(', ') || 'none'}; open tasks: ${r.tasks.added.length}; settings: ${r.settings.carried.length}`,
        `  machines to add: ${r.machines.added.map(x => `${x.name} (${x.target})`).join(', ') || 'none'}${r.machines.missing.length ? `; not reachable: ${r.machines.missing.map(x => `${x.target} (${x.reason})`).join(', ')}` : ''}`)
    }
    summary.plan = plan
    summary.commit = follow || !hasSrc ? remote : head
    if (httpsPort) summary.httpsPort = httpsPort
    for (const p of plan) say(`PLAN ${p}`)
    if (!o.yes) { say('Dry run: nothing changed. Run again with --yes to apply.'); return EXIT.ok }

    // 5. Apply. The manifest is saved after each step, so --uninstall always knows what to remove.
    const m = { v: 1, createdDir: mine.createdDir ?? !fs.existsSync(o.dir), name, port: o.port, units: mine.units || [], machines: mine.machines || [], hcSession: o.hcSession, ...mine }
    save(m)
    if (ownHc) {
      if (m.hcStateCreated === undefined) m.hcStateCreated = !fs.existsSync(hcState(o.hcSession))
      fs.mkdirSync(unitDir, { recursive: true })
      fs.writeFileSync(path.join(unitDir, `${hcName}.service`), hcUnit({ hc, session: o.hcSession, pathEnv: env.PATH || '/usr/bin:/bin' }))
      if (!m.units.includes(hcName)) m.units.push(hcName)
      save(m)
      sctl('daemon-reload')
      const r = sctl('enable', '--now', `${hcName}.service`)
      if (!r.ok) throw new Stop(EXIT.failed, 'hc-start-failed', `${hcName}.service did not start: ${r.err.split('\n').pop()} (journalctl --user -u ${hcName})`)
      for (let i = 0; i < 20 && !(await socketAlive(socket)); i++) await sleep(500)
      if (!(await socketAlive(socket))) throw new Stop(EXIT.failed, 'hc-not-answering', `herdr-core does not answer on ${socket} (journalctl --user -u ${hcName})`)
      step('OK', `${hcName}.service: herdr-core session ${o.hcSession}`)
    } else step('SKIP', `herdr-core session ${o.hcSession} already runs`)

    if (!hasSrc) {
      const r = run('git', ['clone', '-q', '--branch', o.branch, o.repo, src], { timeout: 600000 })
      if (!r.ok) throw new Stop(EXIT.failed, 'clone-failed', `git clone failed: ${r.err.split('\n').pop()}`)
      m.createdSrc = true; save(m)
      step('OK', `cloned ${o.branch} into ${src} at ${short(git('rev-parse', 'HEAD').out)}`)
    } else if (follow) {
      // The installer's own clone follows the branch: a fix pushed since the last run is taken.
      const r = git('fetch', '-q', 'origin', o.branch)
      const c = r.ok ? git('checkout', '-q', '-f', '--detach', `origin/${o.branch}`) : r
      if (!c.ok) throw new Stop(EXIT.failed, 'update-failed', `could not move ${src} to origin/${o.branch}: ${c.err.split('\n').pop()}`)
      step('OK', `${src} at ${short(git('rev-parse', 'HEAD').out)} (origin/${o.branch})`)
    } else step('SKIP', `${src} exists, at ${short(head)} (not cloned by this installer)`)
    const now = git('rev-parse', 'HEAD').out || null
    const deployEnv = { ...env, WHERDR_V3_SOURCE: deploySource, WHERDR_V3_DIR: o.dir, WHERDR_V3_SERVICE: name, WHERDR_V3_PORT: o.port }
    if (autoDeploy) {
      fs.copyFileSync(fileURLToPath(new URL(`./${DEPLOY_SCRIPT}`, import.meta.url)), path.join(o.dir, DEPLOY_SCRIPT))
      fs.chmodSync(path.join(o.dir, DEPLOY_SCRIPT), 0o755)
      m.deploySource = deploySource; save(m)
      const r = run('bash', [path.join(o.dir, DEPLOY_SCRIPT), 'prepare'], { env: deployEnv, timeout: 1200000 })
      if (!r.ok || !fs.existsSync(path.join(src, '.output', 'server', 'index.mjs'))) throw new Stop(EXIT.failed, 'deploy-failed', `could not install a build from ${deploySource}: ${r.err.split('\n').pop() || 'no build'} (${o.dir}/deploy/deploy.log)`)
      step('OK', `prebuilt ${short(fs.readFileSync(path.join(o.dir, 'deploy', 'commit'), 'utf8').trim())} in ${src}/.output`)
    } else if (!built || (m.builtCommit ? m.builtCommit !== now : now !== head)) {
      const r = run('sh', ['-c', buildCommand(src, tuning)], { timeout: 3600000 })
      if (!r.ok) throw new Stop(EXIT.failed, 'build-failed', `the build failed: see ${o.dir}/build.log${tuning ? '' : " (out of memory? the build needs about 1.5 GB of Node heap: NODE_OPTIONS=--max-old-space-size=1536)"}`)
      m.builtCommit = now; save(m)
      step('OK', `built ${short(now)}${tuning ? ` (NODE_OPTIONS=${tuning.nodeOptions}, ${tuning.prefix})` : ''}`)
    } else step('SKIP', `already built at ${short(now)}`)

    if (!o.skipImport && v2.found) {
      const r = runImport({ ...o, v2, run, dataDir: path.join(o.dir, 'data'), hcSession: o.hcSession, hcBin: hc })
      for (const x of r.machines.added) if (!m.machines.includes(x.name)) m.machines.push(x.name)
      save(m)
      summary.import = { report: r.report, projects: r.projects.added.map(p => p.key), tasks: r.tasks.added.length, machines: r.machines.added.map(x => x.name), machinesMissing: r.machines.missing.map(x => `${x.target}: ${x.reason}`), settings: r.settings.carried }
      step('OK', `imported ${r.projects.added.length} projects, ${r.tasks.added.length} tasks, ${r.machines.added.length} machines, ${r.settings.carried.length} settings; report ${r.report}`)
      for (const x of r.machines.missing) next(`machine ${x.target}: ${x.reason}`)
      if (r.machines.missing.length) leftForUser = true
    }

    fs.mkdirSync(path.join(o.dir, 'data'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(unitDir, `${name}.service`), v3Unit({ node: process.execPath, dir: o.dir, socket, port: o.port, hcService: ownHc ? `${hcName}.service` : null, appUrl, protect }))
    if (!m.units.includes(name)) m.units.push(name)
    save(m)
    sctl('daemon-reload')
    sctl('enable', `${name}.service`)
    sctl('restart', `${name}.service`)
    const h = await health(`${target}/api/health`, 60)
    if (!h) throw new Stop(EXIT.failed, 'not-answering', `${name}.service does not answer on ${target} (journalctl --user -u ${name})`)
    step('OK', `${name}.service answers on ${target} (${h.version})`)
    summary.local = target

    fs.writeFileSync(path.join(o.dir, 'update.sh'), autoDeploy
      ? `#!/usr/bin/env bash\n# Auto-deploy is on: install the latest prebuilt v3 now (never builds here).\nWHERDR_V3_SOURCE=${JSON.stringify(deploySource)} WHERDR_V3_DIR=${JSON.stringify(o.dir)} WHERDR_V3_SERVICE=${name} WHERDR_V3_PORT=${o.port} exec bash ${JSON.stringify(path.join(o.dir, DEPLOY_SCRIPT))} "$@"\n`
      : updateScript({ branch: o.branch, name, port: o.port }), { mode: 0o755 })
    step('OK', `${o.dir}/update.sh`)
    if (autoDeploy) {
      const d = deployUnits({ dir: o.dir, name, port: o.port, source: deploySource })
      fs.writeFileSync(path.join(unitDir, `${name}-deploy.service`), d.service)
      fs.writeFileSync(path.join(unitDir, `${name}-deploy.timer`), d.timer)
      if (!m.units.includes(`${name}-deploy`)) m.units.push(`${name}-deploy`)
      save(m)
      sctl('daemon-reload')
      const r = sctl('enable', '--now', `${name}-deploy.timer`)
      if (!r.ok) throw new Stop(EXIT.failed, 'timer-failed', `${name}-deploy.timer did not start: ${r.err.split('\n').pop()}`)
      step('OK', `${name}-deploy.timer: every 3 min (log: ${o.dir}/deploy/deploy.log)`)
    }

    let code = leftForUser ? EXIT.todo : EXIT.ok
    if (ts && !serveDone) {
      const r = run('tailscale', ['serve', '--bg', `--https=${httpsPort}`, target])
      if (r.ok) { m.tailscale = httpsPort; save(m); serveDone = true; step('OK', `tailscale serve https:${httpsPort} → ${target}`) }
      else {
        code = EXIT.todo
        next(/denied|permission|operator|root/i.test(r.err)
          ? `tailscale needs your permission: run "sudo tailscale set --operator=$USER" once (or "sudo tailscale serve --bg --https=${httpsPort} ${target}"), then run this installer again`
          : `tailscale serve failed (${r.err.split('\n').pop()}): run "tailscale serve --bg --https=${httpsPort} ${target}" by hand`)
      }
    }
    if (serveDone && appUrl) {
      summary.url = appUrl
      const ok = await health(`${summary.url}api/health`, 10)
      step(ok ? 'OK' : 'WARN', `${summary.url} ${ok ? 'answers' : 'does not answer yet (the first HTTPS certificate can take a minute)'}`)
    }
    if (run('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value']).out !== 'yes') next('to keep v3 running after you log out, run "loginctl enable-linger" once')
    const passkeys = (() => { try { return JSON.parse(fs.readFileSync(path.join(o.dir, 'data', 'auth.json'), 'utf8')).credentials.length } catch { return 0 } })()
    if (!passkeys) next(`first passkey: open ${summary.url || target}, Settings › Security, with the bootstrap token from: journalctl --user -u ${name} | grep 'First passkey' | tail -1`)
    next('on each device: open v3, add a passkey, install the app and turn notifications on (they do not move from v2)')
    if (summary.import?.report) next(`read ${summary.import.report}: what was imported and what to do by hand`)
    return code
  }

  async function uninstall() {
    if (!manifest) { step('SKIP', `nothing to remove: no ${manifestFile}`); return }
    const m = manifest
    const plan = [
      ...(m.tailscale ? [`tailscale serve --https=${m.tailscale} off`] : []),
      ...[...(m.units || [])].reverse().map(u => `stop, disable and remove ${u}.service`),
      ...((m.units || []).includes(`${m.name}-hc`) ? [] : (m.machines || []).map(x => `hc machine rm ${x} (session ${m.hcSession})`)),
      ...(m.hcStateCreated && (m.units || []).includes(`${m.name}-hc`) ? [`remove herdr-core's state of session ${m.hcSession} (${hcState(m.hcSession)})`] : []),
      o.keepData ? `remove what is in ${o.dir} except data/` : m.createdDir ? `remove ${o.dir}` : `empty ${o.dir} (it existed, empty, before)`,
    ]
    summary.plan = plan
    for (const p of plan) say(`PLAN ${p}`)
    if (!o.yes) { say('Dry run: nothing changed. Run again with --uninstall --yes to remove.'); return }
    if (m.tailscale) {
      const r = run('tailscale', ['serve', `--https=${m.tailscale}`, 'off'])
      if (r.ok) step('OK', `tailscale serve https:${m.tailscale} off`)
      else next(`run "tailscale serve --https=${m.tailscale} off" (${r.err.split('\n').pop()})`)
    }
    const ownHc = (m.units || []).includes(`${m.name}-hc`)
    if (!ownHc) for (const x of m.machines || []) run(o.hcBin || 'hc', ['machine', 'rm', x], { env: { ...env, HC_SESSION: m.hcSession } })
    for (const u of [...(m.units || [])].reverse()) {
      if (fs.existsSync(path.join(unitDir, `${u}.timer`))) sctl('disable', '--now', `${u}.timer`)
      sctl('disable', '--now', `${u}.service`)
      for (const ext of ['service', 'timer']) fs.rmSync(path.join(unitDir, `${u}.${ext}`), { force: true })
      step('OK', `removed ${u}.service`)
    }
    sctl('daemon-reload')
    if (ownHc && m.hcStateCreated) { fs.rmSync(hcState(m.hcSession), { recursive: true, force: true }); step('OK', `removed ${hcState(m.hcSession)}`) }
    for (const f of fs.readdirSync(o.dir)) if (!(o.keepData && f === 'data')) fs.rmSync(path.join(o.dir, f), { recursive: true, force: true })
    if (m.createdDir && !o.keepData) fs.rmdirSync(o.dir)
    step('OK', o.keepData ? `emptied ${o.dir} (kept data/)` : m.createdDir ? `removed ${o.dir}` : `emptied ${o.dir}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => process.exit(code), e => { console.error(`ERROR unexpected: ${e.stack || e}`); process.exit(1) })
}
