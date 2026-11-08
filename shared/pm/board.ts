// The board, from the step engine's state: a task's column is the column of
// its current step; its live indicator is the herdr-core state of the agent
// that holds that step (none for holder: none); anything waiting for the user
// puts it in Your turn, whatever its step, with a badge saying what to do.
import type { Holder } from './workflow'
import type { PlannedStep, StepState } from './steps'
import type { Run, Task, WaitKind } from './run'
import { notStarted, type Stopped } from './stop'
import { afterIds } from './advance'
import { GREEN, type Check, type PrInfo } from './actions'

export type Phase = 'todo' | 'working' | 'done'
export const PHASES: Phase[] = ['todo', 'working', 'done']

export interface Card {
  id: string
  shown: string // the id as the user sees it, with the project's current key (projectKey.ts)
  project: string
  title: string
  description: string
  column: string // the step's column in its project's view
  phase: Phase // the column in the all-projects view
  step?: string // the current step's id, once started
  holder: Holder
  terminal?: string // herdr-core address of the holder's agent, if it runs
  yourTurn?: string // the badge
  userLabel?: string // the button of a step that waits for the user
  tags: string[]
  links: { label: string, url: string }[]
  log: { at: number, by: string, text: string }[] // newest last: tags, links, the coordinator's choices and their reason
  plan: PlannedStep[]
  state?: StepState
  stopped?: Stopped // who stopped it and why: Continue, Take it as it is or Archive
  removable?: true // never started (no agent, worktree or branch): the user may remove it
  after?: string[] // tasks of the same project it starts after
  prNow?: string // its PR as the engine last read it (prNow)
  held?: string // waits for memory on its machine
  asks?: { kind: WaitKind, text: string } // its agent waits on a question, a permission or a login
}

// types: the project's task types, each with its steps in one line ("work → review → merge").
export interface BoardProject { key: string, label?: string, aliases?: string[], color?: string, name: string, columns: string[], types: { id: string, plan: string }[] }
// GET /api/pm/board
export interface Board { projects: BoardProject[], cards: Card[] }

export const columnOf = (s: PlannedStep) => s.column || s.id

// The columns of a project: those of every task type's steps, in order, once each.
export function boardColumns(plans: PlannedStep[][]): string[] {
  const out: string[] = []
  for (const plan of plans) {
    let at = 0
    for (const c of plan.map(columnOf)) {
      const i = out.indexOf(c)
      if (i < 0) out.splice(at++, 0, c)
      else at = Math.max(at, i + 1)
    }
  }
  return out
}

export function cardOf(task: Task, plan: PlannedStep[], runs: Run[]): Card {
  const s = task.step
  const started = !!s?.started && !!plan.length
  // Working with no step recorded (started before the engine kept it): its worker's step.
  const running = !started && task.state === 'working'
  const step = started ? plan[s!.at] : running ? plan.find(p => p.holder === 'worker') : undefined
  const holder: Holder = (!s?.done && step?.holder) || (running ? 'worker' : 'none')
  // The holder's agent: its latest run that has not ended.
  const run = holder === 'worker' || holder === 'reviewer'
    ? runs.filter(r => r.task === task.id && r.role === holder && r.state !== 'ended').sort((a, b) => b.startedAt - a.startedAt)[0]
    : undefined
  const yourTurn = s?.yourTurn?.badge || (task.state === 'waiting' ? task.waiting || 'Waiting' : undefined)
  return {
    id: task.id, shown: task.id, project: task.project, title: task.title, description: task.description,
    column: plan.length ? columnOf((s?.done ? plan.at(-1) : step) ?? plan[0]!) : 'To do',
    phase: s?.done ? 'done' : started || running ? 'working' : 'todo',
    ...(step ? { step: step.id } : {}),
    holder,
    ...(run?.terminal ? { terminal: run.terminal } : {}),
    ...(yourTurn ? { yourTurn } : {}),
    ...(step?.ends === 'user' && started && !s?.done ? { userLabel: step.userLabel || 'Done' } : {}),
    tags: task.tags ?? [],
    // Then the links steps gave as their proof (the PR), labelled by step; each address once.
    links: [...task.links ?? [], ...plan.flatMap(p => (s?.proofs[p.id]?.link ? [{ label: p.id, url: s.proofs[p.id]!.link! }] : []))]
      .filter((l, i, all) => all.findIndex(x => x.url === l.url) === i),
    log: (task.log ?? []).slice(-30),
    plan,
    ...(s ? { state: s } : {}),
    ...(task.stopped ? { stopped: task.stopped } : {}),
    ...(task.state === 'waiting' && task.waitKind ? { asks: { kind: task.waitKind, text: task.waiting?.split('\n')[0] ?? '' } } : {}),
    ...(task.held && task.state === 'todo' ? { held: task.held } : {}),
    ...(notStarted(task, runs) ? { removable: true as const } : {}),
    ...(task.after ? { after: afterIds(task) } : {}),
  }
}

// The card's one-tap link: its PR when it has one, else its first link.
// A task the user may stop: started, not done, not stopped already.
export const canStop = (c: Pick<Card, 'state' | 'stopped'>) => !!c.state?.started && !c.state.done && !c.stopped

// A task the user may start by hand: to do, not stopped (its sheet resumes it).
// One that waits for others shows them instead (waitsFor).
export const canStart = (c: Pick<Card, 'phase' | 'stopped' | 'state'>) => c.phase === 'todo' && !c.state?.started && !c.stopped

// The tasks a card still waits for: its 'after' ones not done yet (a removed one is not waited for).
export const waitsFor = (c: Pick<Card, 'after'>, cards: Pick<Card, 'id' | 'phase'>[]) =>
  (c.after ?? []).filter(id => cards.some(x => x.id === id && x.phase !== 'done'))

export const mainLink = (c: Pick<Card, 'links'>) => c.links.find(l => /^pr$/i.test(l.label)) ?? c.links[0]
// A GitHub PR's link reads 'PR #12'; any other keeps its label.
export const linkLabel = (l: { label: string, url: string }) => { const n = /\/pull\/(\d+)/.exec(l.url)?.[1]; return n ? `PR #${n}` : l.label }

// The tags of the cards, once each, to filter the board by.
export const boardTags = (cards: Pick<Card, 'tags'>[]) => [...new Set(cards.flatMap(c => c.tags))].sort()

// The columns shown: Your turn first, then the project's columns (or To do /
// Working / Done for all projects). A card in Your turn is in no other column.
export function boardLanes(cards: Card[], columns: string[] | null): { id: string, cards: Card[] }[] {
  const lane = (c: Card) => (columns ? c.column : c.phase)
  return [
    { id: 'your-turn', cards: cards.filter(c => c.yourTurn) },
    ...(columns ?? PHASES).map(id => ({ id, cards: cards.filter(c => !c.yourTurn && lane(c) === id) })),
  ]
}

// Its PR as the engine reads it every minute: checks first, then what GitHub
// says of the merge. required: the merge step's checks, absent until reported.
export function prNow(pr: (PrInfo & { mergeStateStatus?: string }) | undefined, required: string[] = []): string | undefined {
  if (!pr) return
  if (pr.merged) return 'merged'
  const checks = pr.statusCheckRollup ?? []
  const name = (c: Check) => c.name || c.context || 'a check'
  const running = (c: Check) => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state ?? '')
  const red = checks.filter(c => !running(c) && !GREEN.includes(c.conclusion || c.state || ''))
  if (red.length) return `checks failed (${red.map(name).join(', ')})`
  const waiting = [...required.filter(n => !checks.some(c => name(c) === n)), ...checks.filter(running).map(name)]
  if (waiting.length) return `waiting for checks (${[...new Set(waiting)].join(', ')})`
  const state = { BLOCKED: 'blocked by the branch rules', DIRTY: 'conflict with its base', BEHIND: 'behind its base' }[pr.mergeStateStatus ?? '']
  return state ?? 'ready to merge'
}

// The checks the task's merge step waits for.
export const requiredChecks = (plan: PlannedStep[]) => plan.flatMap(p => (p.action?.kind === 'github.merge' ? p.action.checks ?? [] : []))

export interface CardStatus { text: string, tone: 'wait' | 'bad' | 'ok', at?: number }
const MERGES = ['github.merge', 'git.verify-merged']
const bad = (text: string): CardStatus => ({ text, tone: 'bad' })
const blocked = (error: string) => bad(/check\(s\) failed/.test(error) ? 'checks failed' : `blocked: ${error.replace(/^[\w-]+: /, '')}`)
const ofPr = (pr: string): CardStatus => (pr === 'merged'
  ? { text: 'merged on GitHub', tone: 'ok' }
  : { text: `PR open · ${pr}`, tone: /^(checks failed|blocked|conflict)/.test(pr) ? 'bad' : 'wait' })

// Where a task's PR and merge stand, in one short line: from its step state
// and what the engine last read of its PR. None before a PR, or once stopped.
// A done task merged by a step: 'merged', at the time it was done.
export function cardStatus(c: Pick<Card, 'plan' | 'state' | 'stopped' | 'prNow' | 'held'>): CardStatus | undefined {
  const s = c.state
  if (c.held) return { text: c.held, tone: 'wait' }
  if (!s?.started || c.stopped) return
  if (s.done) {
    const merged = c.plan.some(p => p.action && MERGES.includes(p.action.kind) && s.proofs[p.id] && Object.keys(s.proofs[p.id]!).length)
    return merged ? { text: 'merged', tone: 'ok', ...(s.since ? { at: s.since } : {}) } : undefined
  }
  const kind = c.plan[s.at]?.action?.kind
  const failed = s.yourTurn?.reason === 'action' ? s.yourTurn.error ?? '' : undefined
  if (kind === 'github.pr') return s.acting ? { text: 'opening the PR', tone: 'wait' } : failed !== undefined ? blocked(failed) : undefined
  const pr = c.plan.slice(0, s.at).some(p => p.action?.kind === 'github.pr') ? c.prNow : undefined
  if (failed !== undefined) return pr?.startsWith('checks failed') ? ofPr(pr) : blocked(failed)
  // The merge runs: it waits for the checks, then merges.
  if (s.acting && kind && MERGES.includes(kind)) return pr && pr !== 'ready to merge' && kind === 'github.merge' ? ofPr(pr) : { text: 'merging', tone: 'wait' }
  return pr ? ofPr(pr) : undefined
}
