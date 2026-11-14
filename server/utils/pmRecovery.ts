// Crash recovery (shared/pm/recovery.ts): a task whose agent an incident took
// waits for the engine; every minute, once its cause is gone and its machine
// has room (placement, the account's pace), the engine resumes it through
// startTask (one agent per task), the tasks before it first, one per machine
// and tick. Claude takes its conversation up again (--resume); else a new
// agent reads its instructions with a handover note.
import { randomUUID } from 'node:crypto'
import { MAIN } from '../../shared/pm/coordinator'
import { enqueue } from '../../shared/pm/wakes'
import { incidentReasons, toTell } from '../../shared/pm/incidentWake'
import { showIds } from '../../shared/pm/projectKey'
import type { Incident } from '../../shared/pm/incident'
import { causeGone, interrupted, interruptedWhy, resumeOrder, resumeText } from '../../shared/pm/recovery'
import { handoverText } from '../../shared/pm/stop'
import type { Task } from '../../shared/pm/run'
import { machineOn } from './coreCreate'
import { HerdrError } from './herdr'
import { limitOf, readAccounts, type IncidentDeps } from './pmIncidents'
import { startTask, type PmLaunchDeps } from './pmLaunch'
import { paceOf, placeFor } from './pmPlace'
import { forgetMemory } from './pmMemory'
import { load } from './pmStop'

// The task's agent gone with this incident: it waits for the engine's resume,
// or, the same cause again right after one, for the coordinators (told in the incident's wake).
export async function interruptTask(deps: PmLaunchDeps, task: Task, i: Incident, now = Date.now()): Promise<Task> {
  const r = interrupted(task, i, now)
  if (!r.escalate) return deps.store.saveTask(r.task)
  return deps.store.logTask(r.task, 'engine', `not resumed again: the same cause right after a resume; the coordinators are told in incident ${i.id}'s wake`)
}

// One Incident wake per incident, once no resume of it is under way (busy):
// to the coordinator of each project it hit, and to the main one with them all; running ones only.
export async function wakeIncidents(deps: PmLaunchDeps, busy: Set<string>, now = Date.now()) {
  const { store } = deps
  const told = toTell(await store.incidents(), busy, now)
  if (!told.length) return []
  const tasks = await store.tasks(), projects = await store.projects()
  for (const i of told) {
    const keys = [...new Set(i.tasks.map(id => tasks.find(t => t.id === id)?.project).filter((k): k is string => !!k)), MAIN]
    for (const key of keys) {
      if (!(await store.coordinator(key))?.terminal) continue
      const reasons = showIds(projects, incidentReasons(i, tasks, key === MAIN ? undefined : key))
      await store.saveWakes([enqueue(await store.wakes(), key, reasons, now, randomUUID().replace(/-/g, '').slice(0, 8), false, { kind: 'incident', about: i.id })])
    }
  }
  await store.toldIncidents(told.map(i => i.id), now)
  return told.map(i => i.id)
}

export async function resumeInterrupted(deps: IncidentDeps, now = Date.now()) {
  const { store } = deps
  const runs = await store.runs(), projects = await store.projects(), machines = new Set<string>(), resumed: string[] = []
  // Incidents with a resume under way this tick: their wake waits for the next one.
  const busy = new Set<string>()
  let accounts: Awaited<ReturnType<typeof readAccounts>> | undefined
  for (const t of resumeOrder(await store.tasks())) {
    const r = t.recovery!
    const worker = runs.filter(x => x.task === t.id && x.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    const p = projects.find(x => x.key === t.project)
    // Never started (its first start found the machine out of reach): it starts there once it is back.
    const machine = r.run ? worker?.machine : r.machine
    if ((r.run && !worker) || machine === undefined || !p) continue
    if (machines.has(machine)) { busy.add(r.incident); continue }
    let online = true
    try { machineOn(deps, machine) } catch { online = false }
    const limited = online && !!worker && r.cause === 'limit' && !!limitOf(accounts ??= await readAccounts(deps))(worker.program, machine, now)
    if (!causeGone(r, { online, limited })) continue
    const placed = await placeFor(deps, t, { waits: (await paceOf(store, p, t, now)).waits })
    if ('hold' in placed) { if (t.held !== placed.hold) await store.logTask({ ...t, held: placed.hold }, 'engine', `resumes once there is room: ${placed.hold}`); continue }
    machines.add(placed.machine)
    busy.add(r.incident)
    forgetMemory(placed.machine)
    // Not waiting any more: a failed start is the user's, never tried again in a loop.
    const fresh = await store.saveTask({ ...t, held: undefined, recovery: { ...r, waits: undefined, resumedAt: now } })
    if (!r.run || !worker) {
      const res = await startTask(deps, t.id, { on: placed.machine }).catch((e: Error) => (e instanceof HerdrError && e.code === 'busy' ? null : store.saveTask({ ...fresh, state: 'waiting', waiting: e.message })))
      if (!res) continue
      // Out of reach again: held by machineHold (its log says so).
      if (res.state !== 'working' && (res.recovery?.waits || res.machineWait)) continue
      await store.logTask((await store.task(t.id))!, 'engine', res.state === 'working' ? `started after incident ${r.incident}: ${r.label} is back` : `could not start after incident ${r.incident}: ${res.waiting ?? ''}`)
      resumed.push(t.id)
      continue
    }
    const { plan } = await load(deps, t.id)
    const handover = handoverText({ ...fresh, stopped: { by: 'the engine', why: interruptedWhy(r), at: now } }, plan, worker.branch)
    const session = worker.program === 'claude' && worker.session ? { session: worker.session, text: resumeText(r, worker.instructions) } : undefined
    const res = await startTask(deps, t.id, { handover, ...(session ? { resume: session } : {}) }).catch(async (e: Error) => {
      // Started another way meanwhile (the user, the coordinator): nothing to do.
      if (e instanceof HerdrError && e.code === 'busy') return null
      // Its machine out of reach again: not a failed resume, it waits for the engine still (no wake).
      if (e instanceof HerdrError && (e.code === 'unreachable' || e.code === 'offline')) { await store.saveTask({ ...(await store.task(t.id))!, state: 'waiting', waiting: t.waiting, run: t.run, recovery: r }); return null }
      return store.saveTask({ ...(await store.task(t.id))!, state: 'waiting', waiting: e.message })
    })
    if (!res) continue
    await store.logTask((await store.task(t.id))!, 'engine', res.state === 'working'
      ? `resumed after incident ${r.incident} (${r.cause})${session ? ', the worker\'s conversation taken up again' : ''}`
      : `could not resume after incident ${r.incident}: ${res.waiting ?? ''}`)
    resumed.push(t.id)
  }
  return { resumed, busy }
}
