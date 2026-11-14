// Is a machine other than the project's own ready to take its task? Run before
// a task's first start there (shared/pm/ready.ts): the start is refused with
// each failed check. A machine found ready is trusted for 10 minutes; any
// result is kept for the board's "Start on…" menu.
import { HerdrError } from './herdr'
import { PATH_SETUP, homeOf, machineOn } from './coreCreate'
import { exec, wherdrBase, type PmLaunchDeps } from './pmLaunch'
import { READY_SCRIPT, readyOf, readyRefusal, type Readiness } from '../../shared/pm/ready'
import { reviewerPlan, shotStep, taskBase, taskPlan, workerPlan, type Task } from '../../shared/pm/run'
import { cloneOn, type Project } from '../../shared/pm/project'
import type { Template } from '../../shared/pm/workflow'

const FRESH_MS = 10 * 60_000
const last = new Map<string, Readiness & { refused?: string }>() // project|machine|visual → its last check

// The last check's failure, for the board ('' ready, undefined never checked).
export const lastReadiness = (project: string, machine: string) => {
  const r = last.get(`${project}|${machine}|0`) ?? last.get(`${project}|${machine}|1`)
  return r && (r.refused ?? '')
}

// Runs READY_SCRIPT for a task of the project (none: a task of its workflow's
// first type, without the visual checks) and keeps the result.
async function runCheck(deps: PmLaunchDeps, p: Project, t: Template | null, task: Task | undefined, machine: string, clone: string) {
  const visual = !!task && !!t && !!shotStep(t, task.type)
  const on = machineOn(deps, machine).on
  const origin = await exec(deps, machineOn(deps, p.machine).on, 'git -C "$1" remote get-url origin', [p.path]).catch(() => ({ out: '' }))
  const type = task?.type ?? Object.keys(t?.taskTypes ?? {})[0]
  const as = task ?? (type ? { type } as Task : undefined)
  const programs = t && as ? [...new Set([workerPlan(t, as), reviewerPlan(t, as)].flatMap(x => ('program' in x ? [x.program] : [])))] : []
  const gh = !!t && !!as && taskPlan(t, as, p).some(s => s.action?.kind.startsWith('github.'))
  const base = as ? taskBase(as, p) ?? '' : p.base ?? ''
  const args = [clone, base, visual ? wherdrBase(machine, deps.origin) : '', gh ? '1' : '0', visual ? '1' : '0', ...programs]
  const r = await exec(deps, on, `${PATH_SETUP}\n${READY_SCRIPT}`, args, undefined, 90).catch(() => ({ out: '' }))
  const ready = readyOf(r.out, origin.out.trim())
  const refused = readyRefusal(ready)
  last.set(`${p.key}|${machine}|${visual ? 1 : 0}`, { ...ready, ...(refused ? { refused } : {}) })
  return { ...ready, ...(refused ? { refused } : {}) }
}

// Throws 'refused' when the machine cannot take the task: what fails there.
export async function ensureReady(deps: PmLaunchDeps, p: Project, t: Template, task: Task, machine: string, clone: string) {
  const seen = last.get(`${p.key}|${machine}|${shotStep(t, task.type) ? 1 : 0}`)
  if (seen && !seen.refused && Date.now() - seen.at < FRESH_MS) return
  const { refused } = await runCheck(deps, p, t, task, machine, clone)
  if (refused) throw new HerdrError('refused', `${machineOn(deps, machine).m.label} is not ready for this project: ${refused}`)
}

// For placement: why the machine cannot take the task ('' ready). Any result
// is trusted for 10 minutes, so a machine that fails is not checked every tick.
export async function readiness(deps: PmLaunchDeps, p: Project, t: Template | null, task: Task, machine: string): Promise<string> {
  const seen = last.get(`${p.key}|${machine}|${t && shotStep(t, task.type) ? 1 : 0}`)
  if (seen && Date.now() - seen.at < FRESH_MS) return seen.refused ?? ''
  const clone = cloneOn(p, machine, await homeOf(deps, machineOn(deps, machine).on))
  if (!clone) return 'no clone path'
  return (await runCheck(deps, p, t, task, machine, clone)).refused ?? ''
}

// An allowed machine's check for the project (its sheet, after adding it):
// each check's result, and refused when one fails.
export async function checkMachine(deps: PmLaunchDeps, key: unknown, machine: unknown) {
  const p = await deps.store.project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const m = String(machine ?? '')
  const { on } = machineOn(deps, m)
  const clone = cloneOn(p, m, await homeOf(deps, on))
  if (!clone) throw new HerdrError('bad_input', 'This machine is not allowed for the project, or has no clone path')
  return runCheck(deps, p, await deps.store.workflow(p.key), undefined, m, clone)
}
