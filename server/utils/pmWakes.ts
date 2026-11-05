// The engine's wakes, every 30 s (server/plugins/pm.ts): reasons are gathered
// (a coordinator step that starts or rechecks, the autopilot's events and its
// interval) into the persisted queue, then each coordinator's queue ticks
// (shared/pm/wakes.ts): delivery once it is idle and the user is quiet, the
// end of an open wake, a missed ack tried again, then a push to the user.
import { randomUUID } from 'node:crypto'
import { coordinatorWake } from '../../shared/pm/coordinator'
import { autopilotEvents, inHours } from '../../shared/pm/autopilot'
import { planSteps, durationMs } from '../../shared/pm/steps'
import { enqueue, tickWakes, wakeText, type CoordStatus } from '../../shared/pm/wakes'
import type { Template } from '../../shared/pm/workflow'
import type { CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'
import { noteTurn } from './pmCoordinator'
import { pushSend } from './push'
import { HerdrError } from './herdr'

export interface WakeDeps extends CoreAdminDeps { store: PmStore, notify?: (title: string, body: string, project: string) => Promise<unknown> }
const newId = () => randomUUID().replace(/-/g, '').slice(0, 8)

const pushNotify = (title: string, body: string, project: string) => pushSend({ title, body, tag: `pm-wake-${project}`, url: '/board' })

// What herdr-core says of the coordinator's terminal; null: unknown this tick.
async function statusOf(deps: WakeDeps, terminal: string | undefined): Promise<CoordStatus | null> {
  if (!terminal) return 'gone'
  try {
    const st = await deps.call<{ state?: string, status?: string | { state?: string } | null }>('terminal.get', { terminal }, 3000)
    if (st?.state === 'finished') return 'gone'
    const s = typeof st?.status === 'string' ? st.status : st?.status?.state
    return s === 'idle' || s === 'done' ? 'idle' : 'working'
  } catch (e) { return /not.?found|unknown terminal/i.test(`${(e as { kind?: string }).kind} ${(e as Error).message}`) ? 'gone' : null }
}

// Reasons of this tick, per project.
async function gather(deps: WakeDeps, now: number) {
  const { store } = deps
  const reasons = new Map<string, string[]>()
  const add = (k: string, r: string[]) => r.length && reasons.set(k, [...(reasons.get(k) ?? []), ...r])
  const projects = await store.projects(), tasks = await store.tasks()
  const templates = new Map<string, Template | null>()
  for (const p of projects) templates.set(p.key, p.template ? await store.template(p.template) : null)
  for (const task of tasks) {
    const t = templates.get(task.project)
    if (!task.step?.started || task.step.done || !t) continue
    const w = coordinatorWake(planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) }), task.step, now)
    if (JSON.stringify(w.state) === JSON.stringify(task.step)) continue
    // No coordinator: the tick still counts (timeouts), the step start stays to announce.
    const has = !!(await store.coordinator(task.project))?.terminal
    await store.saveTask({ ...task, step: has ? w.state : { ...w.state, told: task.step.told } })
    if (has) add(task.project, w.texts.map(x => `${task.id} (${task.title}): ${x}`))
  }
  for (const p of projects) {
    const c = await store.coordinator(p.key)
    if (!c) continue
    const ap = c.autopilot, mine = tasks.filter(x => x.project === p.key)
    const ev = autopilotEvents(ap ?? { on: false, goal: '', events: [], perDay: 0, atOnce: 0 }, mine, c.seen ?? {})
    const on = !!ap?.on && !!c.terminal && inHours(ap.hours, new Date(now))
    // The first look only notes where tasks stand.
    if (on && c.seen) add(p.key, ev.reasons)
    const due = on && ap!.every && now - (c.ranAt ?? 0) >= durationMs(ap!.every)
    if (due) add(p.key, [`Scheduled wake (every ${ap!.every}). Your goal: ${ap!.goal || '(none set)'}. Run \`wherdr pm autopilot show\` for what is left of today's limits.`])
    if (due || JSON.stringify(ev.seen) !== JSON.stringify(c.seen ?? null)) await store.saveCoordinator({ ...c, seen: ev.seen, ...(due ? { ranAt: now } : {}) })
  }
  return reasons
}

// The user's "run now": queued at once, delivered at the next idle moment,
// whatever wake is still open.
export async function runNow(deps: WakeDeps, key: string, now = Date.now()) {
  const c = await deps.store.coordinator(key)
  if (!c?.terminal) throw new HerdrError('not_found', 'The coordinator is not running: start it first')
  const goal = c.autopilot?.goal ? ` Your goal: ${c.autopilot.goal}.` : ''
  const w = enqueue(await deps.store.wakes(), key, [`The user asked you to run now.${goal}`], now, newId(), true)
  await deps.store.saveWakes([w])
  return wakeTick(deps, now)
}

export async function wakeTick(deps: WakeDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const reasons = await gather(deps, now)
  let queue = await store.wakes()
  const fresh = [...reasons].map(([k, r]) => enqueue(queue, k, r, now, newId()))
  if (fresh.length) { await store.saveWakes(fresh); queue = await store.wakes() }
  const sent: string[] = []
  for (const key of new Set(queue.filter(w => !w.ackedAt && w.ended !== 'unanswered' && w.ended !== 'merged').map(w => w.coordinator))) {
    const c = await store.coordinator(key)
    const status = await statusOf(deps, c?.terminal)
    if (!status) continue
    const r = tickWakes(queue, key, { status, lastUserAt: c?.userAt, now })
    if (r.deliver) {
      await noteTurn(store, key, 'wake')
      try { await deps.call('terminal.send', { terminal: c!.terminal, text: wakeText(r.deliver) }, 30000) }
      catch { r.changed.splice(r.changed.indexOf(r.deliver), 1, { ...r.deliver, deliveredAt: undefined, tries: r.deliver.tries - 1 }) }
    }
    await store.saveWakes(r.changed)
    if (r.deliver && r.changed.some(w => w.id === r.deliver!.id && w.deliveredAt)) sent.push(key)
    if (r.notify) await (deps.notify ?? pushNotify)(`${key}: the coordinator is not answering`, `Wake ${r.notify.id} got no ack after two tries: ${r.notify.reasons[0]?.slice(0, 120) ?? ''}`, key).catch(() => {})
  }
  return sent
}
