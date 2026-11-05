// The step engine: moves a task through the steps of its task type. Pure: it
// takes the task's step state and one event, and returns the new state plus
// the effects for the server to carry out (send a step's instructions to its
// holder, run an engine action). It knows no tool and no workflow: only who
// holds a step, how it ends, the proofs it needs and its deadline.
import type { Evidence, Holder, Step, StepAction, Template, TaskInput } from './workflow'
import { mayMerge } from './guards'
import { taskGuards } from './actions'
import { shotsMissing, shotsText, shotMode, type Shot } from './shots'
import { advise, blocking, reviewText, sendBackText, type Advice, type Choice, type Finding, type Round } from './verdict'

// text: what the holder is told at the start. guarded: a merge only the user may do.
export interface PlannedStep extends Step { text: string, guarded?: true }

// Why the task is in Your turn, and the badge that says what to do. After N
// send-backs, the engine's advice comes with it.
export interface YourTurn { reason: 'user' | 'timeout' | 'rounds' | 'action', badge: string, advice?: Advice }

export interface StepState {
  at: number // index of the current step
  started: boolean
  since?: number // when the current step started
  deadline?: number // absolute time, from the step's timeout
  recheckAt?: number // absolute time, for a step with recheck
  told?: number // the `since` of the coordinator step whose instructions were delivered
  acting?: boolean // an engine action is running
  yourTurn?: YourTurn
  proofs: Record<string, Partial<Record<Evidence, string>>> // per step id
  shots?: Record<string, Shot[]> // the screenshots uploaded per step id (shots.ts)
  rounds: Record<string, number> // send-backs per verdict step id
  tries?: Record<string, number> // engine actions started per step id: one receipt each
  reviews?: Record<string, Round[]> // the send-backs of each verdict step
  backFrom?: string // the verdict step that sent the task back last
  extra?: Record<string, true> // verdict steps that had their one extra round
  swapped?: Record<string, true> // verdict steps after which the agent was changed
  done?: boolean
  abandoned?: true
}

export type StepEvent =
  | { kind: 'start' }
  // disputes: ids of the findings the worker contests after a send-back.
  | { kind: 'report', from: Holder, evidence?: Partial<Record<Evidence, string>>, disputes?: string[] }
  // The reviewer's findings (parseFindings); diffLines: the task's diff size, measured by the server.
  | { kind: 'verdict', from: Holder, findings: Finding[], diffLines?: number }
  // The choice after N send-backs. The coordinator gives its reason, and only picks among the advice's options.
  | { kind: 'decide', by: 'user' | 'coordinator', choice: Choice, note?: string }
  | { kind: 'user' } // the step's button, or "it is merged" said by the user
  // toAgent: the worker has to fix it (a conflict): the task goes back to its step.
  | { kind: 'action-result', ok: boolean, error?: string, evidence?: Partial<Record<Evidence, string>>, toAgent?: boolean }
  | { kind: 'tick' }

export type Effect =
  | { kind: 'instruct', step: string, holder: Holder, text: string }
  | { kind: 'action', step: string, action: StepAction, attempt: number }
  | { kind: 'split', step: string, findings: Finding[] } // a new task for what is left
  | { kind: 'swap', step: string } // another agent takes the step over, same worktree
  | { kind: 'log', text: string } // a line of the task's journal
  | { kind: 'abandon' }
  | { kind: 'done' }

export interface StepResult { state: StepState, effects: Effect[], refused?: string }

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
export const durationMs = (d: string) => Number(d.slice(0, -1)) * UNIT[d.slice(-1) as keyof typeof UNIT]

const PROOF: Record<Exclude<Evidence, 'screenshots'>, string> = { link: 'a link', commit: 'the commit', report: 'your report', 'proposed-tasks': 'the proposed tasks' }
const SHOT_HOW = 'Upload each screenshot with the command under "Screenshots" in your instructions file.'
const proofOf = (s: Step) => (e: Evidence) =>
  e === 'screenshots' ? shotsText(shotMode(s) === 'before-after' ? ['before', 'after'] : ['after']) : PROOF[e]
export const DEFAULT_ROUNDS = 2

// The steps of a task type, shared steps resolved, each with the text its
// holder gets: every level's instructions, broadest first, then the proofs.
export function planSteps(t: Template, input: TaskInput): PlannedStep[] {
  const tt = t.taskTypes[input.type]
  if (!tt) return []
  const g = taskGuards(t, input.type)
  let base: string | undefined // of the PR opened by an earlier step
  return tt.steps.map(s => (typeof s === 'string' ? t.steps![s]! : s)).map((s) => {
    if (s.action?.kind === 'github.pr') base = s.action.base
    const into = s.action?.kind === 'git.land' ? s.action.target : s.action?.kind === 'github.merge' ? base : undefined
    const guarded = into !== undefined && !mayMerge(g, into, 'engine') ? { guarded: true as const } : {}
    const own = input.steps?.[s.id]
    const parts = [t.instructions, tt.instructions, input.instructions, s.instructions, own?.instructions].map(x => x?.trim()).filter(Boolean)
    if (s.evidence?.length) parts.push(`Before you say you are done, give ${s.evidence.map(proofOf(s)).join(', ')}.`)
    if (s.evidence?.includes('screenshots')) parts.push(SHOT_HOW)
    return { ...s, ...(own?.timeout ? { timeout: own.timeout } : {}), ...guarded, text: parts.join('\n\n') }
  })
}

export const initialState = (): StepState => ({ at: 0, started: false, proofs: {}, rounds: {} })
export const currentStep = (plan: PlannedStep[], s: StepState): PlannedStep | undefined => plan[s.at]
const hasAgent = (s: Step) => !!s.holder && s.holder !== 'none'

function act(s: StepState, step: PlannedStep, effects: Effect[]): StepState {
  const attempt = (s.tries?.[step.id] ?? 0) + 1
  effects.push({ kind: 'action', step: step.id, action: step.action!, attempt })
  return { ...s, acting: true, yourTurn: undefined, tries: { ...s.tries, [step.id]: attempt } }
}

// Enters step i: a step with no end is passed through (the last one is done).
function enter(plan: PlannedStep[], prev: StepState, i: number, now: number, effects: Effect[]): StepState {
  const step = plan[i]
  const s: StepState = { ...prev, at: Math.min(i, plan.length - 1), started: true, since: now, deadline: undefined, recheckAt: undefined, acting: undefined, yourTurn: undefined }
  if (!step) return effects.push({ kind: 'done' }), { ...s, done: true }
  if (!step.ends) return i === plan.length - 1 ? (effects.push({ kind: 'done' }), { ...s, done: true }) : enter(plan, s, i + 1, now, effects)
  if (step.timeout) s.deadline = now + durationMs(step.timeout)
  if (step.recheck) s.recheckAt = now + durationMs(step.recheck)
  const text = step.ends === 'verdict' ? reviewText(step.text, s.reviews?.[step.id]?.at(-1)) : step.text
  if (hasAgent(step)) effects.push({ kind: 'instruct', step: step.id, holder: step.holder!, text })
  if (step.ends === 'user') s.yourTurn = { reason: 'user', badge: step.badge || step.userLabel || step.id }
  return step.ends === 'action' ? act(s, step, effects) : s
}

// Back to the verdict step's sendBack step, with one message: what to fix.
function sendBack(plan: PlannedStep[], state: StepState, step: PlannedStep, findings: Finding[], now: number, effects: Effect[]): StepState {
  const back = plan.findIndex(p => p.id === step.sendBack)
  const s = enter(plan, { ...state, backFrom: step.id }, back, now, [])
  effects.push({ kind: 'instruct', step: plan[back]!.id, holder: plan[back]!.holder!, text: sendBackText(step.id, findings) })
  return s
}

export function onEvent(plan: PlannedStep[], state: StepState, ev: StepEvent, now: number): StepResult {
  const effects: Effect[] = []
  const refuse = (why: string): StepResult => ({ state, effects: [], refused: why })
  const next = () => ({ state: enter(plan, state, state.at + 1, now, effects), effects })
  if (state.done) return refuse('The task is done')
  const step = plan[state.at]
  if (!step) return refuse('The task has no steps')
  if (ev.kind === 'start') {
    if (state.started) return refuse('Already started')
    return { state: enter(plan, state, step.ends ? 0 : 1, now, effects), effects }
  }
  if (!state.started) return refuse('Not started')
  const fromHolder = (from: Holder) => from === step.holder

  switch (ev.kind) {
    case 'report': {
      if (step.ends !== 'report') return refuse(`Step "${step.id}" does not end with a report`)
      if (!fromHolder(ev.from)) return refuse(`Step "${step.id}" is held by the ${step.holder}`)
      const given = { ...state.proofs[step.id], ...ev.evidence }
      const proofs = { ...state.proofs, [step.id]: given }
      // Screenshots are not given with the report: they are the images uploaded for this step.
      const shots = shotsMissing(step, state.shots?.[step.id])
      const missing = (step.evidence ?? []).filter(e => (e === 'screenshots' ? shots.length : !given[e]?.trim()))
      if (missing.length) {
        const ask = `Not done yet: step "${step.id}" needs ${missing.map(e => (e === 'screenshots' ? shotsText(shots) : PROOF[e])).join(', ')}.`
        return { state: { ...state, proofs }, effects: [{ kind: 'instruct', step: step.id, holder: step.holder!, text: ask }], refused: ask }
      }
      let reviews = state.reviews
      const from = state.backFrom, list = from ? reviews?.[from] : undefined
      if (from && list?.length && ev.disputes?.length)
        reviews = { ...reviews, [from]: [...list.slice(0, -1), { ...list.at(-1)!, disputed: ev.disputes }] }
      return { state: enter(plan, { ...state, proofs, reviews, backFrom: undefined }, state.at + 1, now, effects), effects }
    }
    case 'verdict': {
      if (step.ends !== 'verdict') return refuse(`Step "${step.id}" does not end with a verdict`)
      if (!fromHolder(ev.from)) return refuse(`Step "${step.id}" is held by the ${step.holder}`)
      // The engine decides: only a finding that weighs major or more sends back.
      const left = blocking(ev.findings)
      if (!left.length) return next()
      const n = (state.rounds[step.id] ?? 0) + 1
      const rounds = { ...state.rounds, [step.id]: n }
      const history = [...(state.reviews?.[step.id] ?? []), { findings: left, ...(ev.diffLines !== undefined ? { diffLines: ev.diffLines } : {}) }]
      const s = { ...state, rounds, reviews: { ...state.reviews, [step.id]: history } }
      // Past the rounds, nothing is sent back: the engine advises, the choice goes to Your turn.
      if (n > (step.rounds ?? DEFAULT_ROUNDS)) {
        const advice = advise({ rounds: history, nextGuarded: !!plan[state.at + 1]?.guarded, extraUsed: !!state.extra?.[step.id], swapped: !!state.swapped?.[step.id] })
        return { state: { ...s, yourTurn: { reason: 'rounds', badge: `Decide: ${step.id} failed ${n} times`, advice } }, effects }
      }
      return { state: sendBack(plan, s, step, left, now, effects), effects }
    }
    case 'decide': {
      const advice = state.yourTurn?.reason === 'rounds' ? state.yourTurn.advice : undefined
      if (!advice) return refuse('Nothing to decide')
      if (ev.by === 'coordinator' && !advice.options.includes(ev.choice))
        return refuse(advice.options.length ? `The coordinator may only choose ${advice.options.join(' or ')}` : 'This one is for the user')
      if (ev.by === 'coordinator' && !ev.note?.trim()) return refuse('Give the reason of the choice')
      if (ev.choice === 'swap' && state.swapped?.[step.id]) return refuse('The agent was already changed once')
      effects.push({ kind: 'log', text: `${step.id}: ${ev.by} chose ${ev.choice} (advice: ${advice.outcome}, ${advice.why})${ev.note?.trim() ? `. ${ev.note.trim()}` : ''}` })
      const history = state.reviews![step.id]!, last = history.at(-1)!
      const named = advice.findings.length ? last.findings.filter(f => advice.findings.includes(f.id)) : last.findings
      const done = { ...state, yourTurn: undefined }
      switch (ev.choice) {
        case 'pass': case 'worker': return { state: enter(plan, done, state.at + 1, now, effects), effects }
        case 'split':
          effects.push({ kind: 'split', step: step.id, findings: named })
          return { state: enter(plan, done, state.at + 1, now, effects), effects }
        case 'round': case 'reviewer': {
          // One more round, limited to the findings in question.
          const reviews = { ...state.reviews, [step.id]: [...history.slice(0, -1), { ...last, findings: named }] }
          return { state: sendBack(plan, { ...done, reviews, extra: { ...state.extra, [step.id]: true } }, step, named, now, effects), effects }
        }
        case 'swap': {
          effects.push({ kind: 'swap', step: step.sendBack! })
          return { state: sendBack(plan, { ...done, swapped: { ...state.swapped, [step.id]: true } }, step, last.findings, now, effects), effects }
        }
        case 'abandon':
          effects.push({ kind: 'abandon' })
          return { state: { ...done, done: true, abandoned: true }, effects }
      }
      return refuse(`Unknown choice "${ev.choice}"`)
    }
    case 'user': {
      // A failed action can be tried again by the user.
      const retry = step.ends === 'action' && !state.acting && state.yourTurn?.reason === 'action'
      if (step.ends !== 'user' && !retry) return refuse(`Step "${step.id}" does not wait for you`)
      if (state.acting) return refuse('Already checking')
      if (!step.action) return next()
      return { state: act(state, step, effects), effects }
    }
    case 'action-result': {
      if (!state.acting) return refuse('No action is running')
      const proofs = ev.evidence ? { ...state.proofs, [step.id]: { ...state.proofs[step.id], ...ev.evidence } } : state.proofs
      if (ev.ok) return { state: enter(plan, { ...state, proofs }, state.at + 1, now, effects), effects }
      const back = plan.slice(0, state.at).findLastIndex(p => p.holder === 'worker')
      if (ev.toAgent && back >= 0) {
        // One message: what to fix, not the step's text again.
        const s = enter(plan, { ...state, proofs }, back, now, [])
        effects.push({ kind: 'instruct', step: plan[back]!.id, holder: 'worker', text: `${ev.error}. Fix it, commit, then say you are done.` })
        return { state: s, effects }
      }
      // The step stays open; the badge says what went wrong.
      const badge = `${step.badge || step.userLabel || step.id}: ${ev.error || `${step.action!.kind} failed`}`
      return { state: { ...state, acting: undefined, yourTurn: { reason: 'action', badge } }, effects }
    }
    case 'tick': {
      let s = state
      if (s.recheckAt !== undefined && now >= s.recheckAt && hasAgent(step)) {
        effects.push({ kind: 'instruct', step: step.id, holder: step.holder!, text: `Check again: ${step.text}` })
        s = { ...s, recheckAt: now + durationMs(step.recheck!) }
      }
      if (s.deadline !== undefined && now >= s.deadline && !s.yourTurn)
        s = { ...s, yourTurn: { reason: 'timeout', badge: `Check ${step.id}: over ${step.timeout}` } }
      return { state: s, effects }
    }
  }
}
