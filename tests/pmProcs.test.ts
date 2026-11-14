import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOT, KILL_SCRIPT, KILL_UNDER, PROCS_SCRIPT, groupTargets, hotProcs, hotTargets, orphanTargets, parseProcs, seconds, worktreesIn, type HotSeen, type Proc } from '../shared/pm/procs'
import { killTerminal, leftoversKilled, sweepOrphans } from '../server/utils/pmProcs'
import type { PmLaunchDeps } from '../server/utils/pmLaunch'

const ROOT = '/home/user/.wherdr/pm/worktrees'
const p = (pid: number, ppid: number, pgid: number, comm = 'sh', tmp?: string, age = 60): Proc => ({ pid, ppid, pgid, age, comm, ...(tmp ? { tmp } : {}) })
// What PROCS_SCRIPT prints for these processes.
const text = (procs: Proc[]) => procs.map(x => [`p${x.pid}`, `P${x.ppid}`, `g${x.pgid}`, `t${x.age}`, `c${x.comm}`, ...(x.tmp ? [`e${x.tmp}`] : []), ...(x.unread ? ['u'] : []), ...(x.cwd ? [`n${x.cwd}`] : [])].join('\n')).join('\n')

describe('reading ps', () => {
  it('reads each field, ps\'s elapsed time and the agent mark', () => {
    expect(seconds('05:03')).toBe(303)
    expect(seconds('1-06:00:00')).toBe(108_000)
    const out = 'p7\nP1\ng7\nt06:00:01\nx12.5\nc/bin/sh\np7\ne/home/user/x\np8\nP7\ng7\nt01\ncCode Helper'
    expect(parseProcs(out)).toEqual([{ ...p(7, 1, 7, '/bin/sh', '/home/user/x', 21_601), cpu: 12.5 }, p(8, 7, 7, 'Code Helper', undefined, 1)])
  })
})

describe('the group kill', () => {
  // herdr-core 10 (group 10) runs the terminal's shell 20; claude 21 runs a test
  // runner 30 in its own group; its sh 31 was re-parented to init but keeps group 30.
  const procs = [p(1, 0, 1, 'launchd'), p(10, 1, 10, 'herdr-core'), p(20, 10, 20), p(21, 20, 20, 'claude'),
    p(30, 21, 30, 'node'), p(31, 1, 30), p(40, 10, 40), p(50, 1, 50, 'vim')]
  it('kills the shell\'s tree and every group in it, never herdr-core, init or another terminal', () => {
    expect(groupTargets(procs, 20)).toEqual([20, 21, 30, 31])
  })
  it('a shell that shares herdr-core\'s group leaves that group alone', () => {
    expect(groupTargets([p(10, 1, 10, 'herdr-core'), p(20, 10, 10), p(21, 20, 10), p(60, 10, 10)], 20)).toEqual([20, 21])
  })
  it('kills the processes after the terminal, with what was read before', async () => {
    const calls: string[] = []
    const deps = { call: async (method: string, params: { argv?: string[], on?: string }) => {
      const script = params.argv?.[2]
      calls.push(script === PROCS_SCRIPT ? `ps@${params.on}` : script === KILL_SCRIPT ? `kill@${params.on} ${params.argv!.slice(4).join(' ')}` : method)
      if (method === 'terminal.get') return { pid: 20 }
      if (method === 'terminal.kill') throw new Error('gone')
      return { code: 0, stdout: Buffer.from(text(procs)).toString('base64') }
    } } as unknown as PmLaunchDeps
    await expect(killTerminal(deps, 'vps/t-1')).rejects.toThrow('gone')
    expect(calls).toEqual(['terminal.get', 'ps@vps', 'terminal.kill', 'kill@vps 20 21 30 31'])
  })
})

describe('the orphan sweep', () => {
  const mark = (task: string) => `${ROOT}/${task}/.wherdr-tmp`
  // Only the mark counts, never the folder: the user's own processes have none.
  const procs = [
    p(1, 0, 1, '/sbin/launchd'),
    p(100, 1, 100, 'sh', mark('WH-1'), 21_600), p(101, 100, 100, 'ffmpeg', mark('WH-1')), // a finished task's test, re-parented
    p(110, 300, 110, 'node', mark('WH-1'), 30), // still under its old shell
    p(120, 1, 120, 'sh', mark('WH-9')), // a removed task
    p(200, 1, 200, 'sh', mark('WH-2')), // a live agent's
    p(300, 1, 300, 'Terminal'), p(301, 300, 301, 'zsh'), // the user's shell in a worktree: no mark
    p(400, 1, 400, '/Applications/Tailscale.app/Contents/MacOS/Tailscale'), // an app re-parented to launchd, its folder a removed worktree
    p(500, 1, 500, 'sh', '/home/user/project/.wherdr-tmp'), p(501, 1, 501, 'sh', `${ROOT}/WH-1`), // not a task's temp folder
    p(600, 1, 600, 'node', mark('WH-1')), // wherdr itself, kept
  ]
  it('kills every process marked with a finished or removed task\'s temp folder, nothing else', () => {
    expect(orphanTargets(procs, ROOT, id => id === 'WH-2', [600])).toEqual([
      { task: 'WH-1', pids: [100, 101, 110], age: 21_600, cpu: 0 },
      { task: 'WH-9', pids: [120], age: 60, cpu: 0 },
    ])
  })
  // macOS hides the environment of its own binaries: no mark on sh, zsh, sleep.
  const hidden = (x: Proc, cwd?: string): Proc => ({ ...x, unread: true, ...(cwd ? { cwd } : {}) })
  it('macOS: an unmarked sh goes with the marked leftover it is under or beside, or alone once re-parented in a finished worktree', () => {
    const wt = `${ROOT}/WH-1`
    const mac = [
      p(1, 0, 1, '/sbin/launchd'),
      p(100, 1, 100, 'node', mark('WH-1')), hidden(p(101, 100, 100, '/bin/sh')), hidden(p(102, 101, 100, '/bin/sleep')), // under a marked one
      hidden(p(105, 1, 100, '/bin/sh')), // re-parented, in its group
      hidden(p(110, 1, 110, '/bin/sh', undefined, 21_600), `${wt}/.wherdr-tmp/v`), hidden(p(111, 110, 110, '/bin/cat')), // the incident: alone, in the worktree
      hidden(p(200, 1, 200, '/bin/sh'), `${ROOT}/WH-2`), // a live task's
      p(300, 1, 300, 'Terminal'), hidden(p(301, 300, 301, '/bin/zsh'), wt), // the user's shell there
      p(400, 1, 400, '/Applications/Tailscale.app/Contents/MacOS/Tailscale', undefined), // an app, its environment readable: no mark
      { ...p(401, 1, 401, 'tmux'), cwd: wt }, // the user's tmux server there
      hidden(p(500, 1, 500, '/bin/sh'), '/home/user/project'), // elsewhere
      hidden(p(600, 1, 600, '/Applications/Some.app/Contents/MacOS/Some'), `${ROOT}/WH-1`), // an app whose environment is hidden: not a system binary
    ]
    expect(orphanTargets(mac, ROOT, id => id === 'WH-2')).toEqual([{ task: 'WH-1', pids: [100, 101, 102, 105, 110, 111], age: 21_600, cpu: 0 }])
  })
  // Recorded on macOS: two `sh -c` (ps shows `sh`) of a test, re-parented to
  // launchd, at 90 % CPU for 3 h 30 in a worktree removed since (lsof still
  // shows its path; no `w` line for it).
  it('macOS: a bare `sh` re-parented to launchd in a removed worktree goes, a user\'s `sh` elsewhere stays', () => {
    const rec = (pid: number, ppid: number, cpu: string, comm: string) => `p${pid}\nP${ppid}\ng${pid}\nt03:30:00\nx${cpu}\nc${comm}`
    const out = [
      rec(1, 0, '0.0', '/sbin/launchd'), rec(701, 1, '90.1', 'sh'), rec(702, 1, '89.7', 'sh'),
      rec(703, 1, '0.0', 'sh'), rec(704, 1, '50.0', 'sh'), rec(705, 1, '0.0', 'sh'),
      'W', 'wWH-2', 'wWH-3',
      'p1', 'p701\nu', 'p702\nu', 'p703\nu', 'p704\nu', 'p705\nu',
      `p701\nfcwd\nn${ROOT}/WH-204`, `p702\nfcwd\nn${ROOT}/WH-204/src`,
      'p703\nfcwd\nn/home/user/project', // the user's own sh
      `p704\nfcwd\nn${ROOT}/WH-2`, // a live task's, its worktree there
      `p705\nfcwd\nn${ROOT}/WH-5`, // its run still says live, its worktree removed
    ].join('\n')
    expect(orphanTargets(parseProcs(out), ROOT, id => id === 'WH-2' || id === 'WH-5', [], worktreesIn(out))).toEqual([
      { task: 'WH-204', pids: [701, 702], age: 12_600, cpu: 90.1 },
      { task: 'WH-5', pids: [705], age: 12_600, cpu: 0 },
    ])
  })
  it('the last worktree removed: an empty root read is no worktree at all, an unread one is unknown', () => {
    const procs = [p(1, 0, 1, '/sbin/launchd'), { ...p(701, 1, 701, 'sh'), unread: true as const, cwd: `${ROOT}/WH-5` }]
    expect(orphanTargets(procs, ROOT, () => true, [], worktreesIn('p1\nW')).map(f => f.pids)).toEqual([[701]])
    expect(orphanTargets(procs, ROOT, () => true, [], worktreesIn('p1'))).toEqual([])
  })
  // Recorded on Linux: no mark on a process the agent's tools started with a
  // clean environment; its folder from /proc/<pid>/cwd.
  it('Linux: a hot unmarked process is known by its folder', () => {
    const out = `p900\nP1\ng900\nt25:00\nx97.0\ncnode\nW\nwWH-2\np900\nn${ROOT}/WH-2/web`
    expect(hotProcs(parseProcs(out), ROOT).map(h => [h.task, h.proc.pid])).toEqual([['WH-2', 900]])
  })
  it('the CPU guard: hot 20 min after its agent ended, killed; while it runs, its coordinator told once', () => {
    const hot = (cpu: number, tmp?: string, cwd?: string): Proc => ({ ...p(800, 1, 800, 'node', tmp), cpu, ...(cwd ? { cwd } : {}) })
    expect(hotProcs([hot(95, mark('WH-1')), { ...hot(95, undefined, `${ROOT}/WH-2/web`), pid: 801 }, { ...hot(95, undefined, '/home/user/x'), pid: 802 }, { ...hot(30, mark('WH-1')), pid: 803 }], ROOT, [])
      .map(h => [h.task, h.proc.pid])).toEqual([['WH-1', 800], ['WH-2', 801]])
    const seen: HotSeen = new Map(), min = 60_000
    const sweep = (at: number, live: boolean, cpu = 95) => hotTargets(seen, hotProcs([hot(cpu, mark('WH-1'))], ROOT), () => live, at * min)
    expect(sweep(0, true)).toEqual({ kill: [], tell: [] })
    expect(sweep(HOT.ms / min, true).tell.map(h => h.proc.pid)).toEqual([800])
    // No coordinator took it (autopilot off): offered again, until one does.
    const [again] = sweep(HOT.ms / min + 5, true).tell
    seen.get(again!.key)!.told = true
    expect(sweep(HOT.ms / min + 10, true).tell).toEqual([]) // once
    expect(sweep(30, false).kill).toEqual([]) // its agent just ended: 20 min from now
    expect(sweep(45, false, 10).kill).toEqual([]) // cooled down: forgotten
    expect(sweep(50, false).kill).toEqual([])
    expect(sweep(70, false).kill.map(h => h.proc.pid)).toEqual([800])
  })
  it('logs the kill on the task and counts it for the machine', async () => {
    const logs: string[] = [], kills: string[][] = []
    const deps = {
      machines: () => [{ key: '', label: 'here', local: true, status: 'online' }],
      call: async (_m: string, params: { argv: string[] }) => {
        const script = params.argv[2]
        if (script === KILL_SCRIPT) kills.push(params.argv.slice(4))
        const out = script === PROCS_SCRIPT ? text(procs) : '/home/user'
        return { code: 0, stdout: Buffer.from(out).toString('base64') }
      },
      store: {
        enabled: async () => true,
        runs: async () => [{ task: 'WH-1', machine: '', state: 'ended' }, { task: 'WH-2', machine: '', state: 'running' }],
        task: async (id: string) => (id === 'WH-1' ? { id } : undefined),
        logTask: async (_t: unknown, _by: string, line: string) => { logs.push(line) },
      },
    } as unknown as PmLaunchDeps
    await sweepOrphans(deps)
    expect(kills.map(k => k.join(' '))).toEqual(['100 101 110 600', '120'])
    expect(logs).toEqual(['killed 4 leftover processes, 6 h old'])
    expect(leftoversKilled('')).toBe(5)
  })
})

// Before a worktree goes: macOS's lsof stood in for (uname, lsof on PATH).
describe('the kill before a worktree is removed', () => {
  const run = (lsof: string, prelude = '', lsofCode = 0, ps = '') => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-kill-'))
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\nprintf '%s' '${lsof}'\nexit ${lsofCode}\n`, { mode: 0o755 })
    if (ps) fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\n${ps}\n`, { mode: 0o755 })
    try {
      execFileSync('sh', ['-c', `${prelude}dir=/x/WH-1\n${KILL_UNDER}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10_000 })
      return { code: 0 }
    } catch (e) { return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout) } }
    finally { fs.rmSync(bin, { recursive: true, force: true }) }
  }
  it('stops when the folders cannot be read, or a process there survives', () => {
    const unlisted = { code: 3, out: 'the processes working in it could not be listed\n' }
    expect(run('')).toEqual(unlisted)
    expect(run('p1\nfcwd\nn/\n', '', 2)).toEqual(unlisted) // lsof failed after one record
    const stuck = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      // kill does nothing: the process survives, nothing counted as killed.
      const survived = { code: 3, out: 'a process working in it could not be killed\n' }
      expect(run(`p${stuck.pid}\nfcwd\nn/x/WH-1/src\n`, 'kill() { :; }\n')).toEqual(survived)
      // Signals refused and ps failing: unknown, so still running.
      expect(run(`p${stuck.pid}\nfcwd\nn/x/WH-1/src\n`, 'kill() { echo "kill: Operation not permitted" >&2; return 1; }\n', 0, 'exit 2')).toEqual(survived)
    } finally { stuck.kill('SIGKILL') }
  }, 20_000) // each survivor waits out TERM then KILL (~3.5 s)
})
