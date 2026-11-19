// What a task that waits for the user asks of them, for the "To do" tab its
// sheet opens on (TaskSheet). undefined: it does not wait for the user.
// merge: a step of the user's after screenshots (look, then merge or send back).
// decide: the choice after N send-backs. stopped: how to go on. step: a step
// that ends with the user's button. ask: the agent's question or permission.
// refused: a failed engine action (a merge refused). review: a review over its
// time limit or whose reviewer stopped, with no verdict (Restart the review).
// coordinator: a step the coordinator holds, past its time limit or waiting
// until the user writes (coordinatorWait): what waits, and Ask the coordinator.
// blocked: anything else that waits (overdue, a task it starts after failed).
// An approved merge on its way stays merge or step, its button loading (mergeWaits);
// a merge to accept is one too while the engine updates its PR (mayAccept).
import { coordinatorWait, mayAccept, mergeWaits, type Card } from '#shared/pm/board'
import { actionFix } from '#shared/pm/refusal'

// How long a button that went through says so (Approved, Sent back) before what comes next.
export const DONE_MS = 400

export type TodoKind = 'merge' | 'decide' | 'stopped' | 'step' | 'ask' | 'refused' | 'review' | 'coordinator' | 'blocked'

// The steps before the current one with screenshots, newest first.
export const shotSteps = (c: Pick<Card, 'plan' | 'state'>) =>
  c.plan.slice(0, c.state?.at ?? 0).filter(s => c.state?.shots?.[s.id]?.length).reverse()

// Ask the agent to fix it: a block of a started task its worker could fix (a failed
// action, a stall, an ended worker, a step over its time limit; the server says
// exactly, fixableBlock), not a review's (Restart the review) nor a stop's. A step's
// own Your turn only for a failed action or a time limit, as the server reads it;
// a failed action only when the failure may be in the code (actionFix).
const failedFix = (c: Card) => (c.state?.yourTurn?.reason === 'action' ? actionFix(c.state.yourTurn.error ?? c.state.yourTurn.badge) : undefined)
export const fixable = (c: Card, kind: TodoKind | undefined) =>
  (kind === 'refused' || kind === 'blocked') && !!c.state?.started && !c.state.done && !c.state.acting && !c.state.agent && !c.stopped && c.holder !== 'reviewer'
  && (!c.state.yourTurn || c.state.yourTurn.reason === 'timeout' || (c.state.yourTurn.reason === 'action' && failedFix(c) !== 'outside'))

// Ask the agent to fix it is the first button, Try again then secondary: a block
// its worker fixes. An action failed for an unknown reason has Try again first.
export const fixFirst = (c: Card, kind: TodoKind | undefined) => fixable(c, kind) && failedFix(c) !== 'unknown'

export function taskTodo(c: Card): TodoKind | undefined {
  if (c.stopped) return 'stopped'
  if (coordinatorWait(c)) return 'coordinator'
  // An approved merge on its way keeps its tab, its Merge loading until it ends.
  if (c.userLabel && mergeWaits(c) !== undefined) return shotSteps(c).length ? 'merge' : 'step'
  if (!c.yourTurn && mayAccept(c)) return shotSteps(c).length ? 'merge' : 'step'
  if (!c.yourTurn || c.state?.done) return
  const reason = c.state?.yourTurn?.reason
  if (reason === 'rounds' && c.state?.yourTurn?.advice) return 'decide'
  if (reason === 'action') return 'refused'
  if (c.asks) return 'ask'
  if (c.holder === 'reviewer' && (reason === 'timeout' || (!reason && !c.terminal))) return 'review'
  if (reason === 'user' && c.userLabel) return shotSteps(c).length ? 'merge' : 'step'
  return 'blocked'
}
