import { expect, it } from 'vitest'
import { cmdLaunchArgs, parseAgentCensus } from '../server/utils/agentCensus'

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')
const arg64 = (a: string[]) => b64(a.join('\0') + '\0')
const link64 = (p: string) => b64(p + '\n')
const res64 = (pairs: [string, string][]) => b64(pairs.map(([r, s]) => `${r}\x01${s}\x01`).join(''))
const H = (ok = 1) => `H 100 1767225600 ${ok}\n`
const S = (pid: number, o: { ppid?: number, ticks?: string, comm?: string, argv?: string[] | Buffer | null, cwd?: string, exe?: string, res?: [string, string][], up?: string, wall?: string } = {}) =>
  `S ${pid} ${o.ppid ?? 1} ${o.ticks ?? '12345'} ${o.up ?? '500.12'} ${o.wall ?? '1767226100.123456789'} ${b64(o.comm ?? 'node')} ${Buffer.isBuffer(o.argv) ? b64(o.argv) : arg64(o.argv ?? [])} ${o.cwd ? link64(o.cwd) : ''} ${o.exe ? link64(o.exe) : ''} ${res64(o.res ?? [])}\n`
const T = (n = 1, r = 1, o = 0, u = 0) => `T ${n} ${r} ${o} ${u}\n`
const PKGD = '/home/alice/.nvm/lib/node_modules/command-code/dist'
const ENTRY: [string, string][] = [[`/x/bin/cmd`, `${PKGD}/index.mjs`]]
const BORN = 1767225723464 // 500.12s uptime, tick 123.45+1s => boot*1000 + 123464ms

it('resolves a single cmd process: exact cwd, argv, birth bound, complete census', () => {
  const c = parseAgentCensus(H() + S(4242, { argv: ['node', '/x/bin/cmd', '--resume', 'acme-shop work'], cwd: '/work/acme-shop', exe: '/usr/bin/node', res: ENTRY }) + T())
  expect(c.complete).toBe(true)
  const p = c.processes[0]
  expect(p?.pid).toBe(4242)
  expect(p?.cwd).toBe('/work/acme-shop')
  expect(p?.argv).toEqual(['node', '/x/bin/cmd', '--resume', 'acme-shop work'])
  expect(p?.argvExact).toBe(true)
  expect(p?.startedAt).toBe(BORN)
})

it('keeps every independent and nested cmd peer (no ancestry dedup)', () => {
  const c = parseAgentCensus(H()
    + S(100, { argv: ['node', '/x/bin/cmd'], cwd: '/w/same', exe: '/usr/bin/node', res: ENTRY })
    + S(200, { ppid: 100, argv: ['node', '/x/bin/cmdc'], cwd: '/w/same', exe: '/usr/bin/node', res: [[`/x/bin/cmdc`, `${PKGD}/index.mjs`]] })
    + S(300, { argv: ['/x/bin/command-code'], cwd: '/w/other', exe: '/usr/bin/node' })
    + T(3, 3))
  expect(c.complete).toBe(true)
  expect(c.processes.map(p => p.pid).sort()).toEqual([100, 200, 300])
  expect(c.processes.find(p => p.pid === 200)?.ppid).toBe(100)
})

it('counts only the agent under a shell wrapper, never the wrapper itself', () => {
  const c = parseAgentCensus(H()
    + S(10, { comm: 'sh', argv: ['sh', '-c', 'command-code --resume acme-shop'], cwd: '/w/x', exe: '/bin/dash' })
    + S(11, { ppid: 10, argv: ['node', PKGD + '/index.mjs'], cwd: '/w/x', exe: '/usr/bin/node' })
    + T(2, 2))
  expect(c.processes.map(p => p.pid)).toEqual([11])
})

it('recognizes aliases, entrypoint shapes and node option positions; retitle loses argv', () => {
  for (const comm of ['command-code', 'command_code', 'commandcode', 'cmdc']) {
    const c = parseAgentCensus(H() + S(5, { comm, argv: [comm], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
    expect(c.processes[0]?.argvExact).toBe(false)
    expect(c.processes[0]?.argv).toEqual([comm])
  }
  const exact = parseAgentCensus(H() + S(6, { comm: 'commandcode', argv: ['/x/bin/commandcode', '-r', 'sess'], cwd: '/w/x', exe: '/x/bin/commandcode' }) + T())
  expect(exact.processes[0]?.argvExact).toBe(true)
  // Node option values are skipped: -r's operand is not the script.
  const opt = parseAgentCensus(H() + S(7, { argv: ['node', '-r', 'dotenv', PKGD + '/cli.mjs'], cwd: '/w/x', exe: '/usr/bin/node', res: [['dotenv', ''], [`${PKGD}/cli.mjs`, '']] }) + T())
  expect(opt.processes.map(p => p.pid)).toEqual([7])
})

it('rejects cmd.exe, bare cmd names, node scripts and command-code-dir lookalikes', () => {
  const rows = [
    S(1, { comm: 'cmd.exe', argv: ['cmd.exe', '/c', 'dir'], cwd: '/w/x', exe: '/x/cmd.exe' }),
    S(2, { comm: 'cmd', argv: ['cmd'], cwd: '/w/x', exe: '/x/bin/cmd' }), // native binary named cmd
    S(3, { argv: ['node', '/srv/app/server.js', 'run cmd now'], cwd: '/w/x', exe: '/usr/bin/node' }),
    S(4, { comm: 'bash', argv: ['bash', 'command-code'], cwd: '/w/x', exe: '/bin/bash' }),
    // A script inside a directory NAMED command-code is not a package entrypoint.
    S(8, { argv: ['node', '/srv/command-code/tools/build.js'], cwd: '/srv/command-code', exe: '/usr/bin/node', res: [['/srv/command-code/tools/build.js', '']] }),
  ]
  const c = parseAgentCensus(H() + rows.join('') + T(5, 5))
  expect(c.complete).toBe(true)
  expect(c.processes).toEqual([])
})

it('keeps NUL argv boundaries, blank args, unicode and newline/metachar cwd', () => {
  const cwd = '/w/acme shop\nλ & $x'
  const c = parseAgentCensus(H() + S(9, { argv: ['node', '/x/bin/cmdc', '', 'line\nbreak', 'a b'], cwd, exe: '/usr/bin/node', res: ENTRY }) + T())
  const p = c.processes[0]
  expect(p?.argv).toEqual(['node', '/x/bin/cmdc', '', 'line\nbreak', 'a b'])
  expect(p?.cwd).toBe(cwd)
})

it('fails closed on missing timing, cwd or argv for a relevant peer', () => {
  const noTicks = parseAgentCensus(H() + S(1, { ticks: '-', argv: ['/x/bin/cmdc'], cwd: '/w/x' }) + T())
  expect(noTicks.incomplete).toBe('metadata')
  expect(noTicks.processes[0]?.startedAt).toBeUndefined()
  const noCwd = parseAgentCensus(H() + `S 1 1 12345 500.12 1767226100.1 ${b64('node')} ${arg64(['node', '/x/bin/cmdc'])}  ${link64('/usr/bin/node')} \n` + T())
  expect(noCwd.incomplete).toBe('metadata')
  const noArgv = parseAgentCensus(H() + `S 1 1 12345 500.12 1767226100.1 ${b64('command-code')}  ${link64('/w/x')} ${link64('/usr/bin/node')} \n` + T())
  expect(noArgv.incomplete).toBe('metadata')
})

it('rejects an unterminated partial argv as exact evidence', () => {
  // node /x/bin/cmdc --resume NUL session-a NUL "partial" without terminal NUL.
  const c = parseAgentCensus(H() + S(1, { argv: Buffer.from('node\0/x/bin/cmdc\0--resume\0session-a\0partial'), cwd: '/w/x', exe: '/usr/bin/node', res: ENTRY }) + T())
  expect(c.incomplete).toBe('truncated')
  const p = c.processes[0]
  expect(p?.argv).toEqual(['node', '/x/bin/cmdc', '--resume', 'session-a'])
  expect(p?.argvExact).not.toBe(true)
})

it('marks a >16KiB cmdline an oversize partial census, never exact', () => {
  const long = 'x'.repeat(20000)
  const c = parseAgentCensus(H() + S(1, { argv: Buffer.from(`node\0/x/bin/cmdc\0${long}`), cwd: '/w/x', exe: '/usr/bin/node', res: ENTRY }) + T())
  expect(c.incomplete).toBe('oversize')
  const p = c.processes[0]
  expect(p?.argvTruncated).toBe(true)
  expect(p?.argvExact).not.toBe(true)
})

it('identifies only the script position; prompt arguments never prove identity', () => {
  // `cmd` is an argument to an unrelated script: once the script position is
  // known, later arguments must not supply identity.
  const arg = parseAgentCensus(H() + S(1, { argv: ['node', '/srv/server.js', 'cmd'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(arg.complete).toBe(true)
  expect(arg.processes).toEqual([])
  // Four -r operands consumed: the genuine entrypoint sits past position 4.
  const preload = parseAgentCensus(H() + S(2, { argv: ['node', '-r', 'a', '-r', 'b', '-r', 'c', '-r', 'd', `${PKGD}/index.mjs`], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(preload.processes.map(p => p.pid)).toEqual([2])
  const dd = parseAgentCensus(H() + S(3, { argv: ['node', '--', '/x/bin/cmdc'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(dd.processes.map(p => p.pid)).toEqual([3])
  // Value operands are never identity even when they name the package.
  const cond = parseAgentCensus(H() + S(4, { argv: ['node', '--conditions', 'command-code', '/srv/server.js'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(cond.complete).toBe(true)
  expect(cond.processes).toEqual([])
  // A preload of the real entrypoint also loads cmd in-process: a peer.
  const pl = parseAgentCensus(H() + S(6, { argv: ['node', '-r', `${PKGD}/index.mjs`, '/srv/server.js'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(pl.processes.map(p => p.pid)).toEqual([6])
})

it('marks unknown interpreter shapes incomplete instead of proving absence', () => {
  const u = parseAgentCensus(H() + S(1, { argv: ['node', '--mystery', '/srv/server.js'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(u.incomplete).toBe('metadata')
  const stdin = parseAgentCensus(H() + S(1, { argv: ['node', '-'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(stdin.incomplete).toBe('metadata')
  const bare = parseAgentCensus(H() + S(1, { argv: ['node'], cwd: '/w/x', exe: '/usr/bin/node' }) + T())
  expect(bare.incomplete).toBe('metadata')
  // Dynamic eval code is never an executable path or identity — incomplete.
  for (const argv of [['node', '-e', `require('${PKGD}/index.mjs')`], ['node', '-e', 'console.log("command-code")'], ['node', '--eval=x'], ['node', '-p', '1']]) {
    const e = parseAgentCensus(H() + S(1, { argv, cwd: '/w/x', exe: '/usr/bin/node' }) + T())
    expect(e.incomplete).toBe('metadata')
    expect(e.processes).toEqual([])
  }
  // Non-Node interpreters are outside the supported subset: unclassifiable.
  for (const [comm, argv] of [['deno', ['deno', 'run', '/x.ts']], ['bun', ['bun', '/x.js']]] as const) {
    expect(parseAgentCensus(H() + S(1, { comm, argv, cwd: '/w/x' }) + T()).incomplete).toBe('metadata')
  }
  const mix = parseAgentCensus(H()
    + S(1, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/x', exe: '/usr/bin/node' })
    + S(2, { argv: ['node', '--weird', 'x.js'], cwd: '/w/x', exe: '/usr/bin/node' }) + T(2, 2))
  expect(mix.incomplete).toBe('metadata')
  expect(mix.processes.map(p => p.pid)).toEqual([1])
})

it('caps record count and total bytes before trusting the scan', () => {
  const rec = S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' })
  const many = parseAgentCensus(H() + rec.repeat(300) + T(300, 300))
  expect(many.incomplete).toBe('oversize')
  expect(many.processes.length).toBeLessThanOrEqual(256) // allocation stops at the cap
  const early = parseAgentCensus(H() + 'x'.repeat(5 * 1024 * 1024) + '\n' + T(0, 0))
  expect(early.incomplete).toBe('oversize')
  expect(early.processes).toEqual([])
})

it('requires one header first and one footer last', () => {
  const s = S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' })
  expect(parseAgentCensus(s + H() + T()).incomplete).toBe('truncated') // record before header
  expect(parseAgentCensus(H() + T(0, 0) + s).incomplete).toBe('truncated') // footer not last
  expect(parseAgentCensus(H() + s + T(1, 9)).incomplete).toBe('truncated') // footer count mismatch
})

it('distinguishes unavailable, truncated, oversize, raced and unreadable peers', () => {
  expect(parseAgentCensus('H 100 1767225600 0\nT 0 0 0 0\n')).toMatchObject({ complete: false, incomplete: 'unavailable', processes: [] })
  expect(parseAgentCensus(H() + S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' })).incomplete).toBe('truncated') // no T
  expect(parseAgentCensus('garbage\nH 100 1 1\n').incomplete).toBe('truncated')
  expect(parseAgentCensus(H() + S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' }) + T(1, 7)).incomplete).toBe('truncated') // count mismatch
  expect(parseAgentCensus(H() + S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' }) + T(9, 1, 2)).incomplete).toBe('oversize')
  expect(parseAgentCensus('x'.repeat(70000) + '\n' + H()).incomplete).toBe('oversize') // giant line cap
  expect(parseAgentCensus(H() + 'R 55\n' + S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' }) + T(2, 1)).incomplete).toBe('raced')
  const u = parseAgentCensus(H() + S(1, { argv: ['/x/bin/cmdc'], cwd: '/w/x' }) + T(3, 1, 0, 4))
  expect(u.incomplete).toBe('metadata')
  expect(u.unknown).toBe(4)
  expect(u.processes).toHaveLength(1)
})

it('cmdLaunchArgs: proven direct and package launches yield agent args past the boundary', () => {
  // Direct bin/alias launches: argv0 alone proves it; args start after it.
  expect(cmdLaunchArgs(['cmd', '--session', '01234567-89ab-cdef-0123-456789abcdef'])).toEqual(['--session', '01234567-89ab-cdef-0123-456789abcdef'])
  expect(cmdLaunchArgs(['command-code', 'chat'])).toEqual(['chat'])
  expect(cmdLaunchArgs(['cmdc'])).toEqual([])
  // Node launches: the script position resolves to a proven bin/package path.
  expect(cmdLaunchArgs(['node', '/x/bin/cmd', '--resume', 'x'])).toEqual(['--resume', 'x'])
  expect(cmdLaunchArgs(['node', `${PKGD}/index.mjs`, '--session', '01234567-89ab-cdef-0123-456789abcdef'])).toEqual(['--session', '01234567-89ab-cdef-0123-456789abcdef'])
  expect(cmdLaunchArgs(['node', '--watch', `${PKGD}/cli.mjs`])).toEqual([])
  expect(cmdLaunchArgs(['node', '-r', '/x/bin/cmd', '/srv/app.js', 'go'])).toEqual(['go']) // preload proves, app arg boundary intact
})

it('cmdLaunchArgs: unproven launch shapes return null, never a guessed boundary', () => {
  // Shell roots — a shell that later exec'd cmd can never claim its own ticks.
  expect(cmdLaunchArgs(['bash', '-l'])).toBeNull()
  expect(cmdLaunchArgs(['sh', '-c', 'exec cmd'])).toBeNull()
  // Windows cmd.exe and any operand merely MENTIONING a cmd name are not a launch.
  expect(cmdLaunchArgs(['cmd.exe', '/c', 'cmd'])).toBeNull()
  expect(cmdLaunchArgs(['node', '-e', 'require("command-code")'])).toBeNull()
  expect(cmdLaunchArgs(['node', '-p', 'cmd'])).toBeNull()
  expect(cmdLaunchArgs(['node', '--eval', 'spawn("cmd")'])).toBeNull()
  // Arbitrary script paths, unterminated option operands, empty argv.
  expect(cmdLaunchArgs(['node', '/srv/server.js'])).toBeNull()
  expect(cmdLaunchArgs(['node', '/x/command-code/server.js'])).toBeNull() // dir name alone is not an entrypoint
  expect(cmdLaunchArgs(['node', '--import'])).toBeNull()
  expect(cmdLaunchArgs([])).toBeNull()
})
