// No process outlives its agent (shared/pm/procs.ts decides which): ending an
// agent kills its terminal's tree and process groups on its machine, and a
// sweep at start and every few minutes kills what agents of tasks with no live
// agent left (by the temp folder they inherit), one line in the task's log
// each time, and runs the CPU guard (hotTargets).
import { dirname } from 'node:path'
import { HOT, KILL_SCRIPT, PROCS_SCRIPT, ageText, groupTargets, hotProcs, hotTargets, orphanTargets, parseProcs, worktreesIn, type HotSeen } from '../../shared/pm/procs'
import { taskPaths } from '../../shared/pm/run'
import { homeOf } from './coreCreate'
import { exec, runOn, type PmLaunchDeps } from './pmLaunch'
import { wakeCoordinators } from './pmWakes'

type Deps = Pick<PmLaunchDeps, 'call'>

// Ends a terminal and every process it started: its shell's pid read first
// (killing the terminal re-parents them), TERM then KILL after 3 s. Throws
// what terminal.kill throws, the processes killed all the same.
export async function killTerminal(deps: Deps, terminal: string) {
  const on = terminal.includes('/') ? terminal.split('/')[0] : undefined // the address's machine
  const pid = (await deps.call<{ pid?: number }>('terminal.get', { terminal }, 3000).catch(() => null))?.pid
  const ps = typeof pid === 'number' ? await exec(deps, on, PROCS_SCRIPT, [], undefined, 15).catch(() => null) : null
  const pids = ps?.code === 0 ? groupTargets(parseProcs(ps.out), pid!) : []
  try { await deps.call('terminal.kill', { terminal }, 15000) }
  finally { if (pids.length) await exec(deps, on, KILL_SCRIPT, pids.map(String), undefined, 15).catch(() => {}) }
}

// Leftover processes killed per machine since wherdr started (Settings › Machines).
const killed = new Map<string, number>()
export const leftoversKilled = (machine: string) => killed.get(machine) ?? 0
export const countKilled = (machine: string, n: number) => { killed.set(machine, leftoversKilled(machine) + n) }
const hotSeen = new Map<string, HotSeen>()
const plural = (n: number) => `${n} leftover process${n === 1 ? '' : 'es'}`

// Every machine a task ran on: the processes marked with the temp folder of a
// task that has no live agent (or is gone) go.
export async function sweepOrphans(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return
  for (const machine of new Set((await store.runs()).map(r => r.machine))) {
    let on: string | undefined
    try { on = runOn(deps, { machine }) } catch { continue }
    const home = await homeOf(deps, on).catch(() => '')
    if (!home) continue
    const root = dirname(taskPaths(home, 'x').worktree)
    const ps = await exec(deps, on, PROCS_SCRIPT, ['env', root], undefined, 30).catch(() => null)
    if (ps?.code !== 0) continue
    // Read after the processes: a run saved before its terminal starts is live by then.
    const live = new Set((await store.runs()).filter(r => r.state !== 'ended').map(r => r.task)), isLive = (id: string) => live.has(id)
    const procs = parseProcs(ps.out), keep = machine ? [] : [process.pid]
    const gone = new Set<number>()
    const kill = async (id: string, pids: number[], what: string) => {
      if ((await exec(deps, on, KILL_SCRIPT, pids.map(String), undefined, 15).catch(() => null))?.code !== 0) return
      pids.forEach(p => gone.add(p))
      countKilled(machine, pids.length)
      const task = await store.task(id)
      if (task) await store.logTask(task, 'engine', what)
      else console.warn(`[pm] ${what} (removed task ${id})`)
    }
    for (const f of orphanTargets(procs, root, isLive, keep, worktreesIn(ps.out)))
      await kill(f.task, f.pids, `killed ${plural(f.pids.length)}, ${ageText(f.age)} old${f.cpu >= 10 ? `, ${Math.round(f.cpu)} % CPU` : ''}`)
    if (!hotSeen.has(machine)) hotSeen.set(machine, new Map())
    const seen = hotSeen.get(machine)!
    const hot = hotTargets(seen, hotProcs(procs, root, keep).filter(h => !gone.has(h.proc.pid)), isLive, now)
    const facts = (h: (typeof hot.kill)[number]) => `${h.proc.comm.split('/').pop()} (pid ${h.proc.pid}) at ${Math.round(h.proc.cpu ?? 0)} % CPU for over ${HOT.ms / 60_000} min, ${ageText(h.proc.age)} old`
    for (const h of hot.kill) await kill(h.task, [h.proc.pid], `killed ${facts(h)}, after its agent ended`)
    for (const h of hot.tell) {
      const task = await store.task(h.task)
      // Told once a coordinator gets it: none now (autopilot off, out of hours), the next sweep tries again.
      if (task && (await wakeCoordinators(deps, task, `${h.task}: ${facts(h)}, in its folder on ${deps.machines().find(m => m.key === machine)?.label ?? 'its machine'}. Kill it if it is stuck.`, now)).length) seen.get(h.key)!.told = true
    }
  }
}
