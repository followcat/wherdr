// Where a task of a project starts (shared/pm/placement.ts): each allowed
// machine read now (capacity, settings, agents at work, readiness, pace),
// then placeTask picks one or holds the start with each machine's reason.
import { HerdrError } from './herdr'
import { PAUSED, allowedMachines, isPaused, taskMachine, type Project } from '../../shared/pm/project'
import { machineLine, machineNow, placeTask, type Candidate, type MachineView, type Placement } from '../../shared/pm/placement'
import { DEFAULT_MEMORY } from '../../shared/pm/memory'
import { weightOf, type Weight } from '../../shared/pm/weight'
import { paceWait } from '../../shared/pm/pace'
import type { PaceVerdict } from '../../shared/pm/pacing'
import { taskPlan, type Task } from '../../shared/pm/run'
import { busyNext, busyQueue, coordinatorStartRefusal, holdsSlot, type SlotOf } from '../../shared/pm/autopilot'
import { byBoardOrder } from '../../shared/pm/boardOrder'
import { sameFilesText } from '../../shared/pm/files'
import { showIds, shownTaskId } from '../../shared/pm/projectKey'
import type { PmStore } from './pmStore'
import { coordinatorKey, handledBy, isWorkspace } from '../../shared/pm/workspace'
import { atWork, machineCapacity, readMemorySettings } from './pmMemory'
import { lastReadiness, readiness } from './pmReady'
import { projectPace } from './pmPace'
import { projectEstimates } from './pmPeaks'
import type { PmLaunchDeps } from './pmLaunch'
import type { CoreMachine } from '../../shared/coreState'

// The pace of automatic work for a task, per allowed machine (each may use
// another account): the verdict the project's limits see (home's when it goes,
// else the first machine's that goes) and the machines whose account waits,
// which placement skips.
export async function paceOf(store: PmStore, p: Project, task?: Pick<Task, 'type' | 'prefs'>, now = Date.now()) {
  const all = await Promise.all(allowedMachines(p).map(async m => [m, (await projectPace(store, p.key, task, now, false, m))?.verdict] as const))
  const waits: Record<string, string> = {}
  for (const [m, v] of all) if (v && !v.go) waits[m] = `paced: ${paceWait(v)}`
  const verdict: PaceVerdict | undefined = all.find(([m]) => !waits[m])?.[1] ?? all[0]?.[1]
  return { verdict, waits }
}

const anywayLogged = new Set<string>()
// asked: the machine the user or the coordinator named (refused when the
// project does not allow it, or the task started elsewhere); offline, a new task goes elsewhere. waits: machines
// that take nothing now (paceOf). weight: what this start does, when it is not
// the task's (a worker started again: reviveWeight). A started task only ever
// goes back to its own; a new one never goes to a machine paused for the project. A task too big for every machine goes anyway, said
// once in its log.
export async function placeFor(deps: PmLaunchDeps, task: Task, { asked, waits = {}, weight }: { asked?: string, waits?: Record<string, string>, weight?: Weight } = {}): Promise<Placement> {
  const p = (await deps.store.projects()).find(x => x.key === task.project)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const fixed = taskMachine(task, p, asked)
  // Nothing asked: only every machine paused refuses, and an automatic start waits for one to be switched on.
  if ('refused' in fixed) { if (asked === undefined) return { hold: `Waits: ${fixed.refused}` }; throw new HerdrError('refused', fixed.refused) }
  const fresh = task.machine === undefined && !task.run
  const pinned = fresh ? undefined : fixed.machine
  const t = await deps.store.workflow(p.key)
  const settings = await readMemorySettings()
  // Each machine's state now, not the last reading (a few seconds old): one that just went offline takes nothing.
  const listed = await Promise.resolve().then(() => deps.call<{ machines?: CoreMachine[] }>('machine.list', {}, 3000)).then(r => r?.machines ?? null, () => null)
  // A failed read never holds a start: it goes where it would have gone without placement.
  const candidates = await Promise.all((pinned === undefined ? allowedMachines(p) : [pinned]).map(async (key): Promise<Candidate> => {
    const m = deps.machines().find(x => x.key === key)
    const online = !!m && (m.local || (listed ? listed.some(x => x.name === m.label && x.state === 'connected') : m.status === 'online'))
    // A new task skips a machine paused for the project (a started one goes back to its own).
    const paused = fresh && isPaused(p, key)
    // Another machine than home, before the task's first start there: ready for the project?
    const notReady = online && fresh && !paused && key !== p.machine ? await readiness(deps, p, t, task, key).catch((e: Error) => e.message) : ''
    const wait = paused ? PAUSED : waits[key] ?? (notReady ? `not ready (${notReady})` : undefined)
    return {
      key, label: m?.label ?? key, online, ...(wait ? { wait } : {}), settings: settings[key] ?? DEFAULT_MEMORY,
      capacity: online ? await machineCapacity(deps, key) : null, running: online ? await atWork(deps.store, key) : [],
    }
  })).catch(() => null)
  if (!candidates) return { machine: fixed.machine }
  const w = weight ?? weightOf(t, task).weight
  const estimate = (await projectEstimates(deps.store, p.key))[w]
  const placed = placeTask({ weight: w, estimate, home: p.machine, pinned, ...(fresh && asked !== undefined ? { prefer: asked } : {}), candidates, strategy: p.placement })
  if ('anyway' in placed && placed.anyway && !anywayLogged.has(task.id)) {
    anywayLogged.add(task.id)
    await deps.store.logTask((await deps.store.task(task.id)) ?? task, 'engine', placed.anyway)
  }
  return placed
}

// The machine a start that must go (the user's) takes, and the hold it goes past.
export const goesTo = (placed: Placement) =>
  'machine' in placed ? { on: placed.machine } : { on: placed.best, short: placed.hold }

// The project's allowed machines now. Readiness is the last check's, never
// run from here; pace is each machine's account, for `task` (paceOf: the
// workflow's first type when none), as the engine's start reads it.
async function machineViews(deps: PmLaunchDeps, p: Project, now: number, task?: Task): Promise<MachineView[]> {
  const [settings, { waits }] = await Promise.all([readMemorySettings(), paceOf(deps.store, p, task, now).catch(() => ({ waits: {} as Record<string, string> }))])
  return Promise.all(allowedMachines(p).map(async (key) => {
    const m = deps.machines().find(x => x.key === key)
    const online = !!m && (m.local || m.status === 'online')
    const home = key === p.machine, ready = home ? '' : lastReadiness(p.key, key)
    return {
      key, label: m?.label ?? key, online, home, ...(isPaused(p, key) ? { paused: true } : waits[key] ? { wait: waits[key] } : ready ? { wait: `not ready (${ready})` } : {}), ...(ready === undefined ? { unchecked: true } : {}),
      settings: settings[key] ?? DEFAULT_MEMORY, capacity: online ? await machineCapacity(deps, key) : null, running: online ? await atWork(deps.store, key) : [],
    }
  }))
}

// `autopilot show`: one line per allowed machine (machineLine).
export async function machineLines(deps: PmLaunchDeps, p: Project, now = Date.now()) {
  const [views, estimates] = await Promise.all([machineViews(deps, p, now), projectEstimates(deps.store, p.key)])
  return views.map(v => machineLine(v, estimates))
}

// The project sheet's Machines view: its strategy, each allowed machine's card
// (machineNow, by the project's learned estimates), and the next to-do task
// with where it would go, or the hold. Placed as startNext places it: with the
// pace of that task's worker account on each machine. why: what keeps it from
// starting by itself: busyNext's reason, or, when only chained, held or
// same-files tasks are left, the first one's wait.
export async function machinesNow(deps: PmLaunchDeps, p: Project, now = Date.now()) {
  const [views, projects, all, estimates] = await Promise.all([machineViews(deps, p, now), deps.store.projects(), deps.store.tasks(), projectEstimates(deps.store, p.key)])
  const tasks = all.filter(x => x.project === p.key), head = busyQueue(tasks)[0]
  const task = head ?? tasks.filter(t => t.state === 'todo' && !t.step?.started).sort(byBoardOrder)[0]
  const shown = (id: string) => shownTaskId(projects, id)
  const machines = views.map(v => machineNow({ ...v, running: v.running.map(r => ({ ...r, ...(r.task ? { task: shown(r.task) } : {}) })) }, estimates))
  const strategy = p.placement ?? 'strongest'
  if (!task) return { strategy, machines, next: null }
  const weight = weightOf(await deps.store.workflow(p.key), task).weight
  const candidates = (await machineViews(deps, p, now, task)).map(v => (v.paused ? { ...v, wait: PAUSED } : v))
  const placed = placeTask({ weight, estimate: estimates[weight], home: p.machine, strategy, candidates })
  // A member's limits: its workspace's autopilot, over all its projects' tasks.
  const { ap, all: counted, holds } = await pilotOf(deps.store, projects, p.key), runs = await deps.store.runs()
  const pace = await paceOf(deps.store, p, task, now).catch(() => undefined)
  const n = head ? busyNext(ap, counted, runs, now, { pace: pace?.verdict, holds }) : undefined
  const why = n ? ('why' in n ? n.why : undefined)
    : task.held || (task.sameFiles ? sameFilesText(task.sameFiles) : coordinatorStartRefusal(ap, task, counted, runs, now, false, { engine: true }) ?? `${task.id} starts after ${task.after}`)
  const on = 'machine' in placed ? machines.find(m => m.key === placed.machine)?.label ?? placed.machine : undefined
  return { strategy, machines, next: showIds(projects, { task: task.id, title: task.title, weight, ...(on !== undefined ? { on } : { hold: 'hold' in placed ? placed.hold : '' }), ...(why ? { why } : {}) }) }
}

// Which tasks of these projects take a tasks-at-once slot (holdsSlot), by their plan.
// The autopilot a project's automatic starts hold to, with the tasks its
// limits count: its own, or a member's workspace's, over all the projects it
// handles (held), and which of their tasks hold a slot. A workspace's own
// tasks (features, no agent) are never started, so left out.
export async function pilotOf(store: PmStore, projects: Project[], key: string) {
  const pk = coordinatorKey(key, projects), held = handledBy(pk, projects)
  const all = (await store.tasks()).filter(t => held.some(x => x.key === t.project && !isWorkspace(x)))
  return { ap: (await store.coordinator(pk))?.autopilot, all, held, holds: await slotsOf(store, held) }
}

export async function slotsOf(store: PmStore, projects: Project[]): Promise<SlotOf> {
  const tpl = new Map(await Promise.all(projects.map(async p => [p.key, { p, t: await store.workflow(p.key).catch(() => null) }] as const)))
  return (task) => {
    const x = tpl.get(task.project)
    return holdsSlot(task, x?.t ? taskPlan(x.t, task, x.p) : undefined)
  }
}
