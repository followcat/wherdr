// Agents of a task that waits for the user, or in the merge queue, are ended once idle for 10 minutes
// (30 after the user's last message to one of them, never while its
// conversation is open: pmTalk.ts), every minute from the mechanic's pass, and
// its worker starts again in the same worktree when the task needs it: a
// send-back, a conflict, red CI, or the user opening its conversation
// (wakeReleased). The rules are in shared/pm/release.ts.
import { LABEL, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { PUSH_LEFT_SCRIPT, RELEASED_WHY, idleSince, releaseDue, restartedLine, roomWanted, waitsForUser, waitsInQueue, wasReleased } from '../../shared/pm/release'
import { roomShort } from '../../shared/pm/placement'
import { HerdrError } from './herdr'
import { talkOf } from './pmTalk'
import { errorText } from '../../shared/pm/actions'
import { handoverText } from '../../shared/pm/stop'
import { runOn, startTask, type PmLaunchDeps } from './pmLaunch'
import { actionShell } from './pmActions'
import { endAgents, load } from './pmStop'
import { forgetMemory } from './pmMemory'
import { placeFor } from './pmPlace'
import { reviveWeight, weightOf } from '../../shared/pm/weight'

type StatusTerminal = LabelledTerminal & { status?: string | { state?: string } | null }
const busyNow = (t?: StatusTerminal) => {
  const s = typeof t?.status === 'string' ? t.status : t?.status?.state
  return !t || (t.state !== 'finished' && (s === 'working' || s === 'blocked'))
}

// Task id → since when its agents are idle while it waits for the user. In
// memory: a restart starts the 10 minutes again.
const idle = new Map<string, number>()
const unpushedLogged = new Set<string>()

// The task branch's commits not on origin yet, pushed before its agents go:
// pushed, nothing to push, or why not.
async function pushLeft(deps: PmLaunchDeps, run: Run): Promise<{ error?: string, pushed?: true }> {
  const r = await Promise.resolve().then(() => actionShell(deps, runOn(deps, run))(PUSH_LEFT_SCRIPT, [run.worktree, run.branch])).catch((e: Error) => ({ code: 1, out: e.message }))
  const last = (s: string) => s.trim().split('\n').pop()?.trim().slice(0, 300) ?? ''
  return r.code === 0 ? (last(r.out) === 'pushed' ? { pushed: true } : {}) : { error: last(errorText(r)) || 'git push failed' }
}

export async function releaseIdle(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const { terminals } = await deps.call<{ terminals: StatusTerminal[] }>('terminal.list', { all: true, labels: { [LABEL.install]: await store.install() } }, 8000)
  const runs = (await store.runs()).filter(r => r.state !== 'ended')
  const released: string[] = []
  const tasks = await store.tasks()
  for (let task of tasks) {
    const mine = runs.filter(r => r.task === task.id)
    // A run still starting has no terminal yet: busy.
    const busy = mine.some(r => !r.terminal || busyNow(terminals.find(x => x.address === r.terminal)))
    const since = mine.length ? idleSince(idle.get(task.id), task, busy, now) : undefined
    if (since === undefined) { idle.delete(task.id); continue }
    idle.set(task.id, since)
    const due = releaseDue(since, now, talkOf(mine.map(r => r.terminal), now), mine.some(r => roomWanted(tasks, r.machine)))
    if (!due) continue
    // Committed work is never left unpushed: pushed first, or its agents stay (tried again in 10 minutes).
    const worker = mine.filter(r => r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    const push = worker ? await pushLeft(deps, worker) : {}
    if (push.error) {
      idle.set(task.id, now)
      if (!unpushedLogged.has(task.id)) await store.logTask(task, 'engine', `kept its agents: could not push the branch's unpushed commits (${push.error})`)
      unpushedLogged.add(task.id)
      continue
    }
    unpushedLogged.delete(task.id)
    idle.delete(task.id)
    if (push.pushed) task = await store.logTask(task, 'engine', 'pushed the branch\'s unpushed commits before releasing its agents')
    const cut = due === 'cut' ? ', the 30 minutes kept after your last message cut short: a task waiting to start needs the memory' : ''
    const t = await store.logTask(task, 'engine', `released its agents: idle for 10 minutes while the task waits ${waitsInQueue(task) && !waitsForUser(task) ? 'in the merge queue' : 'for you'}${cut}; they start again when it needs them, or when you open the worker's conversation`)
    await endAgents(deps, t, 'released', ' to free memory')
    released.push(task.id)
  }
  return released
}

const heldLogged = new Set<string>()
// The released worker again, in its worktree, with a handover note; `now`:
// what it is to do first (red CI, a conflict), when the step itself does not
// say it. No room on its machine: not now, tried again on a later pass (undefined;
// onHold gets why). stopped: why its handover says it was stopped. resume: a
// Claude worker's conversation is taken up again, with that first message.
export async function reviveWorker(deps: PmLaunchDeps, id: string, why: string, now?: string, onHold?: (hold: string) => void, stopped = RELEASED_WHY, resume?: string): Promise<Task | undefined> {
  const { store } = deps
  const { task, plan } = await load(deps, id)
  const worker = (await store.runs()).filter(r => r.task === id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!worker) return
  const t = await store.workflow(task.project).catch(() => null)
  const weight = reviveWeight(weightOf(t, task).weight, task.step && plan[task.step.at], task.step?.shots)
  const placed = await placeFor(deps, task, { weight })
  if ('hold' in placed) {
    onHold?.(placed.hold)
    if (!heldLogged.has(id)) await store.logTask(task, 'engine', `the worker starts again once there is room (${why}): ${placed.hold}`)
    return void heldLogged.add(id)
  }
  heldLogged.delete(id)
  forgetMemory(worker.machine)
  const handover = handoverText({ ...task, stopped: { by: 'the engine', why: stopped, at: Date.now() } }, plan, worker.branch)
    + (now ? `\nWhat to do now:\n\n${now}\n` : '')
  const started = await startTask(deps, id, { handover, revive: true, ...(resume && worker.session ? { resume: { session: worker.session, text: resume } } : {}) })
  if (started.state !== 'working') return store.logTask(started, 'engine', `could not start the worker again (${why}): ${started.waiting ?? ''}`)
  // The handover gives the step's text: not sent again.
  const step = started.step && { ...started.step, told: started.step.since }
  return store.logTask({ ...started, step }, 'engine', `started the worker again in its worktree: ${why}`)
}

// The user opens the conversation of a worker the engine released: started
// again in its worktree, its conversation taken up again with one line saying
// so; then the user writes to it as before. Refused with why when it cannot.
export async function wakeReleased(deps: PmLaunchDeps, id: string): Promise<Task> {
  const worker = (await deps.store.runs()).filter(r => r.task === id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!wasReleased(worker)) throw new HerdrError('refused', 'Its worker was not released')
  const at = new Date(worker!.endedAt ?? Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  let hold = ''
  const t = await reviveWorker(deps, id, 'the user opened its conversation', undefined, (h) => { hold = h }, RELEASED_WHY, restartedLine(at))
  if (t?.state !== 'working') throw new HerdrError('refused', hold ? `Not enough room to start it again now: ${roomShort(hold) ?? hold}` : `It could not start again: ${t?.waiting ?? 'try again later'}`)
  return t
}
