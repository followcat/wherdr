// The projects' automations, every 30 s (server/plugins/pm.ts): a schedule
// that is due, or an event on a task, adds a task from the project's
// template and starts it at once (shared/pm/automations.ts). The user's
// "run now" goes through `fireAutomation` too.
import { addFiring, answerAutomation, firesOn, firingTask, taskEvents, type Automation, type Firing } from '../../shared/pm/automations'
import { due, parseSchedule } from '../../shared/pm/schedule'
import type { Project } from '../../shared/pm/project'
import { HerdrError } from './herdr'
import { tellCardOutcome } from './cardOutcome'
import { MAIN } from '../../shared/pm/coordinator'
import { paceWait } from '../../shared/pm/pace'
import { forgetMemory } from './pmMemory'
import { goesTo, paceOf, placeFor } from './pmPlace'
import { startTask, type PmLaunchDeps } from './pmLaunch'

// Adds the firing's task and starts it; a refusal stays on the firing.
async function fire(deps: PmLaunchDeps, p: Project, a: Automation, f: Omit<Firing, 'task' | 'error' | 'held'>): Promise<Firing> {
  const t = p ? await deps.store.workflow(p.key) : null
  if (!t) return { ...f, error: 'The project has no template' }
  // A schedule or an event is automatic work: held by the worker account's pace,
  // the slot counted as fired (no catch-up, no retry loop). The user's "run now" never is.
  const pace = f.by !== 'user' ? await paceOf(deps.store, p, { type: a.type || Object.keys(t.taskTypes)[0]! }, f.at) : undefined
  if (pace?.verdict && !pace.verdict.go) return { ...f, error: `paced: ${paceWait(pace.verdict)}` }
  try {
    const task = await deps.store.addTask(firingTask(a, p.key, Object.keys(t.taskTypes)[0]!, f.at, f.cause))
    // No room on any allowed machine: the task is added and waits for it (the engine starts it then). "Run now" goes.
    const { on, short: held } = goesTo(await placeFor(deps, task, { waits: pace?.waits }))
    if (held && f.by !== 'user') return { ...f, task: (await deps.store.logTask({ ...task, held }, 'engine', held)).id, error: held, held: true }
    if (on !== undefined) forgetMemory(on)
    const started = await startTask(deps, task.id, on !== undefined ? { on } : {}).catch((e: Error) => ({ ...task, state: 'waiting' as const, waiting: e.message }))
    return { ...f, task: task.id, ...(started.state === 'waiting' ? { error: started.waiting ?? 'Not started' } : {}) }
  } catch (e) { return { ...f, error: (e as Error).message } }
}

type Seen = ReturnType<typeof taskEvents>['seen'] | undefined

// Saves firings by automation id onto the file as it is now (the user may have edited it meanwhile).
// Seen: where the tasks stand now; 'keep' leaves it.
const record = (deps: PmLaunchDeps, key: string, fired: [string, Firing][], seen: Seen | 'keep') =>
  deps.store.changeAutomations(key, f => ({
    file: { ...f, seen: seen === 'keep' ? f.seen : seen, automations: f.automations.map(a => fired.filter(([id]) => id === a.id).reduce((x, [, g]) => addFiring(x, g), a)) },
    out: undefined,
  }))

export async function automationTick(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const tasks = await store.tasks(), out: string[] = []
  for (const p of await store.projects()) {
    const file = await store.automations(p.key)
    if (!file.automations.length) continue
    // Tasks are watched only while an event automation is on; switched on, its first look only notes.
    const watch = file.automations.some(a => a.on && a.event)
    const ev = watch ? taskEvents(tasks.filter(t => t.project === p.key), file.seen) : { seen: undefined, events: [] }
    const fired: [string, Firing][] = []
    for (const a of file.automations.filter(x => x.on)) {
      const s = a.schedule ? parseSchedule(a.schedule) : null
      // Several slots missed while wherdr was down: one firing.
      if (s && !('error' in s) && due(s, a.last ?? now, now)) fired.push([a.id, await fire(deps, p, a, { at: now, by: 'schedule', cause: `the schedule ${a.schedule}` })])
      for (const e of ev.events.filter(e => firesOn(a, e)))
        fired.push([a.id, await fire(deps, p, a, { at: now, by: 'event', cause: `${e.task.id} (${e.task.title}): ${e.event}` })])
    }
    if (fired.length || JSON.stringify(ev.seen) !== JSON.stringify(file.seen)) await record(deps, p.key, fired, ev.seen)
    out.push(...fired.map(([, f]) => f.task ?? f.error ?? ''))
  }
  return out
}

// The user's "run now", whether the automation is on or off.
export async function fireAutomation(deps: PmLaunchDeps, key: string, id: string, now = Date.now()) {
  const p = (await deps.store.projects()).find(x => x.key === key)
  const a = p && (await deps.store.automations(key)).automations.find(x => x.id === id)
  if (!p || !a) throw new HerdrError('not_found', 'Unknown automation')
  const f = await fire(deps, p, a, { at: now, by: 'user' })
  await record(deps, key, [[id, f]], 'keep')
  return f
}

// The user's Accept or Refuse on a proposal of the coordinator or Alfred.
// The proposer learns the answer in its conversation (cardOutcome.ts).
export async function answerAutomationProposal(deps: Pick<PmLaunchDeps, 'store' | 'call'>, key: string, id: string, accept: boolean) {
  const p = (await deps.store.automations(key)).proposals?.find(x => x.id === id && !x.outcome)
  const what = p && `${p.action === 'add' ? 'New' : p.action === 'remove' ? 'Remove' : 'Change'} automation ${p.automation.id}`
  const tell = (text: string) => (p ? tellCardOutcome(deps, p.by === 'main' ? MAIN : p.by, text).catch(() => {}) : undefined)
  try {
    const out = await deps.store.changeAutomations(key, (f) => {
      const r = answerAutomation(f, id, accept, Date.now())
      if ('error' in r) throw new HerdrError('refused', r.error)
      return { file: { ...f, ...r }, out: { accepted: accept } }
    })
    await tell(`${accept ? 'Applied' : 'Cancelled'}: ${what}`)
    return out
  }
  catch (e) {
    if (e instanceof HerdrError) await tell(`Not applied: ${what}: ${e.message}`)
    throw e
  }
}
