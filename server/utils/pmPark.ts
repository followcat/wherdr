// A worker's `blocked:on <task|repo>: <need>` report carried out, and the
// parked tasks whose wait is over taken up again in the same conversation.
// The rules are in shared/pm/park.ts.
import { BLOCKED_ON_CMD, parkOf, parseBlockedOn, resumeText, roomResumeText } from '../../shared/pm/park'
import type { Run, Task } from '../../shared/pm/run'
import type { Project } from '../../shared/pm/project'
import { boardOrder } from '../../shared/pm/boardOrder'
import { showIds, shownTaskId } from '../../shared/pm/projectKey'
import { roomWaits } from './pmPlace'
import type { PmLaunchDeps } from './pmLaunch'
import { endAgents } from './pmStop'
import { reviveWorker } from './pmRelease'
import { wakeCoordinators } from './pmWakes'

const PARKED_WHY = 'the task waited for another task, so its agents were ended to free their machine'
const ROOM_WHY = 'the coordinator paused the task to free room on its machine'
// A paused task whose worker could not start again: tried again after this long, still paused meanwhile;
// at its ROOM_TRIES-th failure the pause ends: the task waits with the real reason, its coordinator woken.
const ROOM_RETRY_MS = 10 * 60_000
const ROOM_TRIES = 3
const roomFailed = new Map<string, { at: number, tries: number }>()

export async function blockedOn(deps: PmLaunchDeps, run: Run, label: string, now: number) {
  const { store } = deps, projects = await store.projects()
  const task = await store.task(run.task)
  if (!task || task.parked || task.step?.done) return
  const tell = (text: string) => deps.call('terminal.send', { terminal: run.terminal, text: showIds(projects, text) }, 30000)
  const asked = parseBlockedOn(label)
  if (!asked) return void await tell(`Not understood. Say it as: ${BLOCKED_ON_CMD}`)
  const r = parkOf(task, asked.on, asked.need, await store.tasks(), projects, now)
  // Each wake once: its key noted on the task first.
  const wake = async (key: string, text: string) => {
    const t = (await store.task(task.id))!
    if (t.mech?.[key]) return
    await store.saveTask({ ...t, mech: { ...t.mech, [key]: now } })
    await wakeCoordinators(deps, t, text, now)
  }
  if ('refused' in r) {
    await store.logTask(task, 'engine', `blocked on ${asked.on}: refused. ${r.refused}`)
    if (r.key && r.wake) await wake(r.key, r.wake)
    return void await tell(r.refused)
  }
  const saved = await store.logTask(r.park, 'engine', `parked: waits for ${r.park.parked!.on}: ${asked.need}`)
  // Ended only when its conversation can be taken up again (a Claude worker's pinned session);
  // another stays, idle, out of its machine's cap (agentsAtWork), and is told when it goes on.
  const live = (await store.runs()).filter(x => x.task === task.id && x.state !== 'ended')
  if (live.every(x => x.role !== 'worker' || (x.program === 'claude' && !!x.session))) await endAgents(deps, saved, 'released', ' while the task is parked')
  await wake(r.key, r.wake)
}

// A parked task whose wait is over: its worker told what changed, in its
// conversation (resumed when it was ended; a fresh one with a handover when it has none).
export async function resumeParked(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps, projects = await store.projects(), tasks = await store.tasks()
  // A task stopped meanwhile waits for the user's Continue: never started here.
  const going = (t: typeof tasks[number]) => !!t.parked && !t.step?.done && !t.stopped && t.state === 'working'
  // Paused for room: in board order, each once its machine has room (placeFor keeps the cap). One that
  // still waits keeps the machine for itself: neither a later paused task nor a new one starts there.
  const waits = new Map<string, string>()
  for (const task of boardOrder(tasks.filter(t => going(t) && t.parked!.room))) {
    const p = task.parked!
    if (waits.has(p.on)) continue
    const wait = `${shownTaskId(projects, task.id)}, paused for room there, starts first`
    const failed = roomFailed.get(task.id)
    if (failed && now - failed.at < ROOM_RETRY_MS) { waits.set(p.on, wait); continue }
    const worker = (await store.runs()).filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    const text = roomResumeText(p)
    // A throw (busy: the user's Resume now meanwhile) keeps the machine this pass; the others go on.
    const t = await reviveWorker(deps, task.id, `there is room on ${p.room} again`, worker?.session ? undefined : text, undefined, ROOM_WHY, text).catch(() => 'threw' as const)
    if (t === 'threw') { waits.set(p.on, wait); continue }
    if (t?.state === 'working') { roomFailed.delete(task.id); await store.saveTask({ ...(await store.task(task.id))!, parked: undefined }); continue }
    // No room yet (no task back): it keeps the machine for itself.
    if (!t) { waits.set(p.on, wait); continue }
    // Its start failed for another reason (startTask left it waiting with it): still paused, never
    // the user's turn, tried again later; past ROOM_TRIES the pause ends and the real reason shows.
    const tries = (failed?.tries ?? 0) + 1
    const cur = (await store.task(task.id))!
    if (tries >= ROOM_TRIES) {
      roomFailed.delete(task.id)
      const why = (cur.waiting ?? 'its start failed').split('\n')[0]
      await store.logTask({ ...cur, parked: undefined }, 'engine', `paused for room: its worker could not start again ${tries} times, the pause ends: ${why}`)
      await wakeCoordinators(deps, cur, showIds(projects, `${task.id} (${task.title}) was paused for room on ${p.room}; its worker could not start again (${why}). It waits: \`wherdr pm resume ${task.id}\` once that is fixed.`), now)
      continue
    }
    roomFailed.set(task.id, { at: now, tries })
    waits.set(p.on, wait)
    await store.saveTask({ ...cur, state: 'working', waiting: undefined, waitKind: undefined, parked: cur.parked ?? p })
  }
  roomWaits.clear()
  for (const [m, w] of waits) roomWaits.set(m, w)
  for (const task of tasks.filter(t => going(t) && !t.parked!.room)) await resumeOne(deps, task, tasks, projects).catch(() => {})
}

// One parked task whose wait is over (a throw leaves it parked for the next pass).
async function resumeOne(deps: PmLaunchDeps, task: Task, tasks: Task[], projects: Project[]) {
  const { store } = deps
  const text = resumeText(task, tasks, projects)
  if (!text) return
  const worker = (await store.runs()).filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  const why = `${task.parked!.on} is done, the parked task goes on`
  if (worker?.terminal && worker.state !== 'ended') {
    await deps.call('terminal.send', { terminal: worker.terminal, text: showIds(projects, text) }, 30000)
    await store.logTask({ ...task, parked: undefined }, 'engine', why)
    return
  }
  const t = await reviveWorker(deps, task.id, why, worker?.session ? undefined : text, undefined, PARKED_WHY, text)
  if (t?.state === 'working') await store.saveTask({ ...(await store.task(task.id))!, parked: undefined })
}
