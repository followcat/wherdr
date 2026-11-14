// The user reports a problem on a task that waits for them (POST /api/pm/report):
// kept on the task and its log, and sent to the project's coordinator as the
// user's own message (started first when it does not run), never to the agent.
import { REPORT_MAX, reportMessage, reviewLine } from '../../shared/pm/report'
import { ASKED_COORDINATOR, cardOf, coordinatorWait, mainLink } from '../../shared/pm/board'
import { taskPlan } from '../../shared/pm/run'
import { currentStep, durationMs, initialState } from '../../shared/pm/steps'
import { shotUrl } from '../../shared/pm/shots'
import { shownTaskId } from '../../shared/pm/projectKey'
import { noteTurn, startCoordinator, type CoordinatorUrls } from './pmCoordinator'
import { noteBack } from './pmStall'
import type { CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'
import { HerdrError } from './herdr'
import { coordinatorKey } from '../../shared/pm/workspace'

type Deps = CoreAdminDeps & { store: PmStore }

export async function userReport(deps: Deps, body: { id?: unknown, text?: unknown, shots?: unknown, block?: unknown }, urls: CoordinatorUrls) {
  const { store } = deps
  const task = await store.task(body.id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > REPORT_MAX) throw new HerdrError('bad_input', `text: what is wrong, ${REPORT_MAX} characters at most`)
  if (!task.step?.yourTurn || task.step.done) throw new HerdrError('refused', 'The task does not wait for you')
  // Only screenshots of this task.
  const own = new Set(Object.values(task.step.shots ?? {}).flat().map(s => s.file))
  const shots = Array.isArray(body.shots) ? [...new Set(body.shots.filter((f): f is string => typeof f === 'string' && own.has(f)))] : []
  const projects = await store.projects()
  const p = projects.find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!t) throw new HerdrError('not_found', 'The project has no template')
  const plan = taskPlan(t, task, p), state = task.step ?? initialState()
  const card = cardOf(task, plan, await store.runs())
  const report = { at: Date.now(), text, shots, block: body.block !== false }
  const msg = reportMessage({
    id: shownTaskId(projects, task.id), title: task.title, step: currentStep(plan, state)?.id, text, block: report.block,
    shots: shots.map(f => `${store.shotPath(task.id, f)} (from another machine: $WHERDR_URL${shotUrl(task.id, f)})`),
    pr: mainLink(card)?.url, verdict: reviewLine(plan, state.at, state.rounds),
  })
  await toCoordinator(deps, task.project, msg, text, urls)
  return store.logTask({ ...task, report }, 'user', `reported a problem${report.block ? ', merge blocked' : ''}: ${text.slice(0, 300)}`)
}

// Ask the coordinator (POST /api/pm/ask-coordinator): a step it holds, past its
// time limit or waiting until the user writes, gets the user's short message,
// as if typed in its chat. It counts as the user writing: the rechecks start
// over from the step's own, and a time limit passed is back to work (noteBack).
export async function askCoordinator(deps: Deps, id: unknown, urls: CoordinatorUrls) {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const projects = await store.projects()
  const p = projects.find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!t) throw new HerdrError('not_found', 'The project has no template')
  const plan = taskPlan(t, task, p), now = Date.now()
  const wait = coordinatorWait(cardOf(task, plan, await store.runs(), now))
  if (!wait || wait.asked !== undefined) throw new HerdrError('refused', 'The coordinator does not wait for you on this task')
  const step = plan[task.step!.at]!
  const msg = `Check where ${shownTaskId(projects, task.id)} (${task.title}) stands at its ${step.id} step and end the step or tell me what blocks it.`
  await toCoordinator(deps, task.project, msg, msg, urls)
  // Read again after delivery: the coordinator or the engine may have moved the
  // step meanwhile. Only the same run of the same step is reset; else the ask is just logged.
  const fresh = (await store.task(task.id))!, cur = fresh.step
  const same = !!cur?.started && !cur.done && cur.at === task.step!.at && cur.since === task.step!.since
  const s = same ? { ...cur, rechecks: 0, waitUser: undefined, ...(step.recheck ? { recheckAt: now + durationMs(step.recheck) } : {}) } : cur
  const logged = await store.logTask({ ...fresh, ...(s ? { step: s } : {}) }, 'user', `${ASKED_COORDINATOR}${step.id} step`)
  return same ? noteBack(store, logged, plan, 'user', 'the user asked the coordinator', now) : logged
}

export async function withdrawReport(store: PmStore, id: unknown) {
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  if (!task.report) return task
  return store.logTask({ ...task, report: undefined }, 'user', 'withdrew the reported problem')
}

// Typed into its terminal as the user's message; a coordinator that does not
// run starts with it as its first message.
async function toCoordinator(deps: Deps, project: string, msg: string, said: string, urls: CoordinatorUrls) {
  // A member's task: its workspace's coordinator.
  const key = coordinatorKey(project, await deps.store.projects()), c = await deps.store.coordinator(key)
  const live = c?.terminal && await deps.call<{ state?: string }>('terminal.get', { terminal: c.terminal }, 3000).then(s => s?.state !== 'finished', () => false)
  if (live) await deps.call('terminal.send', { terminal: c!.terminal, text: msg }, 30000)
  else await startCoordinator(deps, key, {}, urls, [msg])
  await noteTurn(deps.store, key, 'user', said)
}
