// The engine's wakes, every 30 s (server/plugins/pm.ts): reasons are gathered
// (a coordinator step that starts or rechecks, the autopilot's events, its
// interval and fixed times, those skipped when there is nothing to do, nothing
// it could act on changed, or the worker's account is ahead of its pace) into
// the persisted queue, then each coordinator's queue ticks (shared/pm/wakes.ts): delivery once it is idle and the user is quiet, the
// end of an open wake, a missed ack tried again, then a push to the user.
import { randomUUID } from 'node:crypto'
import { MAIN, coordinatorBy, coordinatorWake } from '../../shared/pm/coordinator'
import { LOOK_REASON, SKIP_WHY, quietEvents, autopilotEvents, bump, inHours, scheduledWake, sentence, skippedWake, today } from '../../shared/pm/autopilot'
import { projectPace } from './pmPace'
import { currentStep, durationMs, pauseClock, recheckNews } from '../../shared/pm/steps'
import { clockStops } from '../../shared/pm/blocked'
import { taskPlan } from '../../shared/pm/run'
import { due as isDue, parseSchedule } from '../../shared/pm/schedule'
import { addSkip, enqueue, tickWakes, wakesFor, wakeText, type CoordStatus, type Wake, type WakeSkip } from '../../shared/pm/wakes'
import { healthEvery, healthRepeats, healthSummary } from '../../shared/pm/health'
import { adoptedSince } from '../../shared/pm/workspaceAdopt'
import { allowedMachines, type Project } from '../../shared/pm/project'
import type { Run, Task } from '../../shared/pm/run'
import type { Template } from '../../shared/pm/workflow'
import type { CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'
import { noteTurn } from './pmCoordinator'
import { pushSend } from './push'
import { HerdrError } from './herdr'
import { projectOf, shownKey, showIds } from '../../shared/pm/projectKey'
import { coordinatorKey, handledBy } from '../../shared/pm/workspace'

export interface WakeDeps extends CoreAdminDeps { store: PmStore, notify?: (title: string, body: string, project: string) => Promise<unknown> }
const newId = () => randomUUID().replace(/-/g, '').slice(0, 8)

const pushNotify = (title: string, body: string, project: string) => pushSend({ title, body, tag: `pm-wake-${project}`, url: '/#/board' })

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

// The project's machines online with no agent at work, by name: the health check's.
const idleMachines = (deps: WakeDeps, p: Project, runs: Run[]) => {
  const busy = new Set(runs.filter(r => r.state !== 'ended').map(r => r.machine))
  return allowedMachines(p).flatMap((key) => {
    const m = deps.machines().find(x => x.key === key)
    return m?.status === 'online' && !busy.has(key) ? [m.label] : []
  })
}

// Reasons of this tick, per project.
async function gather(deps: WakeDeps, now: number) {
  const { store } = deps
  // One entry per project and source: a step check is its own wake, per task and step.
  const reasons: { key: string, reasons: string[], from: Pick<Wake, 'kind' | 'about'> }[] = []
  const add = (key: string, r: string[], from: Pick<Wake, 'kind' | 'about'> = { kind: 'autopilot' }) => {
    if (!r.length) return
    const e = reasons.find(x => x.key === key && x.from.kind === from.kind && x.from.about === from.about)
    if (e) e.reasons.push(...r)
    else reasons.push({ key, reasons: [...r], from })
  }
  const projects = await store.projects(), tasks = await store.tasks(), runs = await store.runs()
  const templates = new Map<string, Template | null>()
  for (const p of projects) templates.set(p.key, p ? await store.workflow(p.key) : null)
  for (const task of tasks) {
    const t = templates.get(task.project)
    if (!task.step?.started || task.step.done || !t) continue
    const plan = taskPlan(t, task, projects.find(p => p.key === task.project))
    // Its holder cannot work (machine offline, an incident, no room): the step's clock stops.
    const run = runs.filter(r => r.task === task.id && r.state !== 'ended').sort((a, b) => b.startedAt - a.startedAt)[0]
    const m = run && deps.machines().find(x => x.key === run.machine)
    // News on the task (its log, its CI, the user's message to the coordinator) resets the recheck's backoff.
    // A member's task: its workspace's coordinator.
    const ck = coordinatorKey(task.project, projects), coord = await store.coordinator(ck)
    const user = Math.max(task.log?.findLast(e => e.by === 'user')?.at ?? 0, coord?.userAt ?? 0)
    const news = { at: Math.max(task.log?.at(-1)?.at ?? 0, user), user, ...(task.ci ? { ci: `${task.ci.head}:${task.ci.red}:${!!task.ci.running}` } : {}) }
    const stepped = recheckNews(plan, pauseClock(task.step, clockStops(task, !!m && !m.local && m.status !== 'online'), now), news, now)
    const w = coordinatorWake(plan, stepped, now)
    if (JSON.stringify(w.state) === JSON.stringify(task.step)) continue
    // No coordinator: the tick still counts (timeouts), the step start stays to announce.
    const has = !!coord?.terminal
    await store.saveTask({ ...task, step: has ? w.state : { ...w.state, told: task.step.told } })
    const step = currentStep(plan, task.step)
    if (has) add(ck, w.texts.map(x => `${task.id} (${task.title}): ${x}`), { kind: 'step', about: `${task.id} (${step?.id ?? 'step'})` })
  }
  // The main coordinator (Alfred) has no autopilot: one saved before is turned off.
  const main = await store.coordinator(MAIN)
  if (main?.autopilot?.on) await store.saveCoordinator({ ...main, autopilot: { ...main.autopilot, on: false } })
  // Each project's autopilot: its own goal, limits, hours and pace.
  for (const p of projects) {
    let c = await store.coordinator(p.key)
    if (!c) continue
    // Routine events off by default: an autopilot saved with the old default events drops them, once.
    if (!c.quiet) await store.saveCoordinator(c = { ...c, quiet: true, ...(c.autopilot ? { autopilot: quietEvents(c.autopilot) } : {}) })
    // A workspace's: its members' tasks too (their events, health check and limits).
    const held = handledBy(p.key, projects), ap = c.autopilot, mine = tasks.filter(x => held.some(y => y.key === x.project))
    const ev = autopilotEvents(ap ?? { on: false, goal: '', events: [], perDay: 0, atOnce: 0 }, mine, c.seen ?? {}, { key: p.key, by: coordinatorBy(p.key) })
    const on = !!ap?.on && !!c.terminal && inHours(ap.hours, new Date(now))
    // The first look only notes where tasks stand. Each wake not sent is noted (autopilot show).
    const skips: WakeSkip[] = []
    if (on && c.seen) {
      add(p.key, ev.reasons)
      skips.push(...ev.skipped.map(why => ({ at: now, what: 'question' as const, why })))
    }
    const due = on && ap!.every && now - (c.ranAt ?? 0) >= durationMs(ap!.every)
    // Fixed times: a slot missed (wherdr down, the coordinator off) wakes it once.
    const at = on && ap!.at ? parseSchedule(ap!.at) : null
    const atDue = !!at && !('error' in at) && isDue(at, c.atRan ?? now, now)
    const goal = `Your goal: ${sentence(ap?.goal || '(none set)')} Run \`wherdr pm autopilot show\` for what is left of today's limits.`
    // Nothing to do, or the worker's account ahead of its pace: the slot counts
    // as run, the paid turn is saved. The pace is read only for a wake that would go.
    let kind = due || atDue ? scheduledWake(ap!, mine, c.woke ?? {}, c.userAt, today(c.lookAdded, now)) : null
    if (kind === 'send' || kind === 'look') kind = scheduledWake(ap!, mine, c.woke ?? {}, c.userAt, today(c.lookAdded, now), (await projectPace(store, p.key, undefined, now))?.verdict)
    const skip = skippedWake(kind)
    if (skip) skips.push({ at: now, what: 'autopilot', why: `Scheduled wake: ${SKIP_WHY[kind as keyof typeof SKIP_WHY]}` })
    if (kind && !skip) add(p.key, [`Scheduled wake (${due ? `every ${ap!.every}` : ap!.at}). ${kind === 'look' ? `${LOOK_REASON} ` : ''}${goal}`])
    // The health check: the first look only notes where tasks stand; off (or
    // outside the hours), it starts over once back on. Only a new line sends
    // it, or 12 h since the last one sent.
    const every = on ? healthEvery(ap) : null
    const healthDue = !!every && !!c.health && now - c.health.at >= durationMs(every)
    const lines = healthDue ? healthSummary(mine, c.health!.seen, now, idleMachines(deps, p, runs), adoptedSince(await store.projectLog(p.key), c.health!.at)) : []
    const repeats = lines.length > 0 && healthRepeats(lines, c.health?.sent, now)
    if (repeats) skips.push({ at: now, what: 'health', why: 'Health check: the same lines as the last one sent' })
    else add(p.key, lines, { kind: 'health' })
    const sent = lines.length && !repeats ? { lines, at: now } : c.health?.sent
    const health = every && (!c.health || healthDue) ? { health: { at: now, seen: ev.seen, ...(sent ? { sent } : {}) } } : !every && c.health ? { health: undefined } : null
    const woke = reasons.some(x => x.key === p.key)
    const noted = skips.reduce<WakeSkip[] | undefined>((list, x) => addSkip(list, x) ?? list, c.skips)
    if (due || atDue || woke || health || noted !== c.skips || JSON.stringify(ev.seen) !== JSON.stringify(c.seen ?? null)) {
      await store.saveCoordinator({
        ...c, seen: ev.seen, ...(due ? { ranAt: now } : {}), ...(atDue ? { atRan: now } : {}), ...health,
        ...(woke ? { woke: { at: now, seen: ev.seen } } : {}),
        ...(skip ? { skipped: bump(c.skipped, now) } : {}),
        ...(noted !== c.skips ? { skips: noted } : {}),
      })
    }
  }
  // Task ids as the user sees them (CMP-9, not its fixed CP-9).
  return reasons.map(x => ({ ...x, reasons: showIds(projects, x.reasons) }))
}

// The user's "run now": queued at once, delivered at the next idle moment,
// whatever wake is still open.
export async function runNow(deps: WakeDeps, key: string, now = Date.now()) {
  const c = await deps.store.coordinator(key)
  if (!c?.terminal) throw new HerdrError('not_found', 'The coordinator is not running: start it first')
  const goal = c.autopilot?.goal ? ` Your goal: ${sentence(c.autopilot.goal)}` : ''
  const w = enqueue(await deps.store.wakes(), key, [`The user asked you to run now.${goal}`], now, newId(), true)
  await deps.store.saveWakes([w])
  return wakeTick(deps, now)
}

export async function wakeTick(deps: WakeDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const reasons = await gather(deps, now)
  let queue = await store.wakes()
  const fresh = reasons.map(r => enqueue(queue, r.key, r.reasons, now, newId(), false, r.from))
  if (fresh.length) { await store.saveWakes(fresh); queue = await store.wakes() }
  const sent: string[] = [], projects = await store.projects()
  const shown = (k: string) => { const p = projectOf(projects, k); return p ? shownKey(p) : k }
  for (const key of new Set(queue.filter(w => !w.ackedAt && w.ended !== 'unanswered' && w.ended !== 'merged').map(w => w.coordinator))) {
    const c = await store.coordinator(key)
    const status = await statusOf(deps, c?.terminal)
    if (!status) continue
    const r = tickWakes(queue, key, { status, lastUserAt: c?.userAt, now })
    if (r.deliver) {
      await noteTurn(store, key, 'wake', undefined, r.deliver.reasons.some(x => x.includes(LOOK_REASON)))
      // Other coordinators' actions on this project since its last wake (reach.ts), said once.
      const visits = c?.visits ?? [], last = visits.at(-1)?.at ?? 0
      const told = visits.length ? { ...r.deliver, reasons: [...r.deliver.reasons, `Other coordinators acted on your project since your last wake (each action is in its task's or the project's log): ${visits.map(v => `${v.by}: ${v.what}`).join('; ')}.`] } : r.deliver
      try {
        await deps.call('terminal.send', { terminal: c!.terminal, text: showIds(projects, wakeText(told, key !== MAIN && !!c?.autopilot?.on)) }, 30000)
        const fresh = last && await store.coordinator(key)
        if (fresh) await store.saveCoordinator({ ...fresh, visits: fresh.visits?.filter(v => v.at > last) })
      }
      catch { r.changed.splice(r.changed.indexOf(r.deliver), 1, { ...r.deliver, deliveredAt: undefined, tries: r.deliver.tries - 1 }) }
    }
    await store.saveWakes(r.changed)
    if (r.deliver && r.changed.some(w => w.id === r.deliver!.id && w.deliveredAt)) sent.push(key)
    if (r.notify) await (deps.notify ?? pushNotify)(`${shown(key)}: the coordinator is not answering`, showIds(projects, `Wake ${r.notify.id} got no ack after two tries: ${r.notify.reasons[0]?.slice(0, 120) ?? ''}`), key).catch(() => {})
  }
  return sent
}

// The task's coordinators whose autopilot wakes them for stuck tasks, woken with why; who was woken.
// A member's task: its workspace's coordinator, the wake's first line naming the task.
export async function wakeCoordinators(deps: { store: PmStore }, task: Pick<Task, 'project' | 'id'>, why: string, now: number) {
  const { store } = deps, projects = await store.projects()
  const own = coordinatorKey(task.project, projects), member = own !== task.project
  const shownId = showIds(projects, task.id), text = member && !showIds(projects, why).startsWith(shownId) ? `${task.id}: ${why}` : why
  const coords = new Map([[own, await store.coordinator(own)], [MAIN, await store.coordinator(MAIN)]])
  const keys = wakesFor([own, MAIN], k => coords.get(k) ?? undefined, now)
  for (const key of keys) await store.saveWakes([enqueue(await store.wakes(), key, [text], now, randomUUID().replace(/-/g, '').slice(0, 8), false, { kind: 'engine' })])
  return keys.map(k => (k === MAIN ? 'the main coordinator' : member ? 'the workspace\'s coordinator' : 'the project\'s coordinator'))
}
