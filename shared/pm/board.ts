// The board, from the step engine's state: a task's column is the column of
// its current step; its live indicator is the herdr-core state of the agent
// that holds that step (none for holder: none); anything waiting for the user
// puts it in Your turn, whatever its step, with a badge saying what to do.
import type { Holder } from './workflow'
import type { PlannedStep, StepState } from './steps'
import type { Run, Task } from './run'

export type Phase = 'todo' | 'working' | 'done'
export const PHASES: Phase[] = ['todo', 'working', 'done']

export interface Card {
  id: string
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
}

export interface BoardProject { key: string, name: string, columns: string[] }
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
    id: task.id, project: task.project, title: task.title, description: task.description,
    column: plan.length ? columnOf((s?.done ? plan.at(-1) : step) ?? plan[0]!) : 'To do',
    phase: s?.done ? 'done' : started || running ? 'working' : 'todo',
    ...(step ? { step: step.id } : {}),
    holder,
    ...(run?.terminal ? { terminal: run.terminal } : {}),
    ...(yourTurn ? { yourTurn } : {}),
    ...(step?.ends === 'user' && started && !s?.done ? { userLabel: step.userLabel || 'Done' } : {}),
    tags: task.tags ?? [],
    // Then the links steps gave as their proof (the PR), labelled by step.
    links: [...task.links ?? [], ...plan.flatMap(p => (s?.proofs[p.id]?.link ? [{ label: p.id, url: s.proofs[p.id]!.link! }] : []))],
    log: (task.log ?? []).slice(-30),
    plan,
    ...(s ? { state: s } : {}),
  }
}

// The card's one-tap link: its PR when it has one, else its first link.
export const mainLink = (c: Pick<Card, 'links'>) => c.links.find(l => /^pr$/i.test(l.label)) ?? c.links[0]

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
