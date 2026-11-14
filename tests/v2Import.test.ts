// The v2 → v3 import (scripts/v2-import.mjs) and the side-by-side installer's
// plan (scripts/install-v3-beside-v2.mjs), on the fixture v2 install of
// tests/fixtures/v2-install. Commands (systemctl, herdr, tailscale, ssh, hc) are faked.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanProjectInput } from '../shared/pm/project'
import { detectV2, keptDirs, v3AppDir, mapMachines, mapSettings, parseArgs as importArgs, parseEnvFile, parseUnit, remapMachineSettings, runImport, sshProblem, v3MachineKey } from '../scripts/v2-import.mjs'
import { HANDOVER_PROMPT, goalLine, mapCandidates, readBoard } from '../server/utils/v2Board'
import { EXIT, buildCommand, buildTuning, deployUnits, hcTarget, hcUnit, main, parseArgs, pickHttpsPort, unitProtections, updateScript, v3Unit } from '../scripts/install-v3-beside-v2.mjs'

const FIX = path.resolve(__dirname, 'fixtures/v2-install')
const machinesJson = fs.readFileSync(path.join(FIX, 'herdr-machines.json'), 'utf8')
const serveJson = JSON.stringify({ Web: { 'host-a.tail.ts.net:8103': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7683' } } } } })

type Res = { ok: boolean, code: number, out: string, err: string }
const ok = (out = ''): Res => ({ ok: true, code: 0, out, err: '' })
const fail = (code: number, err = ''): Res => ({ ok: false, code, out: '', err })

// A fake of the commands the import runs; `calls` records them.
function fakeRun(over: Record<string, Res> = {}) {
  const calls: string[] = []
  const run = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [k, v] of Object.entries(over)) if (line.startsWith(k)) return v
    if (line.startsWith('systemctl --user is-active')) return ok('active')
    if (line === 'herdr machine list --json') return ok(machinesJson)
    if (line === 'tailscale serve status --json') return ok(serveJson)
    if (line === 'hc machine ls --json') return ok(JSON.stringify({ machines: [] }))
    if (line.startsWith('ssh ') && line.includes('user@laptop')) return ok('/home/user/.local/bin/hc')
    if (line.startsWith('ssh ')) return fail(255, 'ssh: connect to host vps port 22: No route to host')
    if (line.startsWith('hc machine add')) return ok('{}')
    return fail(127)
  }
  return { run, calls }
}

const v2Opts = { home: '/home/user', env: {}, unit: path.join(FIX, 'systemd/wherdr.service'), v2Dir: path.join(FIX, 'wherdr') }

function hashTree(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n)
      if (fs.statSync(f).isDirectory()) walk(f)
      else h.update(`${path.relative(dir, f)}\0`).update(fs.readFileSync(f))
    }
  }
  walk(dir)
  return h.digest('hex')
}

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v2import-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('v2 detection', () => {
  it('reads a systemd unit: quoted variables, several per line, %% and ExecStart', () => {
    const u = parseUnit(fs.readFileSync(path.join(FIX, 'systemd/wherdr.service'), 'utf8'))
    expect(u.env).toMatchObject({ PORT: '7683', DATA_DIR: '/home/user/wherdr/data', HERDR_WEB_SESSION: 'main', NOTE: '100% sure' })
    expect(u.exec.at(-1)).toBe('run')
    expect(parseEnvFile('# c\nexport PORT=7690\nX="a b"\n')).toEqual({ PORT: '7690', X: 'a b' })
  })

  it('finds the service, data, port, machines and tailscale entry; the unit wins over wherdr.env', () => {
    const v = detectV2({ ...v2Opts, run: fakeRun().run })
    expect(v).toMatchObject({ found: true, active: true, port: '7683', dataDir: '/home/user/wherdr/data', session: 'main' })
    expect(v.machines.map((m: { target: string }) => m.target)).toEqual(['user@laptop', 'vps']) // the disabled one is left out
    expect(v.tailscale.v2Https).toEqual(['8103'])
  })

  it('says when herdr is missing and nothing is found', () => {
    const v = detectV2({ home: tmp(), env: {}, run: fakeRun({ herdr: fail(127) }).run, platform: 'linux' })
    expect(v.found).toBe(false)
    expect(v.notes.join()).toMatch(/herdr not found/)
  })
})

describe('import mapping', () => {
  const board = readBoard(path.join(FIX, 'herdr-projects'))!
  const exists = (p: string) => !p.endsWith('/gone')

  it('lists board repos as v3 project candidates, with a free key, base branch, settings to redo and open tasks', () => {
    const r = mapCandidates(board, [{ key: 'SITE', name: 'other', machine: '', path: '/elsewhere', addedAt: 1 }], exists)
    expect(r.projects.map((p: { key: string, here: boolean }) => [p.key, p.here])).toEqual([['APP', true], ['GONE', false], ['MYDOCS', true], ['SITE2', true]])
    expect(r.projects[0]).toMatchObject({ name: 'app', path: '/home/user/code/app', base: 'develop', left: ['merge.by', 'reviewer.agent'] })
    for (const p of r.projects) expect(cleanProjectInput({ ...p, machine: '' }).errors).toEqual([])
    // Open tasks only, by the name v2 showed (site's key "x" is not valid: site/1); an under-way one keeps its stage, branch and PR.
    expect(r.projects[0].tasks).toEqual([
      { v2: 'APP-1', stage: 'todo', title: 'Fix the login form', description: 'The form loses focus.', intro: 'From v2 APP-1.' },
      { v2: 'APP-2', stage: 'progress', title: 'Add dark mode', description: '', branch: 'feature/c++', pr: 12, intro: 'From v2 APP-2. Continue from branch `feature/c++` / PR #12.' },
    ])
    expect(r.projects[3].tasks.map((t: { v2: string }) => t.v2)).toEqual(['site/1'])
    // Any branch git takes is kept, however long; one git refuses is dropped.
    const long = `feature/${'a'.repeat(193)}`
    const one = (branch: string) => mapCandidates({ ...board, tasks: [{ repo: 'app', n: 3, stage: 'progress', branch }] }, [], exists).projects[0].tasks[0].branch
    expect([one(long), one('a..b')]).toEqual([long, undefined])
  })

  it('offers a handover only for a project whose v2 coordinator exists, and carries its autopilot goal as one line', () => {
    const r = mapCandidates(board, [], exists).projects
    expect(r.map(p => [p.key, p.handover ?? null, p.goalLine ?? null])).toEqual([
      ['APP', HANDOVER_PROMPT, '- Goal from v2\'s autopilot: Ship the release'],
      ['GONE', null, null], ['MYDOCS', null, null],
      ['SITE', null, '- Goal from v2\'s autopilot: Keep the docs current'],
    ])
    expect(goalLine({ autopilot: { goal: 'none' } })).toBeUndefined()
  })

  it('carries the settings v3 reads, never over a v3 value', () => {
    const v2 = JSON.parse(fs.readFileSync(path.join(FIX, 'wherdr/data/settings.json'), 'utf8')).settings
    const r = mapSettings(v2, { showQuotas: '1' })
    expect(Object.keys(r.patch)).toEqual(['theme', 'typewriterSpeed', 'machineGroups', 'machineBarOrder'])
    expect(Object.fromEntries(r.skipped.map((s: { key: string, reason: string }) => [s.key, s.reason]))).toMatchObject({
      boardGrouping: expect.stringMatching(/board/), hiddenAgents: expect.stringMatching(/v2 panes/), oldThing: 'not in v3', showQuotas: 'already set in v3',
    })
  })

  it('turns the v2 machines of a group and of the bar into the v3 machines made from them, and drops the others', () => {
    const v2 = JSON.parse(fs.readFileSync(path.join(FIX, 'wherdr/data/settings.json'), 'utf8')).settings
    const r = remapMachineSettings(v2, { '23108ee8': { key: v3MachineKey('beast'), name: 'beast' } }, { '23108ee8': 'Beast', f27df2ea: 'Work' })
    expect(v3MachineKey('beast')).toBe('6265617374')
    expect(JSON.parse(r.patch.machineGroups)).toEqual([{ id: '*group:perso', name: 'Perso', machines: ['', '6265617374'] }])
    expect(JSON.parse(r.patch.machineBarOrder)).toEqual(['*', '*group:perso', '', '6265617374'])
    expect(r.patch.theme).toBe('dark')
    expect(r.changes).toEqual([
      { setting: 'machineGroups', group: 'Perso', from: '23108ee8', label: 'Beast', to: 'beast' },
      { setting: 'machineGroups', group: 'Perso', from: 'f27df2ea', label: 'Work', to: null },
      { setting: 'machineBarOrder', group: undefined, from: '23108ee8', label: 'Beast', to: 'beast' },
      { setting: 'machineBarOrder', group: undefined, from: 'f27df2ea', label: 'Work', to: null },
      { setting: 'machineBarOrder', group: undefined, from: '0ff0ff00', label: undefined, to: null },
    ])
  })

  it('names machines for hc and skips those hc already has', () => {
    const r = mapMachines([{ label: 'Build VPS', target: 'vps', session: 'w' }, { label: 'Laptop', target: 'user@laptop', session: 'default' }, { label: 'build vps', target: 'vps2', session: 'default' }], [{ name: 'lap', target: 'user@laptop' }])
    expect(r.add.map((m: { name: string }) => m.name)).toEqual(['build-vps', 'build-vps-2'])
    expect(r.have).toMatchObject([{ name: 'lap' }])
    expect(sshProblem(fail(255, 'user@vps: Permission denied (publickey).'))).toMatch(/no SSH key login/)
    expect(sshProblem(fail(1))).toBeNull() // SSH works, hc not seen: hc machine add decides
    expect(sshProblem(ok('/home/u/.local/bin/hc'))).toBeNull()
    expect(mapMachines([{ label: 'Beast', target: 'mac', session: 'default' }, { label: 'My Mac (M2)!', target: 'm2', session: 'default' }, { label: 'x'.repeat(40), target: 'long', session: 'default' }]).add.map((m: { name: string }) => m.name))
      .toEqual(['beast', 'my-mac-m2', 'x'.repeat(32)])
  })
})

describe('runImport', () => {
  it('imports no project and reads nothing of herdr-projects, writes settings and the report, leaves v2 byte-identical, and is idempotent', () => {
    const before = hashTree(FIX)
    const data = tmp()
    const repoRoot = tmp()
    for (const r of ['app', 'site']) fs.mkdirSync(path.join(repoRoot, r))
    const v2 = { ...detectV2({ ...v2Opts, run: fakeRun().run }), dataDir: path.join(FIX, 'wherdr/data') }
    const { run, calls } = fakeRun()
    const spies = (['readFileSync', 'existsSync', 'readdirSync', 'statSync'] as const).map(f => vi.spyOn(fs, f))
    const r = runImport({ v2, dataDir: data, run, home: '/home/user', env: {}, appDir: '/home/user/wherdr-v3', hcSession: 'test', hcReachable: true, now: 1000 })
    expect(spies.flatMap(s => s.mock.calls).filter(([f]) => String(f).includes('herdr-projects'))).toEqual([])
    for (const s of spies) s.mockRestore()

    expect(fs.existsSync(path.join(data, 'projects'))).toBe(false)
    expect(fs.readdirSync(path.join(data, 'migration'))).toEqual(['imported.json'])
    const settings = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).settings
    expect(settings).toMatchObject({ theme: 'dark', typewriterSpeed: 'fast', showQuotas: '0' })
    // Group Perso: Laptop (added as laptop) is remapped, Build VPS (not added) dropped.
    expect(JSON.parse(settings.machineGroups)[0].machines).toEqual(['', v3MachineKey('laptop')])
    expect(fs.readFileSync(path.join(data, 'machine-label.txt'), 'utf8')).toBe('laptop\n')
    // Recent folders: herdr-projects' folders, herdr-web's and v3's own are left out.
    expect(JSON.parse(fs.readFileSync(path.join(data, 'dirs.json'), 'utf8'))).toEqual({ dirs: ['/home/user/code/app'] })
    expect(importArgs(['detect', '--herdr-projects', '/x'])).toEqual({ command: 'detect', notes: [expect.stringMatching(/^--herdr-projects is ignored/)] })
    // With another herdr-projects home, its default one still counts; v3's folder when the import runs alone.
    expect(keptDirs(['/srv/hp/main', '/home/user/.herdr-projects/data/main', '/opt/v2/x', '/opt/v2x', 'rel'], { home: '/home/user', env: { HERDR_PROJECTS_HOME: '/srv/hp' }, apps: ['/opt/v2'] })).toEqual(['/opt/v2x'])
    expect(v3AppDir('/opt/v3/data', '/home/user', '/opt/v3/src')).toBe('/opt/v3')
    expect(v3AppDir('/home/user/data', '/home/user', '/home/user/wherdr/src')).toBe('/home/user/wherdr/src')
    const alone = tmp()
    runImport({ v2, dataDir: alone, run: fakeRun().run, home: '/home/user', env: {}, hcSession: 'test', hcReachable: true })
    expect(JSON.parse(fs.readFileSync(path.join(alone, 'dirs.json'), 'utf8'))).toEqual({ dirs: ['/home/user/code/app'] })
    expect(fs.existsSync(path.join(data, 'auth.json'))).toBe(false)
    expect(calls).toContain('hc machine add user@laptop --name laptop --json')
    expect(r.machines.missing).toMatchObject([{ target: 'vps', reason: expect.stringMatching(/unreachable/), note: expect.stringMatching(/session was work/) }])

    const report = fs.readFileSync(path.join(data, 'migration-report.md'), 'utf8')
    expect(report).toContain('Not imported: Alfred offers to set up your v2 projects')
    expect(report).toContain('Added laptop (v2 name Laptop → laptop), user@laptop')
    expect(report).toContain('**To do:** build-vps (v2 name Build VPS → build-vps), vps: unreachable')
    expect(report).toMatch(/\*\*Passkeys\*\*: not moved/)
    expect(report).toContain('- machineGroups, group Perso: Laptop (v2 23108ee8) → laptop')
    expect(report).toContain('- machineGroups, group Perso: Build VPS (v2 f27df2ea) dropped: no v3 machine was made from it')

    const again = runImport({ v2, dataDir: data, run: fakeRun().run, hcSession: 'test', hcReachable: true, now: 2000 })
    expect(again.settings.files).toEqual([])
    expect(fs.readdirSync(path.join(data, 'migration')).filter(f => f.startsWith('report-'))).toHaveLength(1) // the first report is kept
    expect(hashTree(FIX)).toBe(before)
  })

  it('maps the Herdr profile aimed at this machine to v3\'s local machine, in the tabs and groups, and never adds it', () => {
    const v2 = { ...detectV2({ ...v2Opts, run: fakeRun().run, hostname: 'host-a' }), dataDir: path.join(FIX, 'wherdr/data') }
    expect(v2.self).toContain('host-a')
    const { run, calls } = fakeRun()
    const data = tmp()
    // Laptop's target names this machine, as its tailnet name did in v2.
    const r = runImport({ v2: { ...v2, self: [...v2.self, 'laptop.example.ts.net'] }, dataDir: data, run, env: {}, hcSession: 'test', hcReachable: true })
    expect(calls.filter(c => c.includes('user@laptop'))).toEqual([])
    expect(r.machines.local).toMatchObject([{ label: 'Laptop', target: 'user@laptop' }])
    const settings = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).settings
    expect(JSON.parse(settings.machineGroups)[0].machines).toEqual([''])
    expect(JSON.parse(settings.machineBarOrder)).toEqual(['*', '*group:perso', ''])
    const report = fs.readFileSync(path.join(data, 'migration-report.md'), 'utf8')
    expect(report).toContain('- Laptop (user@laptop): this machine, v3\'s Local')
    expect(report).toContain('- machineBarOrder: Laptop (v2 23108ee8) → Local')
  })

  it('never calls hc when its session is not running (hc would start one)', () => {
    const v2 = { ...detectV2({ ...v2Opts, run: fakeRun().run }), dataDir: path.join(FIX, 'wherdr/data') }
    const { run, calls } = fakeRun()
    const r = runImport({ v2, dataDir: tmp(), run, hcSession: 'none', env: { XDG_RUNTIME_DIR: tmp() } })
    expect(calls.filter(c => c.startsWith('hc '))).toEqual([])
    expect(r.machines.missing.map((m: { reason: string }) => m.reason)).toEqual([expect.stringMatching(/session none is not running/), expect.stringMatching(/session none is not running/)])
  })

  it('still tries hc machine add when the SSH probe does not see hc, and reports its own error', () => {
    const v2 = { ...detectV2({ ...v2Opts, run: fakeRun().run }), dataDir: path.join(FIX, 'wherdr/data'), machines: [{ label: 'Beast', target: 'mac', session: 'default' }, { label: 'Pi', target: 'pi', session: 'default' }] }
    const { run, calls } = fakeRun({ 'ssh -o BatchMode=yes -o ConnectTimeout=8 mac': fail(1), 'ssh -o BatchMode=yes -o ConnectTimeout=8 pi': fail(127, 'zsh: command not found'), 'hc machine add pi': fail(1, 'hc: not found on pi') })
    const data = tmp()
    const r = runImport({ v2, dataDir: data, run, hcSession: 'test', hcReachable: true, now: 1000 })
    expect(calls).toContain('hc machine add mac --name beast --json')
    expect(calls.find(c => c.startsWith('ssh ') && c.includes(' mac '))).toMatch(/\.local\/bin\/hc.*\/opt\/homebrew\/bin\/hc/)
    expect(r.machines.added).toMatchObject([{ name: 'beast', label: 'Beast' }])
    expect(r.machines.missing).toMatchObject([{ name: 'pi', reason: expect.stringMatching(/^hc machine add failed: hc: not found on pi .*install herdr-core/) }])
    const report = fs.readFileSync(path.join(data, 'migration-report.md'), 'utf8')
    expect(report).toContain('Added beast (v2 name Beast → beast), mac')
    expect(report).not.toMatch(/PATH/)
    const dry = runImport({ v2, dataDir: tmp(), run: fakeRun({ 'ssh -o BatchMode=yes -o ConnectTimeout=8 mac': fail(1) }).run, dryRun: true, hcReachable: true })
    expect(dry.machines.added[0]).toMatchObject({ name: 'beast', planned: true, check: expect.stringMatching(/looks for it itself/) })
  })

  it('writes nothing on a dry run', () => {
    const data = tmp()
    const v2 = { ...detectV2({ ...v2Opts, run: fakeRun().run }), dataDir: path.join(FIX, 'wherdr/data') }
    const { run, calls } = fakeRun()
    const r = runImport({ v2, dataDir: data, run, dryRun: true })
    expect(r.settings.files).toContain('dirs.json (this machine\'s recent folders)')
    expect(r.machines.added).toMatchObject([{ name: 'laptop', planned: true }])
    expect(calls.some(c => c.startsWith('hc machine add'))).toBe(false)
    expect(fs.readdirSync(data)).toEqual([])
  })
})

describe('installer', () => {
  it('parses options and refuses bad ones', () => {
    expect(parseArgs([], '/home/user')).toMatchObject({ dir: '/home/user/wherdr-v3', port: '7684', httpsPort: null, hcSession: 'default', name: 'wherdr-v3' })
    expect(parseArgs(['--yes', '--dry-run'], '/h').yes).toBe(false)
    expect(() => parseArgs(['--port', 'x'])).toThrow(/port/)
    expect(() => parseArgs(['--rm'])).toThrow(/unknown option/)
  })

  it('writes services that never inherit an agent session', () => {
    const hc = hcUnit({ hc: '/opt/hc', session: 's1', pathEnv: '/usr/bin' })
    expect(hc).toContain('Environment="HC_SESSION=s1"')
    expect(hc).toMatch(/UnsetEnvironment=CLAUDE_CODE_CHILD_SESSION/)
    expect(hc).toContain('ExecStart="/opt/hc" server start')
    const v3 = v3Unit({ node: '/usr/bin/node', dir: '/home/user/wherdr-v3', socket: '/run/user/1/herdr-core/s1.sock', port: '7684', hcService: 'wherdr-v3-hc.service' })
    expect(v3).toContain('Environment="HC_SOCKET=/run/user/1/herdr-core/s1.sock"')
    expect(v3).toContain('Wants=wherdr-v3-hc.service')
    expect(v3).toContain('Environment="DATA_DIR=/home/user/wherdr-v3/data"')
    expect(v3).toContain('OOMScoreAdjust=-900')
    expect(v3).not.toContain('APP_URL')
  })

  it('starts v3 with its HTTPS address and the protections of v2\'s unit', () => {
    const protect = unitProtections('[Service]\nOOMScoreAdjust=-800\nCPUWeight=500\n')
    expect(protect).toMatchObject({ OOMScoreAdjust: '-800', MemoryLow: '256M', CPUWeight: '500', from: "v2's unit" })
    expect(unitProtections('')).toMatchObject({ OOMScoreAdjust: '-900', from: 'defaults' })
    const v3 = v3Unit({ node: '/usr/bin/node', dir: '/d', socket: '/s', port: '7684', hcService: null, appUrl: 'https://host-a.tail.ts.net:8106/', protect })
    expect(v3).toContain('Environment="APP_URL=https://host-a.tail.ts.net:8106/"')
    expect(v3).toMatch(/OOMScoreAdjust=-800\nMemoryLow=256M\nCPUWeight=500/)
  })

  it('picks the first free https port, keeps its own, and names a free one on a conflict', () => {
    const entries = [{ https: '8103', proxy: 'http://127.0.0.1:7683' }, { https: '8104', proxy: 'http://127.0.0.1:7685' }, { https: '8105', proxy: 'http://127.0.0.1:7686' }]
    expect(pickHttpsPort({ entries, port: '7684' })).toEqual({ port: '8106', free: '8106', done: false })
    expect(pickHttpsPort({ entries, port: '7684', wanted: '8104' })).toMatchObject({ port: '8104', free: '8106', conflict: entries[1] })
    expect(pickHttpsPort({ entries: [...entries, { https: '8110', proxy: 'http://127.0.0.1:7684' }], port: '7684' })).toMatchObject({ port: '8110', done: true })
    expect(pickHttpsPort({ entries, port: '7684', previous: '8120' })).toMatchObject({ port: '8120', done: false })
  })

  it('gives the build 1.5 GB of heap on small machines, in the installer and update.sh', () => {
    expect(buildTuning(574 * 1048576)).toEqual({ heapMb: 574, nodeOptions: '--max-old-space-size=1536', prefix: 'nice -n 19 ionice -c3' })
    expect(buildTuning(574 * 1048576, false)?.prefix).toBe('nice -n 19')
    expect(buildTuning(2048 * 1048576)).toBeNull()
    expect(buildCommand('/d/src', buildTuning(574 * 1048576))).toContain('export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536"; { nice -n 19 ionice -c3 npm ci')
    expect(buildCommand('/d/src', null)).not.toContain('NODE_OPTIONS')
    const up = updateScript({ branch: 'v3', name: 'wherdr-v3', port: '7684' })
    expect(up).toContain(`-lt ${1536 * 1048576} ]`)
    expect(up).toContain('--max-old-space-size=1536')
    expect(up).toContain('$run npm run build')
    expect(hcTarget('linux', 'arm64')).toBe('linux-aarch64')
    expect(hcTarget('linux', 'x64')).toBe('linux-x86_64')
  })

  const io = (home: string, over: Record<string, Res> = {}) => fakeRun({ ...over, 'sh -c command -v': ok('/usr/bin/x'), 'systemctl --user show-environment': ok(), 'systemctl --user is-active': ok('inactive'), '/usr/bin/x --version': ok('hc 0.1.16') })

  it.runIf(process.platform === 'linux')('prints the plan and changes nothing without --yes', async () => {
    const home = tmp()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { run, calls } = io(home)
    const code = await main(['--json', '--port', '7699', '--https-port', '8105', ...['--v2-unit', v2Opts.unit, '--v2-dir', v2Opts.v2Dir]], { run, home, env: { XDG_RUNTIME_DIR: home } })
    const out = JSON.parse(log.mock.calls.at(-1)![0])
    vi.spyOn(console, 'error').mockRestore()
    log.mockRestore()
    expect(code).toBe(EXIT.ok)
    expect(out).toMatchObject({ applied: false, v2: { found: true, port: '7683', https: ['8103'] } })
    expect(out.plan.join('\n')).toMatch(/wherdr-v3-hc\.service[\s\S]*tailscale serve --bg --https=8105 http:\/\/127\.0\.0\.1:7699/)
    expect(fs.readdirSync(home)).toEqual([])
    expect(calls.filter(c => /enable|clone|serve --bg|machine add/.test(c))).toEqual([])
  })

  it.runIf(process.platform === 'linux')('with --auto-deploy, plans the prebuilt source and the timer, never a build', async () => {
    expect(() => parseArgs(['--auto-deploy', 'ftp://x'])).toThrow(/--auto-deploy/)
    expect(parseArgs(['--auto-deploy', 'https://b.tail.ts.net:8110/']).deploySource).toBe('https://b.tail.ts.net:8110/')
    const d = deployUnits({ dir: '/home/u/wherdr-v3', name: 'wherdr-v3', port: '7684', source: 'https://b.tail.ts.net:8110/' })
    expect(d.service).toContain('Environment="WHERDR_V3_SOURCE=https://b.tail.ts.net:8110/"')
    expect(d.service).toContain('ExecStart=/bin/bash "/home/u/wherdr-v3/pi-deploy-v3.sh"')
    expect(d.timer).toContain('OnUnitInactiveSec=3min')
    const home = tmp()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await main(['--json', '--port', '7699', '--https-port', '8105', '--auto-deploy', 'https://b.tail.ts.net:8110/', '--skip-import'], { run: io(home).run, home, env: { XDG_RUNTIME_DIR: home } })
    const plan = JSON.parse(log.mock.calls.at(-1)![0]).plan.join('\n')
    vi.spyOn(console, 'error').mockRestore()
    log.mockRestore()
    expect(code).toBe(EXIT.ok)
    expect(plan).toContain('install the latest prebuilt v3 from https://b.tail.ts.net:8110/')
    expect(plan).toContain('wherdr-v3-deploy.timer runs')
    expect(plan).not.toContain('npm ci')
  })

  it.runIf(process.platform === 'linux')('stops with a clear code when hc is missing or the https port is taken', async () => {
    const home = tmp()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const args = ['--v2-unit', v2Opts.unit, '--v2-dir', v2Opts.v2Dir, '--port', '7699']
    expect(await main(args, { run: io(home, { 'sh -c command -v hc': fail(1) }).run, home, env: {} })).toBe(EXIT.missing)
    expect(log.mock.calls.flat().join('\n')).toContain('ERROR missing-hc: herdr-core (hc) not found: install it with its official installer, curl -fsSL https://releases.herdr.dev/core/install.sh | sh')
    expect(await main([...args, '--https-port', '8103'], { run: io(home).run, home, env: {} })).toBe(EXIT.conflict)
    expect(log.mock.calls.flat().join('\n')).toMatch(/ERROR https-port-taken: .*8103.*\(8104 is free\)/)
    err.mockRestore(); log.mockRestore()
  })

  it.runIf(process.platform === 'linux')('lists every problem of a dry run at once', async () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, 'wherdr-v3'))
    fs.writeFileSync(path.join(home, 'wherdr-v3', 'mine'), '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const serve = { Web: { 'h:8103': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7683' } } }, 'h:8104': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7685' } } } } }
    const { run } = io(home, { 'sh -c command -v hc': fail(1), 'sh -c command -v git': fail(1), 'tailscale serve status --json': ok(JSON.stringify(serve)) })
    const code = await main(['--v2-unit', v2Opts.unit, '--v2-dir', v2Opts.v2Dir, '--port', '7683', '--https-port', '8104'], { run, home, env: {} })
    const errors = log.mock.calls.flat().filter(l => String(l).startsWith('ERROR')).map(l => String(l).split(':')[0])
    log.mockRestore()
    expect(code).toBe(EXIT.missing)
    expect(errors).toEqual(['ERROR missing-git', 'ERROR missing-hc', 'ERROR dir-exists', 'ERROR port-taken', 'ERROR https-port-taken'])
  })

  it.runIf(process.platform === 'linux')('plans a free https port, the commit, the build heap and the HTTPS address', async () => {
    const home = tmp()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const serve = { Web: Object.fromEntries([['8103', 7683], ['8104', 7685], ['8105', 7686]].map(([h, p]) => [`host-a.tail.ts.net:${h}`, { Handlers: { '/': { Proxy: `http://127.0.0.1:${p}` } } }])) }
    const { run } = io(home, {
      'tailscale serve status --json': ok(JSON.stringify(serve)),
      'tailscale status --json': ok(JSON.stringify({ Self: { DNSName: 'host-a.tail.ts.net.' } })),
      'git ls-remote': ok('0123456789abcdef0123456789abcdef01234567\trefs/heads/v3'),
    })
    const code = await main(['--json', '--port', '7699', '--v2-unit', v2Opts.unit, '--v2-dir', v2Opts.v2Dir], { run, home, env: { XDG_RUNTIME_DIR: home }, heapLimit: 574 * 1048576 })
    const out = JSON.parse(log.mock.calls.at(-1)![0])
    vi.spyOn(console, 'error').mockRestore()
    log.mockRestore()
    expect(code).toBe(EXIT.ok)
    expect(out).toMatchObject({ httpsPort: '8106', commit: '0123456789abcdef0123456789abcdef01234567' })
    const plan = out.plan.join('\n')
    expect(plan).toContain('(v3 at 0123456)')
    expect(plan).toContain("Node's heap is 574 MB, the build needs ~1.5 GB: NODE_OPTIONS=--max-old-space-size=1536, nice -n 19 ionice -c3")
    expect(plan).toContain('APP_URL https://host-a.tail.ts.net:8106/')
    expect(plan).toContain('OOMScoreAdjust=-900 MemoryLow=256M CPUWeight=200 from defaults')
    expect(plan).toContain('tailscale serve --bg --https=8106 http://127.0.0.1:7699 (added beside the existing entries, which use 8103, 8104, 8105)')
  })
})
