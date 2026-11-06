import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AGENT_CENSUS_SCRIPT, agentCensus, localShell } from '../server/utils/agentProcesses'
import { parseAgentCensus } from '../server/utils/agentCensus'
import { createCmdCore } from '../server/utils/commandCodeCore'
import { type ShellExec, shq } from '../server/utils/fsx'
import { CMD_FILES_SCRIPT, CMD_HEADERS_SCRIPT, F, filesWire, hdrs, HOME, live, POST, sess, st, U1 } from './cmdCoreFixture'

const linux = it.runIf(process.platform === 'linux')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })
const BORN = 1767225723464 // 500.12s uptime, tick 123.45+1s => boot*1000 + 123464ms

// Deterministic timebase: uptime 500.12, btime 1767225600, a `date` shim that
// prints the fixed wall clock -> tick 12345 yields birth bound BORN exactly.
function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'procx-'))
  roots.push(root)
  fs.mkdirSync(`${root}/bin`)
  fs.writeFileSync(`${root}/bin/date`, '#!/bin/sh\necho 1767226100.123456789\n', { mode: 0o755 })
  fs.writeFileSync(`${root}/uptime`, '500.12 1234.56\n')
  fs.writeFileSync(`${root}/stat`, 'cpu  0 0 0 0\nbtime 1767225600\n')
  return root
}
const inPath = (root: string): typeof localShell =>
  (script, args, opts) => localShell(`export PATH=${shq(`${root}/bin`)}:$PATH\n${script}`, args, opts)
const run = (root: string, maxr?: string) => inPath(root)(AGENT_CENSUS_SCRIPT, maxr ? [root, '8192', maxr] : [root], { timeoutMs: 8000 })
  .then(r => parseAgentCensus(r.stdout.toString('utf8')))

// stat layout: pid (comm) state ppid <17 zeros> startticks ...  (starttime is field 22)
function fakeProc(root: string, pid: number, o: { comm?: string, state?: string, ppid?: number, ticks?: number, argv?: string[] | null, cwd?: string, exe?: string, unreadable?: boolean, noStat?: boolean, noCmdline?: boolean }) {
  const d = `${root}/${pid}`
  fs.mkdirSync(d)
  if (o.noStat) return
  fs.writeFileSync(`${d}/stat`, `${pid} (${o.comm ?? 'node'}) ${o.state ?? 'S'} ${o.ppid ?? 1} ` + '0 '.repeat(17) + `${o.ticks ?? 12345} 0 0 0 0\n`)
  if (!o.noCmdline) fs.writeFileSync(`${d}/cmdline`, o.argv == null ? '' : Buffer.from(o.argv.join('\0') + '\0'))
  fs.writeFileSync(`${d}/comm`, `${o.comm ?? 'node'}\n`)
  if (o.cwd) fs.symlinkSync(o.cwd, `${d}/cwd`)
  if (o.exe) fs.symlinkSync(o.exe, `${d}/exe`)
  if (o.unreadable) for (const f of ['stat', 'cmdline', 'comm']) fs.chmodSync(`${d}/${f}`, 0)
}

linux('census over a synthetic /proc: bin-symlink, retitled, wrapper and nested peers', async () => {
  const root = fakeRoot()
  const pkg = `${root}/pkg/command-code/dist`
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(`${pkg}/index.mjs`, '// x')
  fs.symlinkSync('../pkg/command-code/dist/index.mjs', `${root}/bin/cmd`) // bin/ already holds the date shim
  fakeProc(root, 101, { argv: ['node', `${root}/bin/cmd`, '-r', 'sess a'], cwd: '/work/acme shop', exe: '/usr/bin/node' })
  fakeProc(root, 102, { comm: 'command-code', argv: ['command-code'], cwd: '/work/other\n', exe: '/usr/bin/node' }) // retitled; trailing-newline cwd
  fakeProc(root, 103, { comm: 'sh', argv: ['sh', '-c', 'command-code'], cwd: '/work/acme shop', exe: '/bin/dash' }) // wrapper, not a peer
  fakeProc(root, 104, { ppid: 102, comm: 'command-code', argv: ['command-code'], cwd: '/work/nested', exe: '/usr/bin/node' }) // nested cmd: still a peer
  fakeProc(root, 105, { comm: 'kworker/1:0', argv: [] }) // kernel-thread shape
  const c = await agentCensus(inPath(root), { procRoot: root })
  expect(c.complete).toBe(true)
  expect(c.processes.map(p => p.pid).sort()).toEqual([101, 102, 104])
  const p = c.processes.find(p => p.pid === 101)!
  expect(p.argv).toEqual(['node', `${root}/bin/cmd`, '-r', 'sess a'])
  expect(p.argvExact).toBe(true)
  expect(p.cwd).toBe('/work/acme shop')
  expect(p.startedAt).toBe(BORN)
  const rt = c.processes.find(p => p.pid === 102)!
  expect(rt.argvExact).toBe(false)
  expect(rt.cwd).toBe('/work/other\n') // real trailing newline survives
})

linux('an unclassifiable live interpreter stays emitted bounded evidence', async () => {
  const root = fakeRoot()
  fakeProc(root, 201, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/x', exe: '/usr/bin/node' })
  fakeProc(root, 202, { comm: 'node', argv: null, cwd: '/w/x', exe: '/usr/bin/node', unreadable: false })
  fs.chmodSync(`${root}/202/cmdline`, 0) // live node, unreadable cmdline: a possible hidden peer
  fakeProc(root, 203, { comm: 'sshd', argv: null }) // unrelated unreadable: does not disable
  fs.chmodSync(`${root}/203/cmdline`, 0)
  fakeProc(root, 204, { comm: 'command-code', argv: null, state: 'Z' }) // proven zombie: not a peer
  const c = await agentCensus(inPath(root), { procRoot: root })
  // 202's stat/generation and cwd read fine: emit it as scoped evidence
  // rather than a recordless footer unknown. Its argv stays empty — never
  // a proven other, and the lookup decides relevance by cwd.
  expect(c.complete).toBe(true)
  expect(c.unknown).toBe(0)
  expect(c.processes.map(p => p.pid)).toEqual([201])
  expect(c.uncertain.map(p => p.pid)).toEqual([202])
  expect(c.uncertain[0]).toMatchObject({ pid: 202, comm: 'node', cwd: '/w/x' })
  expect(c.uncertain[0]?.argv).toBeUndefined()
})

linux('unreadable or vanished potential peers keep the census honest', async () => {
  const root = fakeRoot()
  fakeProc(root, 301, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/x', exe: '/usr/bin/node' })
  fakeProc(root, 302, { comm: 'command-code', argv: ['command-code'], cwd: '/w/y', exe: '/usr/bin/node', unreadable: true })
  fakeProc(root, 303, { noStat: true }) // vanished before sampling
  const c = await agentCensus(inPath(root), { procRoot: root })
  expect(c.incomplete).toBe('metadata')
  expect(c.unknown).toBe(1)
  expect(c.processes.map(p => p.pid)).toEqual([301])
})

linux('relative entrypoint resolves through the process cwd link', async () => {
  const root = fakeRoot()
  const pkg = `${root}/pkg/command-code/dist`
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(`${pkg}/index.mjs`, '// x')
  fakeProc(root, 401, { argv: ['node', 'index.mjs'], cwd: pkg, exe: '/usr/bin/node' })
  fakeProc(root, 402, { argv: ['node', 'index.mjs'], cwd: '/srv/plain-app', exe: '/usr/bin/node' })
  const c = await agentCensus(inPath(root), { procRoot: root })
  expect(c.processes.map(p => p.pid)).toEqual([401])
})

linux('producer finds the entrypoint behind node options; unknown shapes stay scoped', async () => {
  const root = fakeRoot()
  const pkg = `${root}/pkg/command-code/dist`
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(`${pkg}/index.mjs`, '// x')
  fakeProc(root, 601, { argv: ['node', '-r', 'a', '-r', 'b', '-r', 'c', '-r', 'd', `${pkg}/index.mjs`], cwd: '/w/x', exe: '/usr/bin/node' })
  fakeProc(root, 602, { argv: ['node', '/srv/server.js', 'cmd'], cwd: '/w/x', exe: '/usr/bin/node' }) // arg, not identity
  fakeProc(root, 603, { argv: ['node', '--mystery', 'x.js'], cwd: '/w/x', exe: '/usr/bin/node' }) // unknown launch shape
  fakeProc(root, 604, { argv: ['node', '-e', `require('${pkg}/index.mjs')`], cwd: '/w/x', exe: '/usr/bin/node' }) // eval: unclassifiable
  fakeProc(root, 605, { argv: ['node', '--conditions', 'command-code', '/srv/server.js'], cwd: '/w/x', exe: '/usr/bin/node' }) // value operand: not identity
  const c = await agentCensus(inPath(root), { procRoot: root })
  expect(c.complete).toBe(true)
  expect(c.processes.map(p => p.pid)).toEqual([601])
  // Emitted unclassifiable records keep their cwd: scoped evidence, not a
  // global failure and never a proven other.
  expect(c.uncertain.map(p => p.pid).sort()).toEqual([603, 604])
  expect(c.uncertain.every(p => p.cwd === '/w/x')).toBe(true)
})

linux('real emitted unknowns reach the locator scoped by cwd', async () => {
  // The real census script against a synthetic /proc, then the real locator:
  // unknowns in other cwds cannot void the lookup; in the target cwd they do.
  // 306's cmdline is unreadable: its stat/generation and cwd still emit it as
  // scoped evidence rather than a recordless footer unknown.
  const mkProc = (cwds: (string | undefined)[]) => {
    const root = fakeRoot()
    fakeProc(root, 301, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/proj', exe: '/usr/bin/node' })
    fakeProc(root, 302, { comm: 'node', argv: ['/opt/tools/node_repl'], cwd: cwds[0], exe: '/usr/bin/node' })
    fakeProc(root, 303, { argv: ['node', '-e', 'tick()'], cwd: cwds[1], exe: '/usr/bin/node' })
    fakeProc(root, 304, { comm: 'bun', argv: ['bun', '/srv/app.js'], cwd: cwds[2], exe: '/usr/bin/bun' })
    fakeProc(root, 305, { comm: 'deno', argv: ['deno', 'run', '/srv/x.ts'], cwd: cwds[3], exe: '/usr/bin/deno' })
    fakeProc(root, 306, { comm: 'node', argv: null, cwd: cwds[4], exe: '/usr/bin/node' })
    fs.chmodSync(`${root}/306/cmdline`, 0) // unreadable cmdline, readable stat/cwd
    return root
  }
  const wire = (root: string): ShellExec => async (s, a, o) => {
    if (s === AGENT_CENSUS_SCRIPT) return inPath(root)(s, [root], o)
    if (s === CMD_FILES_SCRIPT) return { code: 0, stdout: Buffer.from(filesWire([[F('a', U1), st(POST)]])), stderr: '' }
    if (s === CMD_HEADERS_SCRIPT) return { code: 0, stdout: Buffer.from(hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })(a ?? [])), stderr: '' }
    return { code: 1, stdout: Buffer.alloc(0), stderr: 'x' }
  }
  const detail = live({ pid: 9000, foreground: { pid: 301 } })
  expect(await createCmdCore(wire(mkProc(['/w/repl', '/w/eval', '/w/bun', '/w/deno', '/w/empty'])), HOME).locate(detail))
    .toEqual({ file: F('a', U1), session: U1 })
  expect(await createCmdCore(wire(mkProc(['/w/proj', '/w/proj', '/w/proj', '/w/proj', '/w/proj'])), HOME).locate(detail))
    .toEqual({ unavailable: 'peers' })
  // An emitted unknown with no readable cwd can never prove irrelevance.
  expect(await createCmdCore(wire(mkProc(['/w/repl', '/w/eval', '/w/bun', '/w/deno', undefined])), HOME).locate(detail))
    .toEqual({ unavailable: 'peers' })
})

linux('producer stdout is capped before the exec reply', async () => {
  const root = fakeRoot()
  const big = 'y'.repeat(16000) // ~22 KiB base64 per record
  for (let i = 0; i < 170; i++) fakeProc(root, 1000 + i, { argv: ['node', '/x/bin/cmdc', big], cwd: '/w/x', exe: '/usr/bin/node' })
  const r = await inPath(root)(AGENT_CENSUS_SCRIPT, [root], { timeoutMs: 30000 })
  expect(r.stdout.length).toBeLessThanOrEqual(3_200_000)
  expect(parseAgentCensus(r.stdout.toString('utf8')).incomplete).toBe('oversize')
}, 30000)

linux('record cap, missing proc and missing uptime never yield a usable sole peer', async () => {
  const root = fakeRoot()
  fakeProc(root, 501, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/x', exe: '/usr/bin/node' })
  fakeProc(root, 502, { argv: ['node', '/x/bin/cmdc'], cwd: '/w/y', exe: '/usr/bin/node' })
  expect((await agentCensus(inPath(root), { procRoot: root })).complete).toBe(true)
  expect((await run(root, '1')).incomplete).toBe('oversize')
  expect((await agentCensus(inPath(root), { procRoot: `${root}/gone` })).incomplete).toBe('unavailable')
  fs.rmSync(`${root}/uptime`)
  expect((await agentCensus(inPath(root), { procRoot: root })).incomplete).toBe('unavailable')
})
