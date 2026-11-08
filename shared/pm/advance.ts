// After an agent's turn: what its end signal (its wherdr.report label) means
// for the step engine, what the engine tells the agent that holds the current
// step, and when a chained task starts or waits. Pure: server/utils/pmAdvance.ts
// reads the terminals and files, and carries the result out.
import type { Evidence } from './workflow'
import { LABEL, type Run, type Task } from './run'
import { parseFindings, reviewText, sendBackText } from './verdict'
import { rereviewText } from './steps'
import { publicReviewSection } from './visibility'
import type { PlannedStep, StepEvent, StepState } from './steps'

// The agent's own end signal, typed in its terminal (hc sets HC_TERMINAL_ID).
export const DONE_CMD = `hc label "$HC_TERMINAL_ID" ${LABEL.report}=done`
const ASK_CMD = `hc label "$HC_TERMINAL_ID" ${LABEL.report}=blocked:question`

// The files of a task's run, beside its instructions file.
export const runFiles = (instructions: string) => {
  const dir = instructions.replace(/\/[^/]+$/, '')
  return { note: `${dir}/report.md`, review: `${dir}/review.md`, verdict: `${dir}/verdict.json` }
}

// How a worker ends its step: the last section of its instructions file.
export const doneSection = (note: string) => [
  '## When you are done', '',
  `Commit your work, write your closing note to ${note} (a link the step asks for goes on its first line), then run:`, '',
  `    ${DONE_CMD}`, '',
  `If you need the user's answer to go on, ask in your last message, then run \`${ASK_CMD}\`.`, '',
]

// The reviewer's instructions file: the task, what to review, how to answer.
export function reviewFile(task: Pick<Task, 'id' | 'title' | 'description'>, run: Pick<Run, 'worktree' | 'branch'>, text: string, verdict: string, publicRepo = false) {
  return [
    `# Review of ${task.id}: ${task.title}`, '', task.description.trim() || '(no description)', '',
    `The work is on branch ${run.branch}, in ${run.worktree}. Its changes: \`git diff $(git config branch.${run.branch}.wherdrstart)..HEAD\`.`,
    'Read and run what you need, but change nothing: no edit, no commit, no push.', '',
    '## Instructions', '', text, '',
    ...(publicRepo ? publicReviewSection() : []),
    '## When you are done', '',
    `Write the verdict JSON (only the {"findings":[…]} object) to ${verdict}, then run:`, '', `    ${DONE_CMD}`, '',
  ].join('\n')
}

// What the engine read after a signal: the task's commit, the size of its
// diff, the worker's note and the reviewer's verdict file.
export interface SignalRead { head?: string, diffLines?: number, note: string, verdict: string }
export const READ_SEP = '--wherdr-read--'
export function parseRead(out: string): SignalRead {
  const [head = '', lines = '', note = '', verdict = ''] = out.split(`${READ_SEP}\n`)
  const n = Number.parseInt(lines, 10)
  return { ...(head.trim() ? { head: head.trim() } : {}), ...(Number.isFinite(n) ? { diffLines: n } : {}), note: note.trim(), verdict: verdict.trim() }
}

// The note gives the proofs a report needs: itself, and its first link.
export function proofsOf(r: SignalRead): Partial<Record<Evidence, string>> {
  const link = /https?:\/\/[^\s)>\]]+/.exec(r.note)?.[0]
  return { ...(r.note ? { report: r.note, 'proposed-tasks': r.note } : {}), ...(link ? { link } : {}), ...(r.head ? { commit: r.head } : {}) }
}

// A run's "done" → the engine's event for the current step; what to fix, told
// to the agent (a verdict that does not parse); or nothing (not its step).
export function signalEvent(step: PlannedStep | undefined, role: Run['role'], r: SignalRead): StepEvent | { fix: string } | undefined {
  if (!step || step.holder !== role) return
  if (role === 'worker' && step.ends === 'report') return { kind: 'report', from: 'worker', evidence: proofsOf(r) }
  if (role !== 'reviewer' || step.ends !== 'verdict') return
  const findings = parseFindings(r.verdict || '(empty)')
  if ('error' in findings) return { fix: `${findings.error}: write {"findings":[…]} to the verdict file, then run ${DONE_CMD}` }
  return { kind: 'verdict', from: 'reviewer', findings, ...(r.diffLines !== undefined ? { diffLines: r.diffLines } : {}), ...(r.head ? { head: r.head } : {}) }
}

// What the agent that holds the current step is told, once per step start
// (`told`): undefined when nothing is due. The worker's first step is in its
// instructions file; a send-back gives what to fix, not the step again.
export function dueText(plan: PlannedStep[], s: StepState | undefined): { holder: 'worker' | 'reviewer', text: string } | undefined {
  const step = s?.started && !s.done ? plan[s.at] : undefined
  if (!step || s!.told === s!.since || (step.holder !== 'worker' && step.holder !== 'reviewer') || s!.yourTurn) return
  if (step.holder === 'reviewer') return { holder: 'reviewer', text: s!.rereview ? rereviewText(s!.rereview) : reviewText(step.text, s!.reviews?.[step.id]?.at(-1)) }
  const back = s!.backFrom ? s!.reviews?.[s!.backFrom]?.at(-1) : undefined
  const text = s!.fix ?? (back ? sendBackText(s!.backFrom!, back.findings) : step.text)
  return { holder: 'worker', text: `${text}\n\nWhen done: ${DONE_CMD}` }
}

// An engine action the advance pass runs at once. A merge the engine may do
// waits for its PR's checks (pmMechanic's merge move); a guarded one runs so
// its guard refuses it and hands it to the user's step.
export const runsNow = (step: PlannedStep | undefined, s: StepState | undefined) =>
  !!step && !!s?.acting && step.ends === 'action' && !(step.action?.kind === 'github.merge' && !step.guarded)

// The tasks a task waits for: `after: A-1,A-2`.
export const afterIds = (t: Pick<Task, 'after'>) => (t.after ?? '').split(',').map(s => s.trim()).filter(Boolean)

// What every chain wait says: the engine knows which waits are its own.
export const CHAIN_WAIT = 'which this task starts after'

// Where a chained task stands: 'go' once all its tasks are done (merged, or
// their report finished); a reason to wait for the user when one failed or
// stopped; undefined while they still run.
export function chainState(task: Task, tasks: Task[]): 'go' | { wait: string } | undefined {
  let open = false
  for (const id of afterIds(task)) {
    const t = tasks.find(x => x.id === id)
    if (!t) return { wait: `${id}, ${CHAIN_WAIT}, does not exist` }
    if (t.step?.abandoned) return { wait: `${id}, ${CHAIN_WAIT}, was abandoned` }
    if (t.step?.done) continue
    // Stopped: waiting, not on an agent's question but on a failure.
    if (t.state === 'waiting' && !t.waitKind) return { wait: `${id}, ${CHAIN_WAIT}, stopped: ${t.waiting?.split('\n')[0] ?? ''}` }
    open = true
  }
  return open ? undefined : 'go'
}
