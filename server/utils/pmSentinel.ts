// The engine's liveness (shared/pm/sentinel.ts): one task's error never stops
// the others' pass and is logged on it once; a task the mechanic cannot follow
// says why on its card; and at the end of each mechanic tick, the sentinel
// re-enters every working task that has been quiet with no stated reason.
import { READ_HOLD, SENTINEL_LOG, SENTINEL_MS, isReadHold, seenBy, sentinelDue, sentinelFired, strandedAction } from '../../shared/pm/sentinel'
import { taskPlan, type Task } from '../../shared/pm/run'
import { showIds } from '../../shared/pm/projectKey'
import { actionRunning, startAction } from './pmBoard'
import { wakeCoordinators } from './pmWakes'
import type { PmLaunchDeps } from './pmLaunch'
import type { PmStore } from './pmStore'

// Task id → the last error or reason logged on it: each said once.
const said = new Map<string, string>()

export async function noteTaskError(store: PmStore, id: string, e: unknown) {
  const text = `the engine hit an error on this task: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400)
  if (said.get(id) === text) return
  said.set(id, text)
  const task = await store.task(id).catch(() => null)
  if (task) await store.logTask(task, 'engine', text).catch(() => {})
}

// Why the mechanic cannot follow a working task this tick, on its card and in
// its log once per reason; no reason: it can again, and its hold goes.
export async function noteCannotFollow(store: PmStore, task: Task, why?: string): Promise<Task> {
  if (!why) {
    if (!isReadHold(task.held)) return task
    said.delete(task.id)
    return store.saveTask({ ...task, held: undefined })
  }
  const held = READ_HOLD + why.slice(0, 300)
  if (task.state !== 'working' || task.held === held) return task
  const log = said.get(task.id) !== held
  said.set(task.id, held)
  return log ? store.logTask({ ...task, held }, 'engine', held) : store.saveTask({ ...task, held })
}

// Handed work whose worker is working right now: someone is on it.
async function agentWorking(deps: PmLaunchDeps, task: Task) {
  if (!task.step?.agent) return false
  const run = (await deps.store.runs()).filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!run?.terminal || run.state === 'ended') return false
  const st = await deps.call<{ status?: string | { state?: string } }>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null)
  const s = typeof st?.status === 'string' ? st.status : st?.status?.state
  return s === 'working' || s === 'blocked'
}

export interface SentinelOpts {
  ms?: number
  wake?: (task: Task, why: string) => Promise<string[]>
  act?: (id: string) => Promise<unknown> // starts the step's action again (startAction), never waited for
}

// Each quiet working task: said, re-entered, looked at again after 2N, 4N…;
// its coordinator woken once per step. Returns the tasks it looked at.
export async function sentinelTick(deps: PmLaunchDeps, now = Date.now(), opts: SentinelOpts = {}) {
  const { store } = deps
  const ms = opts.ms ?? SENTINEL_MS
  const wake = opts.wake ?? ((task: Task, why: string) => wakeCoordinators(deps, task, why, now))
  // Refused once started (after the tick went on): its running mark goes so the step can move.
  const clear = async (id: string, e: Error) => {
    const fresh = await store.task(id)
    if (fresh?.step?.acting) await store.logTask({ ...fresh, step: { ...fresh.step, acting: undefined } }, 'engine', `cleared its running mark (running its action again failed: ${e.message})`)
  }
  const act = opts.act ?? (async (id: string) => { startAction(deps, id, e => clear(id, e)) })
  const projects = await store.projects(), fired: string[] = []
  for (const task of await store.tasks()) {
    try {
      const p = projects.find(x => x.key === task.project)
      const t = p ? await store.workflow(p.key).catch(() => null) : null
      if (!p || !t) continue
      const plan = taskPlan(t, task, p)
      const key = sentinelDue(task, plan, now, ms)
      if (!key || actionRunning(task.id) || await agentWorking(deps, task)) continue
      fired.push(task.id)
      const state = sentinelFired(task.sentinel, key, now, ms), s = task.step!
      const sees = seenBy(task, plan)
      // Runs the step's action again; refused, its running mark goes so the step can move.
      const rerun = (done: string) => act(task.id).then(() => done, async (e: Error) => {
        const fresh = (await store.task(task.id))!
        await store.saveTask({ ...fresh, step: { ...fresh.step!, acting: undefined } })
        return `cleared its running mark (running its action again failed: ${e.message})`
      })
      // A merge move spent at this head: given back once, the mechanic makes it again.
      const spent = !s.acting && state.n === 1 ? Object.entries(task.mech ?? {}).filter(([k]) => k.startsWith('merge:')).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined
      const stranded = strandedAction(s, plan)
      let tried: string
      if (s.acting) tried = await rerun('ran its stale running action again')
      else if (spent) {
        const fresh = (await store.task(task.id))!
        const { [spent]: _, ...mech } = fresh.mech ?? {}
        await store.saveTask({ ...fresh, mech })
        tried = `gave back its spent move ${spent}: the merge is tried again`
      } else if (stranded) {
        await store.saveTask({ ...(await store.task(task.id))!, step: stranded })
        tried = await rerun('ran its action again')
      } else tried = 'found nothing to run again'
      const mins = Math.round(ms / 60_000), again = Math.round((state.next - now) / 60_000)
      const why = `${task.id} (${task.title}): ${SENTINEL_LOG} ${mins} min with no stated reason, ${sees}. The engine ${tried}.`
      const woken = state.woke ? [] : await wake((await store.task(task.id))!, showIds(projects, why))
      const said = state.woke ? '' : woken.length ? ` Woke ${woken.join(' and ')}.` : ' No coordinator to wake.'
      const fresh = (await store.task(task.id))!
      await store.logTask({ ...fresh, sentinel: { ...state, woke: true } }, 'engine', `${SENTINEL_LOG} ${mins} min: ${sees}. It ${tried}; it looks again in ${again} min.${said}`)
    } catch (e) { await noteTaskError(store, task.id, e) }
  }
  return fired
}
