#!/usr/bin/env node
// Finds a wherdr v2 install and imports what wherdr v3 can use from it: the
// herdr-projects board's projects and open tasks, Herdr's SSH machines (as
// herdr-core machines), the synced settings. Never writes anything of v2: every
// v2 file is only read. Writes v3's DATA_DIR and DATA_DIR/migration-report.md.
//
//   node scripts/v2-import.mjs detect [--json] [v2 options]
//   node scripts/v2-import.mjs import --data-dir <v3 data> [--hc-session S] [--dry-run] [--json] [v2 options]
//
// v2 options (default: found on this machine): --v2-dir <~/wherdr> --v2-unit <unit or plist file>
// --herdr-projects <~/.herdr-projects> --herdr-bin <herdr>. Exit codes: 0 done, 2 bad usage,
// 3 no v2 found, 5 a write failed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const readText = f => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const readJson = f => { const t = readText(f); try { return t === null ? null : JSON.parse(t) } catch { return null } }
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

export function defaultRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 15000, env: opts.env ?? process.env, input: '' })
  return { ok: r.status === 0, code: r.error ? 127 : r.status, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim() }
}

// ---- v2 detection --------------------------------------------------------

// KEY=VALUE lines of ~/wherdr/wherdr.env (same rules as v2's bin/lib/core.mjs).
export function parseEnvFile(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line)
    if (!m || line.startsWith('#')) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const unquote = s => s.replace(/\\(["\\])/g, '$1').replace(/%%/g, '%')
const words = s => [...String(s).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => (m[1] !== undefined ? unquote(m[1]) : m[2].replace(/%%/g, '%')))

// A systemd unit: its Environment= variables, ExecStart words, WorkingDirectory.
export function parseUnit(text) {
  const env = {}
  let exec = [], workingDirectory = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(Environment|ExecStart|WorkingDirectory)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    if (m[1] === 'Environment') for (const w of words(m[2])) { const i = w.indexOf('='); if (i > 0) env[w.slice(0, i)] = w.slice(i + 1) }
    else if (m[1] === 'ExecStart') exec = words(m[2])
    else workingDirectory = m[2].trim()
  }
  return { env, exec, workingDirectory }
}

// A launchd plist (macOS): its EnvironmentVariables and ProgramArguments.
export function parsePlist(text) {
  const x = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const env = {}
  const envDict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text || '')?.[1] || ''
  for (const m of envDict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[x(m[1])] = x(m[2])
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text || '')?.[1] || ''
  return { env, exec: [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(m => x(m[1])), workingDirectory: null }
}

const expand = (p, home) => (p === '~' ? home : p?.startsWith('~/') ? path.join(home, p.slice(2)) : p)

// The v2 service file: the one given, else wherdr.service / dev.wherdr.plist,
// else a user unit that runs v2's command-line launcher (bin/wherdr.mjs run).
export function findV2Unit({ home, env = {}, unit, platform = process.platform }) {
  if (unit) return fs.existsSync(unit) ? unit : null
  if (platform === 'darwin') {
    const f = path.join(home, 'Library', 'LaunchAgents', 'dev.wherdr.plist')
    return fs.existsSync(f) ? f : null
  }
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user')
  const usual = path.join(dir, 'wherdr.service')
  if (fs.existsSync(usual)) return usual
  const names = (() => { try { return fs.readdirSync(dir) } catch { return [] } })().filter(n => n.endsWith('.service')).sort()
  return names.map(n => path.join(dir, n)).find(f => parseUnit(readText(f)).exec.some(w => /bin\/wherdr(\.mjs)?$/.test(w))) || null
}

// Machines of Herdr (`herdr machine list --json`), as v2 reads them.
export function parseHerdrMachines(raw) {
  let list
  try { list = JSON.parse(raw) } catch { return [] }
  if (isObj(list) && Array.isArray(list.machines)) list = list.machines
  if (!Array.isArray(list)) return []
  return list.filter(m => isObj(m) && m.enabled !== false && typeof m.target === 'string' && m.target.trim() && !/^-|\s/.test(m.target.trim()))
    .map(m => ({ label: String(m.label || m.target).trim().slice(0, 40), target: m.target.trim(), session: String(m.session || 'default'), key: v2MachineKey(m.id) }))
}

// `tailscale serve status --json` → [{ https, proxy }] of the web entries.
export function serveEntries(raw) {
  let c
  try { c = JSON.parse(raw) } catch { return [] }
  if (!isObj(c)) return []
  const out = []
  for (const part of [c, ...Object.values(c.Foreground || {})]) {
    for (const [hostPort, entry] of Object.entries(part?.Web || {})) {
      const https = hostPort.slice(hostPort.lastIndexOf(':') + 1)
      for (const h of Object.values(entry?.Handlers || {})) out.push({ https, proxy: h?.Proxy || '' })
    }
    for (const p of Object.keys(part?.TCP || {})) if (!out.some(e => e.https === p)) out.push({ https: p, proxy: '' })
  }
  return out
}

const proxiesTo = (proxy, port) => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy)

// Everything this machine says about its v2 install. Read-only.
export function detectV2(o = {}) {
  const home = o.home || os.homedir()
  const env = o.env || process.env
  const run = o.run || defaultRun
  const notes = []
  const unitFile = findV2Unit({ home, env, unit: o.unit, platform: o.platform })
  const unit = unitFile ? (unitFile.endsWith('.plist') ? parsePlist(readText(unitFile)) : parseUnit(readText(unitFile))) : { env: {}, exec: [] }
  const dir = path.resolve(expand(o.v2Dir || unit.env.WHERDR_DIR || env.WHERDR_DIR || path.join(home, 'wherdr'), home))
  const envFile = path.join(dir, 'wherdr.env')
  const saved = parseEnvFile(readText(envFile))
  const pick = k => unit.env[k] ?? saved[k]
  const dataDir = path.resolve(expand(pick('DATA_DIR') || path.join(dir, 'data'), home))
  const port = pick('PORT') || '7683'
  const files = (() => { try { return fs.readdirSync(dataDir).sort() } catch { return [] } })()
  const found = !!unitFile || fs.existsSync(dataDir)
  let active = null
  if (unitFile && !unitFile.endsWith('.plist')) {
    const r = run('systemctl', ['--user', 'is-active', path.basename(unitFile)])
    active = r.out === 'active'
  }
  const hpDir = path.resolve(expand(o.hpDir || env.HERDR_PROJECTS_HOME || path.join(home, '.herdr-projects'), home))
  const board = fs.existsSync(path.join(hpDir, 'data', 'repos.json')) ? hpDir : null
  const herdr = run(o.herdrBin || 'herdr', ['machine', 'list', '--json'])
  if (!herdr.ok) notes.push(`herdr machine list failed (${herdr.code === 127 ? 'herdr not found' : herdr.err.split('\n').pop() || herdr.code}): no machine to import`)
  const machines = herdr.ok ? parseHerdrMachines(herdr.out) : []
  const ts = run('tailscale', ['serve', 'status', '--json'])
  const entries = ts.ok ? serveEntries(ts.out) : []
  return {
    found, unit: unitFile, active, session: pick('HERDR_WEB_SESSION') || null,
    dir, envFile: fs.existsSync(envFile) ? envFile : null, dataDir, port, files,
    board, machines,
    tailscale: { available: ts.ok, entries, v2Https: entries.filter(e => proxiesTo(e.proxy, port)).map(e => e.https) },
    notes,
  }
}

// ---- herdr-projects board ------------------------------------------------

// repos.json { name: path }, settings/config.json repos.<name> (key and per-repo settings),
// data/tasks/<repo>/<n>/task.json.
export function readBoard(hpDir) {
  const repos = readJson(path.join(hpDir, 'data', 'repos.json')) || {}
  const config = readJson(path.join(hpDir, 'settings', 'config.json')) || {}
  const tasks = []
  const tdir = path.join(hpDir, 'data', 'tasks')
  for (const repo of (() => { try { return fs.readdirSync(tdir).sort() } catch { return [] } })()) {
    for (const n of (() => { try { return fs.readdirSync(path.join(tdir, repo)) } catch { return [] } })().sort((a, b) => a - b)) {
      const t = readJson(path.join(tdir, repo, n, 'task.json'))
      if (isObj(t)) tasks.push({ repo, ...t })
    }
  }
  return { repos: isObj(repos) ? repos : {}, settings: isObj(config.repos) ? config.repos : {}, tasks }
}

// Same rules as shared/pm/project.ts (KEY_RE, BRANCH_RE).
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/
const DONE_STAGES = new Set(['done', 'merged', 'closed', 'cancelled', 'canceled'])

function keyFor(name, wanted, taken) {
  const derived = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 10)
  const base = KEY_RE.test(wanted) ? wanted : KEY_RE.test(derived) ? derived : 'PRJ'
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 10 - String(i).length)}${i}`
  return key
}

// Flattened setting paths of a repo: { merge: { by: 'x' } } → ['merge.by'].
const flat = (o, pre = '') => Object.entries(o || {}).flatMap(([k, v]) => (isObj(v) ? flat(v, `${pre}${k}.`) : [`${pre}${k}`]))

// Board repos → v3 projects (machine '' = this host). `existing`: v3's projects.
export function mapProjects(board, existing = [], exists = p => fs.existsSync(p)) {
  const projects = [], skipped = [], byRepo = {}
  const taken = new Set(existing.map(p => p.key))
  for (const [name, folder] of Object.entries(board.repos).sort(([a], [b]) => a.localeCompare(b))) {
    const s = board.settings[name] || {}
    const same = existing.find(p => p.machine === '' && p.path === folder)
    if (same) { byRepo[name] = same.key; skipped.push({ name, path: folder, reason: `already in v3 as ${same.key}` }); continue }
    if (typeof folder !== 'string' || !folder.startsWith('/')) { skipped.push({ name, path: String(folder), reason: 'not an absolute path' }); continue }
    if (!exists(folder)) { skipped.push({ name, path: folder, reason: 'folder missing' }); continue }
    const key = keyFor(name, String(s.repo?.key || '').toUpperCase(), taken)
    taken.add(key)
    const from = s.workspace?.from
    const base = typeof from === 'string' && BRANCH_RE.test(from) ? from : undefined
    const left = flat(s).filter(k => k !== 'repo.key' && !(k === 'workspace.from' && base))
    projects.push({ key, name: String(name).slice(0, 80), machine: '', path: folder, ...(base ? { base } : {}), addedAt: 0, left })
    byRepo[name] = key
  }
  return { projects, skipped, byRepo }
}

// How v2 showed a board task: KEY-n with the repo's key (WHR-37), else its id (app/1).
export function v2TaskName(board, t) {
  const key = String(board.settings?.[t.repo]?.repo?.key || '').toUpperCase()
  const n = Number(t.n)
  return KEY_RE.test(key) && Number.isInteger(n) && n > 0 ? `${key}-${n}` : String(t.id || `${t.repo}/${t.n}`)
}

// Open board tasks → v3 tasks to do. `imported`: board id → v3 id already made.
// A task keeps its v2 number when it is free in v3; else it takes the next free
// one and its description says which v2 task it was.
export function mapTasks(board, byRepo, existingTasks = [], imported = {}, now = Date.now()) {
  const listed = [], open = []
  for (const t of board.tasks) {
    const id = String(t.id || `${t.repo}/${t.n}`)
    const stage = String(t.stage || 'todo')
    if (t.archivedAt || DONE_STAGES.has(stage)) continue
    if (imported[id]) { listed.push({ id, title: t.title, reason: `already imported as ${imported[id]}` }); continue }
    const key = byRepo[t.repo]
    if (!key) { listed.push({ id, title: t.title, reason: `its project ${t.repo} was not imported` }); continue }
    open.push({ t, id, stage, key })
  }
  const used = new Set(existingTasks.map(x => String(x.id)))
  const numbers = key => [...used].filter(i => i.startsWith(`${key}-`)).map(i => Number(i.slice(key.length + 1)) || 0)
  // First the tasks whose number is free, so a renumbered one never takes a number another keeps.
  for (const x of open) {
    const n = Number(x.t.n)
    if (Number.isInteger(n) && n > 0 && !used.has(`${x.key}-${n}`)) { x.newId = `${x.key}-${n}`; used.add(x.newId) }
  }
  for (const x of open) if (!x.newId) { x.newId = `${x.key}-${1 + Math.max(0, ...numbers(x.key))}`; used.add(x.newId) }
  const tasks = open.map(({ t, id, stage, key, newId }) => {
    const v2 = v2TaskName(board, t)
    const renamed = newId !== v2
    const title = String(t.title || '').trim().slice(0, 200) || `Task ${id}`
    const text = String(t.description || '')
    return {
      from: id, v2, stage, renamed,
      task: {
        id: newId, project: key, title,
        description: (renamed ? `From v2 ${v2}.${text ? `\n\n${text}` : ''}` : text).slice(0, 20000),
        type: 'task', state: 'todo', origin: 'user', createdAt: Number(t.created) || now, tags: ['from v2'],
        log: [{ at: now, by: 'import', text: `Imported from v2 ${v2}${v2 === id ? '' : ` (herdr-projects ${id})`}, stage ${stage}` }],
      },
    }
  })
  return { tasks, listed }
}

// ---- settings ------------------------------------------------------------

// v3's synced keys, read from shared/settings.ts (the one list).
export function v3SettingKeys(file = fileURLToPath(new URL('../shared/settings.ts', import.meta.url))) {
  const body = /SYNCED_SETTINGS = \[([\s\S]*?)\] as const/.exec(readText(file) || '')?.[1] || ''
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map(m => m[1])
}

// Keys v3 still lists but no longer reads, or whose value names v2 things.
export const NOT_CARRIED = {
  boardGrouping: 'the v2 board is not in v3', boardDone: 'the v2 board is not in v3', boardFolds: 'the v2 board is not in v3',
  individualAgentList: 'no longer used', hiddenAgents: 'names v2 panes: hide agents again in v3',
}

export function mapSettings(v2, v3 = {}, keys = v3SettingKeys()) {
  const patch = {}, carried = [], skipped = []
  for (const [k, v] of Object.entries(v2 || {})) {
    if (!keys.includes(k)) skipped.push({ key: k, reason: 'not in v3' })
    else if (NOT_CARRIED[k]) skipped.push({ key: k, reason: NOT_CARRIED[k] })
    else if (typeof v !== 'string') skipped.push({ key: k, reason: 'not a text value' })
    else if (v3[k] !== undefined) skipped.push({ key: k, reason: 'already set in v3' })
    else { patch[k] = v; carried.push(k) }
  }
  return { patch, carried, skipped }
}

// ---- machines ------------------------------------------------------------

export const machineName = s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 32) || 'machine'

// A machine's key in the settings that name machines. v2: 8 hex characters of
// its Herdr profile id (shared/ids.ts machineKey). v3: its hc name in hex
// (shared/coreState.ts). The local machine is '' in both.
export const v2MachineKey = id => String(id || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8)
export const v3MachineKey = name => Buffer.from(String(name), 'utf8').toString('hex')

// Synced settings that list machine keys: string arrays, or groups { id, name, machines }.
export const MACHINE_SETTINGS = ['machineGroups', 'machineBarOrder', 'machineBarHidden', 'collapsedMachines']

// The machine settings of `patch` with each v2 key turned into the key of the
// v3 machine made from it (`keys`: v2 key → v3 key). A key with no v3 machine
// is dropped; '' (local) and '*…' (All, groups) stay. `labels`: v2 key → name.
export function remapMachineSettings(patch, keys, labels = {}) {
  const out = { ...patch }, changes = []
  const map = (list, setting, group) => {
    const kept = []
    for (const k of list) {
      if (typeof k !== 'string') continue
      if (k === '' || k.startsWith('*')) kept.push(k)
      else if (keys[k]) { changes.push({ setting, group, from: k, label: labels[k], to: keys[k].name }); kept.push(keys[k].key) }
      else changes.push({ setting, group, from: k, label: labels[k], to: null })
    }
    return [...new Set(kept)]
  }
  for (const setting of MACHINE_SETTINGS) {
    if (out[setting] === undefined) continue
    let v
    try { v = JSON.parse(out[setting]) } catch { continue }
    if (!Array.isArray(v)) continue
    out[setting] = JSON.stringify(setting === 'machineGroups'
      ? v.map(g => (isObj(g) && Array.isArray(g.machines) ? { ...g, machines: map(g.machines, setting, String(g.name || g.id)) } : g))
      : map(v, setting))
  }
  return { patch: out, changes }
}

// Herdr's machines → `machine.add` calls, minus those hc already has.
export function mapMachines(v2, hc = []) {
  const add = [], have = []
  const names = new Set(hc.map(m => m.name))
  for (const m of v2) {
    const same = hc.find(h => h.target === m.target)
    if (same) { have.push({ ...m, name: same.name }); continue }
    let name = machineName(m.label)
    for (let i = 2; names.has(name); i++) name = `${machineName(m.label).slice(0, 29)}-${i}`
    names.add(name)
    add.push({ ...m, name })
  }
  return { add, have }
}

// Where hc is on a machine. A non-interactive SSH shell often has a short PATH
// (macOS: /usr/bin:/bin:/usr/sbin:/sbin) while hc itself finds its usual places.
export const HC_PROBE = 'command -v hc || for f in "$HOME/.local/bin/hc" /opt/homebrew/bin/hc /usr/local/bin/hc; do [ -x "$f" ] && { echo "$f"; exit 0; }; done; exit 1'

// Why the SSH probe failed, in one line; null when SSH itself works (hc found or not).
export function sshProblem(r) {
  if (r.ok) return null
  if (r.code === 127 && !r.err) return 'ssh is not installed here'
  if (/Permission denied|Host key verification failed|password|publickey/i.test(r.err)) return `no SSH key login (${r.err.split('\n').pop()}): run ssh <target> true once and set up a key`
  if (r.code === 255) return `unreachable over SSH (${r.err.split('\n').pop() || 'no answer'})`
  return null
}

// ---- import --------------------------------------------------------------

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temp, file)
}

// Imports into v3's dataDir. dryRun: computes everything, writes nothing.
export function runImport(o) {
  const run = o.run || defaultRun
  const now = o.now ?? Date.now()
  const v2 = o.v2 || detectV2(o)
  const data = path.resolve(o.dataDir)
  const pmDir = path.join(data, 'projects')
  const state = readJson(path.join(data, 'migration', 'imported.json')) || {}
  const res = { at: new Date(now).toISOString(), dryRun: !!o.dryRun, v2: { dir: v2.dir, dataDir: v2.dataDir, unit: v2.unit, port: v2.port, board: v2.board }, dataDir: data }

  // Projects and tasks.
  const existing = readJson(path.join(pmDir, 'projects.json'))?.projects || []
  const existingTasks = (() => { try { return fs.readdirSync(path.join(pmDir, 'tasks')) } catch { return [] } })().map(n => ({ id: n.replace(/\.json$/, ''), project: n.replace(/-\d+\.json$/, '') }))
  const board = v2.board ? readBoard(v2.board) : { repos: {}, settings: {}, tasks: [] }
  const p = mapProjects(board, existing, o.exists)
  const t = mapTasks(board, p.byRepo, existingTasks, state.tasks || {}, now)
  res.projects = { added: p.projects.map(({ left, ...x }) => ({ ...x, left })), skipped: p.skipped, board: v2.board }
  res.tasks = { added: t.tasks.map(x => ({ id: x.task.id, from: x.from, v2: x.v2, renamed: x.renamed, stage: x.stage, title: x.task.title })), listed: t.listed }

  // Settings and the small files v3 reads the same way.
  const v3Settings = readJson(path.join(data, 'settings.json'))?.settings || {}
  const s = mapSettings(readJson(path.join(v2.dataDir, 'settings.json'))?.settings, v3Settings, o.settingKeys)
  const copies = []
  for (const f of ['quiet.json', 'machine-label.txt']) {
    if (fs.existsSync(path.join(v2.dataDir, f)) && !fs.existsSync(path.join(data, f))) copies.push(f)
  }
  const dirs = readJson(path.join(v2.dataDir, 'dirs.json'))
  const copyDirs = Array.isArray(dirs?.dirs) && dirs.dirs.length && !fs.existsSync(path.join(data, 'dirs.json'))
  res.settings = { carried: s.carried, skipped: s.skipped, files: [...copies, ...(copyDirs ? ['dirs.json (this machine\'s recent folders)'] : [])] }

  // Machines: added to hc when it can reach them, else listed with what is missing.
  const hcEnv = { ...(o.env || process.env), ...(o.hcSession ? { HC_SESSION: o.hcSession } : {}) }
  const hcBin = o.hcBin || 'hc'
  // Any hc call starts a core when its session is not running: only call it when the socket is there.
  const session = o.hcSession || hcEnv.HC_SESSION || 'default'
  const reachable = o.hcReachable ?? hcSocketExists(session, hcEnv)
  const ls = reachable ? run(hcBin, ['machine', 'ls', '--json'], { env: hcEnv }) : { ok: false }
  const hcList = ls.ok ? (readJsonText(ls.out)?.machines || []) : []
  const m = mapMachines(v2.machines || [], hcList)
  res.machines = { added: [], have: m.have, missing: [], hc: ls.ok }
  for (const x of m.add) {
    const note = x.session !== 'default' ? `its Herdr session was ${x.session}; hc uses the machine's default hc session` : undefined
    if (!ls.ok && !(o.dryRun && !reachable)) { res.machines.missing.push({ ...x, reason: `herdr-core session ${session} is not running here, so no machine was added: start it and run the import again`, note }); continue }
    const probe = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', x.target, HC_PROBE])
    const why = sshProblem(probe)
    if (why) { res.machines.missing.push({ ...x, reason: why, note }); continue }
    // hc not seen by the probe: hc machine add still looks for it itself, so only its own error counts.
    const unseen = probe.out ? undefined : 'hc was not found on its PATH, in ~/.local/bin or /opt/homebrew/bin there; hc machine add looks for it itself'
    if (o.dryRun) { res.machines.added.push({ ...x, note, planned: true, ...(unseen ? { check: unseen } : {}) }); continue }
    const r = run(hcBin, ['machine', 'add', x.target, '--name', x.name, '--json'], { env: hcEnv, timeout: 60000 })
    if (r.ok) res.machines.added.push({ ...x, note })
    else res.machines.missing.push({ ...x, reason: `hc machine add failed: ${(r.err || r.out).split('\n').pop() || `exit ${r.code}`}${unseen ? ' (hc was not found there either: install herdr-core on that machine)' : ''}`, note })
  }

  // Settings that name machines: v2 keys → the v3 machines made from them (same SSH target).
  const keys = {}, labels = {}
  for (const x of [...res.machines.added, ...res.machines.have]) if (x.key) keys[x.key] = { key: v3MachineKey(x.name), name: x.name }
  for (const x of v2.machines || []) if (x.key) labels[x.key] = x.label
  const remapped = remapMachineSettings(s.patch, keys, labels)
  s.patch = remapped.patch
  res.settings.machines = remapped.changes

  if (!o.dryRun) {
    if (p.projects.length) {
      writeJsonFile(path.join(pmDir, 'projects.json'), { v: 1, projects: [...existing, ...p.projects.map(({ left, ...x }) => ({ ...x, addedAt: now }))] })
      const pm = readJson(path.join(pmDir, 'pm.json')) || {}
      if (pm.enabled !== true) { writeJsonFile(path.join(pmDir, 'pm.json'), { ...pm, v: 1, enabled: true }); res.projects.switchedOn = true }
    }
    for (const x of t.tasks) writeJsonFile(path.join(pmDir, 'tasks', `${x.task.id}.json`), x.task)
    if (s.carried.length) writeJsonFile(path.join(data, 'settings.json'), { v: 1, settings: { ...v3Settings, ...s.patch } })
    for (const f of copies) { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, f), fs.readFileSync(path.join(v2.dataDir, f)), { mode: 0o600 }) }
    if (copyDirs) writeJsonFile(path.join(data, 'dirs.json'), { dirs: dirs.dirs })
    writeJsonFile(path.join(data, 'migration', 'imported.json'), {
      v: 1, at: res.at, tasks: { ...(state.tasks || {}), ...Object.fromEntries(t.tasks.map(x => [x.from, x.task.id])) },
    })
    res.report = path.join(data, 'migration-report.md')
    // The report of an earlier run is kept: it lists what that run imported.
    if (fs.existsSync(res.report)) fs.renameSync(res.report, path.join(data, 'migration', `report-${String(state.at || now).replace(/[:.]/g, '-')}.md`))
    fs.writeFileSync(res.report, renderReport(res), { mode: 0o600 })
  }
  return res
}

export function hcSocketExists(session, env = process.env) {
  const dir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  try { return fs.statSync(path.join(dir, 'herdr-core', `${session}.sock`)).isSocket() } catch { return false }
}

function readJsonText(t) { try { return JSON.parse(t) } catch { return null } }

const V2_ONLY = [
  ['Passkeys', 'not moved: add a passkey again in v3 (Settings › Security) on each device'],
  ['Devices and push notifications', 'not moved (push keys belong to v2\'s address): open v3 on each device, install the app again and turn notifications on'],
  ['Phone address', 'v3 has its own HTTPS address (see the installer\'s summary)'],
  ['Per-device settings', 'kept in each browser, not on the server: set them again in v3 on each device'],
  ['herdr-projects board settings', 'limits, reviewer, worker, merge and coordinator settings have no v3 equivalent as such: set them in each project\'s template'],
  ['Herdr sessions, plugins, worktrees, one-tap update', 'v2 only'],
]

export function renderReport(r) {
  const L = []
  const row = (...c) => L.push(`| ${c.map(x => String(x ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
  L.push('# wherdr v2 → v3 migration report', '', `${r.dryRun ? 'Dry run (nothing written), ' : ''}${r.at}. v2 was only read: ${r.v2.dir} (data ${r.v2.dataDir}, port ${r.v2.port}). v3 data: ${r.dataDir}.`, '')
  L.push('## Projects', '')
  if (!r.projects.board) L.push('No herdr-projects board found: no project imported.', '')
  if (r.projects.added.length) {
    L.push(`Imported as v3 projects${r.projects.switchedOn ? ' (Projects switched on)' : ''}. Each needs a template before its tasks can start (Settings › Projects).`, '')
    row('Key', 'Name', 'Folder', 'Base branch', 'v2 settings to redo in the template'); row('---', '---', '---', '---', '---')
    for (const p of r.projects.added) row(p.key, p.name, p.path, p.base || '', p.left.join(', '))
    L.push('')
  }
  if (r.projects.skipped.length) { L.push('Not imported this time:', ''); for (const s of r.projects.skipped) L.push(`- ${s.name} (${s.path}): ${s.reason}`); L.push('') }
  L.push('## Tasks', '')
  L.push(r.tasks.added.length ? 'Open board tasks imported as v3 tasks to do (type `task`; pick their type once the project has a template). They keep their v2 number when it is free in v3; a renumbered task says "From v2 …" at the top of its description. Done and archived tasks were not imported.' : 'No open board task imported. Done and archived tasks are never imported.', '')
  for (const t of r.tasks.added) L.push(`- ${t.id} ← v2 ${t.v2} (${t.stage}): ${t.title}`)
  if (r.tasks.listed.length) { L.push('', 'Open tasks not imported this time:', ''); for (const t of r.tasks.listed) L.push(`- ${t.id}: ${t.title || ''} (${t.reason})`) }
  L.push('', '## Machines', '')
  if (!r.machines.added.length && !r.machines.missing.length && !r.machines.have.length) L.push('No SSH machine in Herdr.')
  // hc names are 1-32 of a-z 0-9 - _ . : say when the v2 name was changed.
  const named = m => (m.label && m.label !== m.name ? `${m.name} (v2 name ${m.label} → ${m.name})` : m.name)
  for (const m of r.machines.added) L.push(`- ${m.planned ? 'Would add' : 'Added'} ${named(m)}, ${m.target}${[m.note, m.check].filter(Boolean).map(x => `; ${x}`).join('')}`)
  for (const m of r.machines.have) L.push(`- ${m.name} (${m.target}): already in herdr-core`)
  for (const m of r.machines.missing) L.push(`- **To do:** ${named(m)}, ${m.target}: ${m.reason}${m.note ? `; ${m.note}` : ''}. Then add it in Settings › Agents › Machines, or run \`hc machine add ${m.target} --name ${m.name}\`.`)
  L.push('', '## Settings', '')
  L.push(r.settings.carried.length ? `Carried over: ${r.settings.carried.join(', ')}.` : 'No synced setting carried over.')
  if (r.settings.files.length) L.push('', `Copied: ${r.settings.files.join(', ')}.`)
  if (r.settings.machines?.length) {
    L.push('', 'Machines named in the machine bar and groups, turned into the v3 machines made from them (same SSH target):', '')
    for (const c of r.settings.machines) {
      const v2 = `${c.label ? `${c.label} ` : ''}(v2 ${c.from})`
      L.push(`- ${c.setting}${c.group ? `, group ${c.group}` : ''}: ${c.to ? `${v2} → ${c.to}` : `${v2} dropped: no v3 machine was made from it (once you add it, put it back in Settings › Appearance › Machine bar)`}`)
    }
  }
  if (r.settings.skipped.length) { L.push('', 'Not carried over this time:', ''); for (const s of r.settings.skipped) L.push(`- ${s.key}: ${s.reason}`) }
  L.push('', '## What stays in v2 (do it again in v3)', '')
  for (const [k, v] of V2_ONLY) L.push(`- **${k}**: ${v}`)
  L.push('')
  return L.join('\n')
}

// ---- command line ----------------------------------------------------------

export function parseArgs(argv) {
  const o = { command: argv[0] }
  const names = { '--data-dir': 'dataDir', '--v2-dir': 'v2Dir', '--v2-unit': 'unit', '--herdr-projects': 'hpDir', '--herdr-bin': 'herdrBin', '--hc-session': 'hcSession', '--hc-bin': 'hcBin' }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--json') o.json = true
    else if (names[a] && argv[i + 1] !== undefined) o[names[a]] = argv[++i]
    else throw new Error(`unknown option: ${a}`)
  }
  if (!['detect', 'import'].includes(o.command)) throw new Error('first argument: detect or import')
  if (o.command === 'import' && !o.dataDir) throw new Error('import needs --data-dir <v3 DATA_DIR>')
  return o
}

export function describeV2(v) {
  return [
    `v2 install: ${v.found ? 'found' : 'NOT FOUND'}`,
    `  service: ${v.unit || 'none'}${v.active === null ? '' : v.active ? ' (running)' : ' (not running)'}`,
    `  folder: ${v.dir}${v.envFile ? ' (wherdr.env)' : ''}`,
    `  data: ${v.dataDir} (${v.files.length} files), port ${v.port}${v.session ? `, Herdr session ${v.session}` : ''}`,
    `  tailscale serve: ${v.tailscale.available ? (v.tailscale.v2Https.length ? `https ${v.tailscale.v2Https.join(', ')} → v2` : 'no entry for v2') : 'not available'}`,
    `  herdr-projects board: ${v.board || 'none'}`,
    `  Herdr SSH machines: ${v.machines.map(m => `${m.label} (${m.target})`).join(', ') || 'none'}`,
    ...v.notes.map(n => `  note: ${n}`),
  ].join('\n')
}

async function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) }
  catch (e) { console.error(`ERROR usage: ${e.message}`); process.exit(2) }
  const v2 = detectV2(o)
  if (o.command === 'detect') {
    console.log(o.json ? JSON.stringify(v2, null, 2) : describeV2(v2))
    process.exit(v2.found ? 0 : 3)
  }
  if (!v2.found) { console.error('ERROR no-v2: no wherdr v2 install found (give --v2-dir or --v2-unit)'); process.exit(3) }
  let r
  try { r = runImport({ ...o, v2 }) }
  catch (e) { console.error(`ERROR import-failed: ${e.message}`); process.exit(5) }
  console.log(o.json ? JSON.stringify(r, null, 2) : renderReport(r))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
