// An agent's question answered (Tasks to review's buttons and field, the
// agent's conversation, a coordinator's tell): its wherdr.report label goes
// (the agent sets it again for its next question) and its task works again at
// once, off Your turn and Tasks to handle, without waiting for the engine's pass.
import { LABEL, waitOf, type Task } from '../../shared/pm/run'
import type { CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

export const clearQuestion = (deps: Pick<CoreAdminDeps, 'call'>, terminal: string) =>
  deps.call('terminal.label', { terminal, labels: { [LABEL.report]: '' } }, 8000).catch(() => {})

// The task as it is once its question is answered (answered: no second wake for it).
export const answeredTask = (t: Task): Task => (t.state === 'waiting' && t.waitKind === 'question'
  ? { ...t, state: 'working', waiting: undefined, waitKind: undefined, question: undefined, answered: Date.now() }
  : t)

// text: sent to the asking agent first, as the user's message; none: the
// user answered in the agent's conversation (terminal: that agent's).
export async function answerQuestion(deps: Pick<CoreAdminDeps, 'call'> & { store: PmStore }, id: unknown, text: unknown, terminal?: unknown) {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const run = (await store.runs()).find(r => r.id === task.run)
  const asks = task.state === 'waiting' && task.waitKind === 'question' && run?.terminal && run.state !== 'ended'
  const said = typeof text === 'string' ? text.trim() : ''
  if (!said) {
    // Its question maybe not read by the engine yet: its label says so.
    if (!run?.terminal || run.state === 'ended' || terminal !== run.terminal) return task
    const live = asks || waitOf(await deps.call<Parameters<typeof waitOf>[0]>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null)) === 'question'
    return live ? store.logTask(await cleared(deps, task, run.terminal), 'user', 'answered its agent\'s question in its conversation') : task
  }
  if (!asks) throw new HerdrError('stale', 'The agent no longer waits on this question')
  await deps.call('terminal.send', { terminal: run.terminal, text: said }, 30000)
  return store.logTask(await cleared(deps, task, run.terminal!), 'user', `answered its agent's question: ${said.slice(0, 300)}`)
}
const cleared = async (deps: Pick<CoreAdminDeps, 'call'>, task: Task, terminal: string) => { await clearQuestion(deps, terminal); return answeredTask(task) }
