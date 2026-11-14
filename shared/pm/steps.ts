// The step engine: moves a task through the steps of its task type. Pure: it
// takes the task's step state and one event, and returns the new state plus
// the effects for the server to carry out (send a step's instructions to its
// holder, run an engine action). It knows no tool and no workflow: only who
// holds a step, how it ends, the proofs it needs and its deadline.
import { WATCH, actionField, type Evidence, type Holder, type Step, type StepAction, type Template, type TaskInput } from './workflow'
import { mayMerge } from './guards'
import { taskGuards } from './actions'
import { shotsMissing, shotsText, shotMode, type Shot } from './shots'
import { advise, blocking, weight, reviewText, sendBackText, type Advice, type Choice, type Finding, type Round } from './verdict'

// text: what the holder is told at the start. guarded: a merge only the user may do.
export interface PlannedStep extends Step { text: string, guarded?: true }

// Why the task is in Your turn, and the badge that says what to do. After N
// send-backs, the engine's advice comes with it.
// error: what the failed engine action said (reason 'action').
export interface YourTurn { reason: 'user' | 'timeout' | 'rounds' | 'action', badge: string, advice?: Advice, error?: string }

// Work handed to the worker (a catch-up, red CI, a coordinator's fix): the
// step's Your turn (`was`) waits until the PR head moves from `head` or the
// worker reports. A failed action is then tried again (release.ts retriesAction);
// idle: since when its agent sits idle, its report not in (fixWatch).
// text: what the worker was told, to start it again with it; waits: why it cannot do it now (release.ts handedWatch);
// revived: when the engine started it again for it; told: who was told it waits (the coordinator's wake, else the user).
// waitsSince: since when it waits for that (a wait for room whose numbers change counts as the same).
export interface AgentWork { kind: string, head?: string, at: number, was?: YourTurn, idle?: number, text?: string, waits?: string, waitsSince?: number, revived?: number, told?: 'coordinator' | 'user' }

export interface StepState {
  at: number // index of the current step
  started: boolean
  since?: number // when the current step started
  deadline?: number // absolute time, from the step's timeout
  paused?: number // since when the step's clock is stopped: its holder cannot work (pauseClock)
  recheckAt?: number // absolute time, for a step with recheck
  rechecks?: number // rechecks sent with no news since: each one doubles the next interval (recheckEvery)
  news?: News // the task's news as the last tick saw it (recheckNews)
  waitUser?: number // since when rechecks wait for the user (step wait --until-user)
  told?: number // the `since` of the step whose instructions were delivered to its holder
  fix?: string // what the worker must fix, when an engine action sent the task back to it
  rereview?: Rereview // the PR head moved after the review: only that change is reviewed again
  acting?: boolean // an engine action is running
  watch?: { from: number, next: number } // pipeline.watch or a merge waiting for CI: since when, and its next look
  notify?: string // for the coordinator, once: what a watched pipeline said when it failed
  yourTurn?: YourTurn
  agent?: AgentWork
  proofs: Record<string, Partial<Record<Evidence, string>>> // per step id
  shots?: Record<string, Shot[]> // the screenshots uploaded per step id (shots.ts)
  earlierShots?: Record<string, Shot[]> // the sets a rework after the review replaced, oldest first
  rounds: Record<string, number> // send-backs per verdict step id
  tries?: Record<string, number> // engine actions started per step id: one receipt each
  reviews?: Record<string, Round[]> // the send-backs of each verdict step
  minor?: Record<string, Finding[]> // what each verdict step's passing verdict left, all minor
  backFrom?: string // the verdict step that sent the task back last
  extra?: Record<string, true> // verdict steps that had their one extra round
  swapped?: Record<string, true> // verdict steps after which the agent was changed
  done?: boolean
  abandoned?: true
  approved?: Approval // the user accepted: it stays, the merge queue merges it once the PR is clean
  catchUp?: CatchUp // the PR conflicts with or is behind its base: being updated, one at a time
  caughtUp?: CaughtUp // updated with its base: not the user's turn until GitHub reads the PR clean (caughtUpSettled)
}

// The user's Accept, kept: who, when, at which reviewed commit.
export interface Approval { by: 'user', at: number, commit?: string }
// from: the task's commit when the catch-up started; base: the branch merged in.
export interface CatchUp { base: string, from: string, at: number }
// head: the commit pushed by a clean update with `base`, at `at`.
export interface CaughtUp { base: string, head: string, at: number }

// How long a PR just updated with its base may wait for GitHub's new read before it is the user's again.
export const SETTLE_MS = 3 * 60_000
// Its update settled: GitHub read the PR at the pushed commit with no conflict
// and no update it requires (pr: the engine's read, none on the board), or SETTLE_MS passed.
export const caughtUpSettled = (c: CaughtUp, pr: { headRefOid: string, mergeStateStatus?: string } | undefined, now: number) =>
  now - c.at >= SETTLE_MS || (!!pr && pr.headRefOid === c.head && !['DIRTY', 'BEHIND', 'UNKNOWN'].includes(pr.mergeStateStatus ?? ''))

// A merge step that waits for the user's click (a visual merge).
export const waitsToMerge = (step: Pick<Step, 'ends' | 'action'> | undefined) => step?.ends === 'user' && step.action?.kind === 'github.merge'

export type StepEvent =
  | { kind: 'start' }
  // disputes: ids of the findings the worker contests after a send-back.
  | { kind: 'report', from: Holder, evidence?: Partial<Record<Evidence, string>>, disputes?: string[] }
  // The reviewer's findings (parseFindings); diffLines: the task's diff size, measured by the server.
  // head: the commit the reviewer read, recorded as that step's commit.
  | { kind: 'verdict', from: Holder, findings: Finding[], diffLines?: number, head?: string }
  // The choice after N send-backs. The coordinator gives its reason, and only picks among the advice's options;
  // spec: a pass on a spec change its reason cites (checked by the server), even outside them.
  | { kind: 'decide', by: 'user' | 'coordinator', choice: Choice, note?: string, spec?: true }
  | { kind: 'user', engine?: true } // the step's button, or "it is merged" said by the user; engine: run again by the engine
  // toAgent: the worker has to fix it (a conflict): the task goes back to its step.
  // review: new commits since the reviewed one: back to the review step, for them only.
  // catchUp: the merge was refused because the PR conflicts with or is behind its base.
  // unapproved: the task's interface files changed since the user approved: they look again.
  // later: a watched pipeline still runs. detail: the tail of a failed one's output.
  | { kind: 'action-result', ok: boolean, later?: boolean, detail?: string, error?: string, evidence?: Partial<Record<Evidence, string>>, toAgent?: boolean, review?: Rereview, catchUp?: { base: string, head: string }, unapproved?: true }
  // A merge step waiting for the user: its PR is updated with its base (catch-up), then
  // caught up (head: the pushed commit; review: what the agent changed, else a clean merge).
  | { kind: 'catch-up', base: string, head: string }
  | { kind: 'caught-up', head?: string, review?: Rereview, error?: string }
  | { kind: 'tick' }
  | { kind: 'skip' } // the user takes a stopped task as it is: on to the next step
  | { kind: 'back', note: string } // the user sends a step of theirs (a visual merge) back to the worker, with what to change

export type Effect =
  | { kind: 'instruct', step: string, holder: Holder, text: string }
  | { kind: 'action', step: string, action: StepAction, attempt: number }
  | { kind: 'split', step: string, findings: Finding[] } // a new task for what is left
  | { kind: 'swap', step: string } // another agent takes the step over, same worktree
  | { kind: 'log', text: string } // a line of the task's journal
  | { kind: 'abandon' }
  | { kind: 'done' }

// since: the commit the review passed; head: the task's commit now.
export interface Rereview { since: string, head: string }

// The commit the last review before the current step passed, if it recorded one.
export function reviewedCommit(plan: PlannedStep[], s: StepState): string | undefined {
  const r = plan.slice(0, s.at).findLast(p => p.ends === 'verdict')
  return r && s.proofs[r.id]?.commit
}

// The commit the review passed, when the task's head has moved since: the
// worker reworked the task after its review (the merge step sends it back to review).
export function reworkSince(plan: PlannedStep[], s: StepState, head?: string): string | undefined {
  const since = s.rereview?.since ?? reviewedCommit(plan, s)
  return since && head && head !== since ? since : undefined
}

// The reviewer's text for a short re-review of what came after its pass.
export const rereviewText = ({ since, head }: Rereview) => [
  `Short re-review: the PR head moved after your review passed (${since.slice(0, 7)} → ${head.slice(0, 7)}), through a catch-up merge, a conflict resolution or a CI fix.`,
  `Review only that change. List it with \`git log --oneline ${since}..${head}\`. For a merge of the base branch, \`git show --remerge-diff <commit>\` shows only how its conflicts were resolved; for any other commit, \`git show <commit>\`.`,
  'Pass unless one of them breaks the task or goes beyond it; what the base branch brought is not reviewed again.',
].join('\n\n')

export interface StepResult { state: StepState, effects: Effect[], refused?: string }

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
// A merge's wait for its checks or GitHub's lag, rechecked by the engine's passes (never a sleep in a tick).
export const MERGE_WAIT = { every: 30_000, timeout: 15 * 60_000 }
const MERGE_KINDS = new Set(['github.merge', 'bitbucket.merge'])
export const durationMs = (d: string) => Number(d.slice(0, -1)) * UNIT[d.slice(-1) as keyof typeof UNIT]

const PROOF: Record<Exclude<Evidence, 'screenshots'>, string> = { link: 'a link', commit: 'the commit', report: 'your report', 'proposed-tasks': 'the proposed tasks' }
const SHOT_HOW = 'Upload each screenshot with the command under "Screenshots" in your instructions file.'
const proofOf = (s: Step) => (e: Evidence) =>
  e === 'screenshots' ? shotsText(shotMode(s) === 'before-after' ? ['before', 'after'] : ['after']) : PROOF[e]
export const DEFAULT_ROUNDS = 2

// The project's working branch (Project.base) fills the branch an action
// leaves out: the PR's base, the branch to land on or to check. A step that
// names its own keeps it. Neither: the action stays without one.
export function withBase(a: StepAction, base?: string): StepAction {
  const f = actionField(a.kind)
  return f && !a[f] && base ? { ...a, [f]: base } : a
}

// {base} in instructions: the working branch, or plain words when none is set.
export const fillBase = (text: string, base?: string) => text.replaceAll('{base}', base || 'the base branch')

// The Git host of a link, named for people.
export function gitHost(url?: string): string {
  const h = (url && /^https?:\/\/([^/]+)/i.exec(url)?.[1]?.toLowerCase()) || ''
  return h.includes('github') ? 'GitHub' : h.includes('bitbucket') ? 'Bitbucket' : h.includes('gitlab') ? 'GitLab' : /dev\.azure\.com|visualstudio\.com/.test(h) ? 'Azure DevOps' : 'your Git host'
}

// The link the latest earlier step gave as its proof: the PR.
export const proofLink = (plan: Step[], s: Pick<StepState, 'at' | 'proofs'>) =>
  plan.slice(0, s.at).map(p => s.proofs[p.id]?.link).findLast(Boolean)

// A step's badge and button. A step you end with git.verify-merged only
// checks: you merge on the host, then say so. A workflow's own text wins.
export function stepLabels(step: Step, link?: string): { badge: string, button: string } {
  const verify = step.ends === 'user' && step.action?.kind === 'git.verify-merged'
  // A merge the user approves: they accept the work, the engine merges it.
  const label = waitsToMerge(step) && (!step.userLabel || step.userLabel === 'Merge') ? 'Accept' : step.userLabel
  return {
    badge: step.badge || (verify ? `Merge the PR on ${gitHost(link)}` : label || step.id),
    button: label || (verify ? 'I merged it' : 'Done'),
  }
}

// What a failed action says in the badge. git.verify-merged that finds the
// commit not in its target yet says what to do next, with the PR link.
function failureText(step: Step, error: string | undefined, link?: string): string {
  const l = stepLabels(step, link)
  const m = step.action?.kind === 'git.verify-merged' && error?.match(/^verify-merged: commit \S+ is not in \S+(.*)$/)
  if (!m) return `${l.badge}: ${error || `${step.action!.kind} failed`}`
  const pr = link ? ` (${link})` : ''
  return `The PR is not merged into ${step.action!.target} yet: merge it on ${gitHost(link)}${pr}, then press “${l.button}” again${m[1]}`
}

// The steps of a task type, shared steps resolved, each with the text its
// holder gets: every level's instructions, broadest first, then the proofs.
// base: the project's working branch (withBase, fillBase).
export function planSteps(t: Template, input: TaskInput, base?: string): PlannedStep[] {
  const tt = t.taskTypes[input.type]
  if (!tt) return []
  const g = taskGuards(t, input.type)
  let prBase: string | undefined // of the PR opened by an earlier step
  return tt.steps.map(s => (typeof s === 'string' ? t.steps![s]! : s)).map((step) => {
    const s = step.action ? { ...step, action: withBase(step.action, base) } : step
    if (s.action?.kind === 'github.pr') prBase = s.action.base
    const into = s.action?.kind === 'git.land' ? s.action.target : s.action?.kind === 'github.merge' ? prBase : undefined
    const guarded = into !== undefined && !mayMerge(g, into, 'engine') ? { guarded: true as const } : {}
    const own = input.steps?.[s.id]
    const parts = [t.instructions, tt.instructions, input.instructions, s.instructions, own?.instructions].map(x => x?.trim()).filter(Boolean)
    if (s.evidence?.length) parts.push(`Before you say you are done, give ${s.evidence.map(proofOf(s)).join(', ')}.`)
    if (s.evidence?.includes('screenshots')) parts.push(SHOT_HOW)
    return { ...s, ...(own?.timeout ? { timeout: own.timeout } : {}), ...guarded, text: fillBase(parts.join('\n\n'), base) }
  })
}

export const initialState = (): StepState => ({ at: 0, started: false, proofs: {}, rounds: {} })
export const currentStep = (plan: PlannedStep[], s: StepState): PlannedStep | undefined => plan[s.at]
const hasAgent = (s: Step) => !!s.holder && s.holder !== 'none'

function act(s: StepState, step: PlannedStep, effects: Effect[], now: number): StepState {
  const attempt = (s.tries?.[step.id] ?? 0) + 1
  effects.push({ kind: 'action', step: step.id, action: step.action!, attempt })
  // A new attempt waits afresh: a merge's earlier wait for CI counts no more.
  const watch = { watch: step.action!.kind === 'pipeline.watch' ? { from: now, next: now } : undefined }
  return { ...s, acting: true, yourTurn: undefined, ...watch, tries: { ...s.tries, [step.id]: attempt } }
}

// Enters step i: a step with no end is passed through (the last one is done).
function enter(plan: PlannedStep[], prev: StepState, i: number, now: number, effects: Effect[]): StepState {
  const step = plan[i]
  const s: StepState = { ...prev, at: Math.min(i, plan.length - 1), started: true, since: now, deadline: undefined, paused: undefined, recheckAt: undefined, rechecks: undefined, news: undefined, waitUser: undefined, acting: undefined, watch: undefined, yourTurn: undefined, agent: undefined, fix: undefined, rereview: undefined, catchUp: undefined, caughtUp: undefined }
  if (!step) return effects.push({ kind: 'done' }), { ...s, done: true }
  if (!step.ends) return i === plan.length - 1 ? (effects.push({ kind: 'done' }), { ...s, done: true }) : enter(plan, s, i + 1, now, effects)
  if (step.timeout) s.deadline = now + durationMs(step.timeout)
  if (step.recheck) s.recheckAt = now + durationMs(step.recheck)
  const text = step.ends === 'verdict' ? reviewText(step.text, s.reviews?.[step.id]?.at(-1)) : step.text
  if (hasAgent(step)) effects.push({ kind: 'instruct', step: step.id, holder: step.holder!, text })
  // An approved merge does not ask again: the engine merges it once the PR is ready.
  if (step.ends === 'user' && !(s.approved && waitsToMerge(step))) s.yourTurn = { reason: 'user', badge: stepLabels(step, proofLink(plan, s)).badge }
  return step.ends === 'action' ? act(s, step, effects, now) : s
}

// A workflow change: the task's step is found again by its id in the new plan.
// A step gone, the task enters the first step of the new plan it has not
// passed yet, as if it reached it (its action runs, its holder is told).
// undefined: nothing moves.
export function replan(before: PlannedStep[], after: PlannedStep[], s: StepState, now: number): { state: StepState, from: string, to: string } | undefined {
  const cur = s.started && !s.done ? before[s.at] : undefined
  if (!cur) return
  const kept = after.findIndex(p => p.id === cur.id)
  if (kept >= 0) return kept === s.at ? undefined : { state: { ...s, at: kept }, from: cur.id, to: cur.id }
  const passed = before.slice(0, s.at).map(p => p.id)
  const i = after.findIndex(p => !passed.includes(p.id))
  const state = enter(after, s, i < 0 ? after.length : i, now, [])
  return { state, from: cur.id, to: after[state.at]!.id }
}

// A stopped task taken up again at an action step: its action runs again, a new attempt.
export function actAgain(plan: PlannedStep[], s: StepState, now: number): StepState {
  const step = s.started && !s.done && !s.acting ? plan[s.at] : undefined
  return step?.ends === 'action' ? act(s, step, [], now) : s
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
      if (ev.head) state = { ...state, proofs: { ...state.proofs, [step.id]: { ...state.proofs[step.id], commit: ev.head } } }
      // The engine decides: only a finding that weighs major or more sends back.
      const left = blocking(ev.findings)
      if (!left.length) {
        state = { ...state, minor: { ...state.minor, [step.id]: ev.findings } }
        return next()
      }
      const n = (state.rounds[step.id] ?? 0) + 1
      const rounds = { ...state.rounds, [step.id]: n }
      const history = [...(state.reviews?.[step.id] ?? []), { findings: left, ...(ev.diffLines !== undefined ? { diffLines: ev.diffLines } : {}), ...(ev.head ? { head: ev.head } : {}) }]
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
      // A pass on a spec change only ends the review loop: a guarded merge stays the user's.
      const onSpec = ev.by === 'coordinator' && ev.spec && ev.choice === 'pass' && !advice.options.includes('pass')
      if (onSpec && plan[state.at + 1]?.guarded) return refuse('The next step is a merge only the user may do: this one is for the user')
      // Nor does it lift the critical guard: a critical finding with proof stays the user's.
      if (onSpec && state.reviews?.[step.id]?.at(-1)?.findings.some(f => weight(f) === 'critical')) return refuse('A critical finding with proof is for the user')
      if (ev.by === 'coordinator' && !advice.options.includes(ev.choice) && !onSpec)
        return refuse(advice.options.length ? `The coordinator may only choose ${advice.options.join(' or ')}` : 'This one is for the user')
      if (ev.by === 'coordinator' && !ev.note?.trim()) return refuse('Give the reason of the choice')
      if (ev.choice === 'swap' && state.swapped?.[step.id]) return refuse('The agent was already changed once')
      effects.push({ kind: 'log', text: `${step.id}: ${ev.by} chose ${ev.choice}${onSpec ? ' on a spec change' : ''} (advice: ${advice.outcome}, ${advice.why})${ev.note?.trim() ? `. ${ev.note.trim()}` : ''}` })
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
      state = { ...state, caughtUp: undefined }
      // Accept is an approval that stays, at the reviewed commit, whatever the PR's state
      // (a conflict, behind, checks running or red, its worker ended): the task leaves
      // Your turn and the merge queue merges it in its own order once the PR is ready.
      if (waitsToMerge(step) && !state.approved && !ev.engine) {
        const commit = reviewedCommit(plan, state)
        // Work handed to its worker meanwhile no longer brings the user's turn back when it is in.
        const { was: _, ...agent } = state.agent ?? {} as AgentWork
        const handed = state.agent ? { agent: state.agent.was?.reason === 'user' ? agent : state.agent } : {}
        return { state: { ...state, ...handed, yourTurn: undefined, approved: { by: 'user', at: now, ...(commit ? { commit } : {}) } }, effects }
      }
      // Updating with its base already: it merges once that is done.
      if (state.catchUp) return { state, effects }
      if (!step.action) return next()
      return { state: act(state, step, effects, now), effects }
    }
    case 'action-result': {
      if (!state.acting) return refuse('No action is running')
      let { error, toAgent } = ev
      const w = step.action?.kind === 'pipeline.watch' ? step.action : undefined
      if (w && ev.later) {
        // Still running: polled again after `every`, until `timeout`, which goes to you.
        const from = state.watch?.from ?? now, limit = w.timeout ?? WATCH.timeout
        if (now - from < durationMs(limit)) return { state: { ...state, watch: { from, next: now + durationMs(w.every ?? WATCH.every) } }, effects }
        error = `pipeline: still running after ${limit}`
      }
      // A merge waiting for its checks or for GitHub to show a push: a later pass checks again, up to MERGE_WAIT.
      else if (ev.later && MERGE_KINDS.has(step.action?.kind ?? '')) {
        const from = state.watch?.from ?? now
        if (now - from < MERGE_WAIT.timeout) return { state: { ...state, watch: { from, next: now + MERGE_WAIT.every } }, effects }
        error = `${error ?? 'merge: still waiting'} after ${Math.round(MERGE_WAIT.timeout / 60_000)} min`
      }
      else if (ev.later) return { state, effects }
      const proofs = ev.evidence ? { ...state.proofs, [step.id]: { ...state.proofs[step.id], ...ev.evidence } } : state.proofs
      if (ev.ok) return { state: enter(plan, { ...state, proofs }, state.at + 1, now, effects), effects }
      // The approval covered the screens the user saw: the interface changed since, so they look again.
      if (ev.unapproved && waitsToMerge(step)) {
        effects.push({ kind: 'log', text: `${step.id}: approval dropped, the interface changed since: the user looks again` })
        return { state: { ...state, proofs, acting: undefined, approved: undefined, yourTurn: { reason: 'user', badge: 'Look again, then merge: the interface changed' } }, effects }
      }
      if (ev.catchUp && waitsToMerge(step)) {
        effects.push({ kind: 'log', text: `${step.id}: ${ev.error ?? 'refused'}: updating it with ${ev.catchUp.base}${state.approved ? ', then it merges by itself' : ''}` })
        return { state: { ...state, proofs, acting: undefined, yourTurn: undefined, caughtUp: undefined, catchUp: { base: ev.catchUp.base, from: ev.catchUp.head, at: now } }, effects }
      }
      if (w) {
        // Failed: said once in the log and to the coordinator; back to the worker if the step says so.
        const said = `${step.id}: ${error}${ev.detail ? `\n${ev.detail}` : ''}`
        effects.push({ kind: 'log', text: said })
        state = { ...state, watch: undefined, notify: said }
        toAgent = w.onFail === 'worker' && !ev.later
      }
      const review = ev.review ? plan.slice(0, state.at).findLastIndex(p => p.ends === 'verdict') : -1
      if (review >= 0) {
        effects.push({ kind: 'log', text: `${step.id}: ${ev.error ?? 'new commits'}, back to ${plan[review]!.id}` })
        return { state: { ...enter(plan, { ...state, proofs }, review, now, []), rereview: ev.review }, effects }
      }
      const back = plan.slice(0, state.at).findLastIndex(p => p.holder === 'worker')
      if (toAgent && back >= 0) {
        // One message: what to fix, not the step's text again.
        const fix = `${error}.${w && ev.detail ? `\n\n${ev.detail}\n\n` : ' '}Fix it, commit, then say you are done.`
        effects.push({ kind: 'instruct', step: plan[back]!.id, holder: 'worker', text: fix })
        return { state: { ...enter(plan, { ...state, proofs }, back, now, []), fix }, effects }
      }
      // The step stays open; the badge says what went wrong.
      const badge = failureText(step, error, proofLink(plan, state))
      return { state: { ...state, acting: undefined, watch: undefined, yourTurn: { reason: 'action', badge, ...(error ? { error } : {}) } }, effects }
    }
    case 'back': {
      const back = plan.slice(0, state.at).findLastIndex(p => p.holder === 'worker')
      if (step.ends !== 'user' || state.acting) return refuse(`Step "${step.id}" does not wait for you`)
      if (back < 0) return refuse('No earlier step of the agent to send it back to')
      if (!ev.note.trim()) return refuse('Say what to change')
      const fix = `The user sent it back from "${step.id}": ${ev.note.trim()}\nFix it, commit, then say you are done.`
      effects.push({ kind: 'instruct', step: plan[back]!.id, holder: 'worker', text: fix }, { kind: 'log', text: `${step.id}: sent back by the user${state.approved ? ', approval dropped' : ''}. ${ev.note.trim()}` })
      // The screens sent back are dropped: the worker gives new ones, and the merge shows only those.
      const { [plan[back]!.id]: _sentBack, ...shots } = state.shots ?? {}
      // The reworked task waits for the user's look again: an earlier Merge click no longer counts.
      return { state: { ...enter(plan, { ...state, shots, approved: undefined }, back, now, []), fix }, effects }
    }
    case 'catch-up': {
      if (!waitsToMerge(step) || state.acting || state.catchUp) return refuse('No merge waits to be updated')
      effects.push({ kind: 'log', text: `${step.id}: the PR conflicts with or is behind ${ev.base}: updating it` })
      return { state: { ...state, yourTurn: undefined, caughtUp: undefined, catchUp: { base: ev.base, from: ev.head, at: now } }, effects }
    }
    case 'caught-up': {
      const c = state.catchUp
      if (!c) return refuse('No catch-up runs')
      const done = { ...state, catchUp: undefined }
      if (ev.error) return { state: { ...done, yourTurn: { reason: 'action', badge: `${stepLabels(step, proofLink(plan, state)).badge}: ${ev.error}`, error: ev.error } }, effects }
      // The agent resolved conflicts: that change only is reviewed again.
      const review = ev.review ? plan.slice(0, state.at).findLastIndex(p => p.ends === 'verdict') : -1
      if (review >= 0) {
        effects.push({ kind: 'log', text: `${step.id}: updated with ${c.base}, back to ${plan[review]!.id} for the conflict resolution` })
        return { state: { ...enter(plan, done, review, now, []), rereview: ev.review }, effects }
      }
      // A clean merge of the base: nothing new to review, the reviewed commit moves with it.
      const r = plan.slice(0, state.at).findLast(p => p.ends === 'verdict')
      const proofs = r && ev.head && state.proofs[r.id]?.commit === c.from ? { ...state.proofs, [r.id]: { ...state.proofs[r.id], commit: ev.head } } : state.proofs
      effects.push({ kind: 'log', text: `${step.id}: updated with ${c.base}${state.approved ? ', merges once ready' : ''}` })
      const yourTurn = state.approved ? undefined : { reason: 'user' as const, badge: stepLabels(step, proofLink(plan, state)).badge }
      // Not the user's turn yet: GitHub still reads the old commit's conflict until it checks the new one.
      return { state: { ...done, proofs, yourTurn, ...(ev.head ? { caughtUp: { base: c.base, head: ev.head, at: now } } : {}) }, effects }
    }
    case 'skip': return { state: enter(plan, { ...state, backFrom: undefined }, state.at + 1, now, effects), effects }
    case 'tick': {
      let s = state
      if (s.recheckAt !== undefined && now >= s.recheckAt && hasAgent(step)) {
        effects.push({ kind: 'instruct', step: step.id, holder: step.holder!, text: `Check again: ${step.text}` })
        const n = (s.rechecks ?? 0) + 1
        s = { ...s, rechecks: n, recheckAt: now + recheckEvery(step.recheck!, n) }
      }
      if (s.deadline !== undefined && s.paused === undefined && now >= s.deadline && !s.yourTurn)
        s = { ...s, yourTurn: { reason: 'timeout', badge: `Check ${step.id}: over ${step.timeout}` } }
      return { state: s, effects }
    }
  }
}

// A recheck interval after n rechecks with no news: the step's own, doubled
// each time, up to an hour (a step's own longer interval stays).
export const RECHECK_CAP = 3_600_000
export const recheckEvery = (recheck: string, n: number) => {
  const base = durationMs(recheck)
  return Math.max(base, Math.min(base * 2 ** n, RECHECK_CAP))
}

// What counts as news on a task: its newest log entry (a commit, a tell, a
// report, the user's button…), the user's last message to the coordinator,
// and its CI as last read. user: the user's last message or action alone.
export interface News { at: number, user?: number, ci?: string }

// News since the last tick: the rechecks start over from the step's own
// interval. A wait for the user ends only on the user's own message or action.
// The first look only notes it.
export function recheckNews(plan: PlannedStep[], s: StepState, news: News, now: number): StepState {
  if (!s.started || s.done) return s
  const step = currentStep(plan, s)
  if (!step?.recheck) return s
  const seen = s.news
  if (seen && news.at <= seen.at && news.ci === seen.ci) return s
  if (!seen) return { ...s, news }
  if (s.waitUser !== undefined && !((news.user ?? 0) > s.waitUser)) return { ...s, news }
  return { ...s, news, rechecks: 0, waitUser: undefined, recheckAt: now + durationMs(step.recheck) }
}

export const WAIT_MAX = 86_400_000
// The coordinator postpones its next recheck (`step wait`): `ms` sets it, or
// none until the user writes or acts on the task (recheckNews ends it).
export function waitStep(plan: PlannedStep[], s: StepState, wait: { ms: number } | { untilUser: true }, now: number): { state: StepState } | { refused: string } {
  const step = currentStep(plan, s)
  if (!s.started || s.done || !step) return { refused: 'The task has no step running' }
  if (step.holder !== 'coordinator' || !step.recheck) return { refused: `Step "${step.id}" is not one you hold with a recheck` }
  if ('ms' in wait) {
    if (!(wait.ms > 0 && wait.ms <= WAIT_MAX)) return { refused: '--for is a duration up to 1d' }
    return { state: { ...s, waitUser: undefined, recheckAt: now + wait.ms } }
  }
  return { state: { ...s, waitUser: now, recheckAt: undefined } }
}

// When the step's next recheck is due, for its sheet: a time, or 'user' while
// it waits for the user; undefined: none.
export const nextRecheck = (s: StepState | undefined): number | 'user' | undefined =>
  !s?.started || s.done ? undefined : s.waitUser !== undefined ? 'user' : s.recheckAt

// The step's clock stops while its holder cannot work (its machine offline or
// unreachable, an incident not over, the task waiting for room): that time
// does not count toward its timeout. Stopped, a timeout already in Your turn
// goes (the card shows what the task waits for); started again, the deadline
// moves by the time stopped. `since` stays: the card shows the real time in step.
export function pauseClock(s: StepState, stopped: boolean, now: number): StepState {
  if (!s.started || s.done) return s
  if (stopped) {
    const yourTurn = s.yourTurn?.reason === 'timeout' ? undefined : s.yourTurn
    return s.paused !== undefined && yourTurn === s.yourTurn ? s : { ...s, paused: s.paused ?? now, yourTurn }
  }
  if (s.paused === undefined) return s
  return { ...s, paused: undefined, ...(s.deadline !== undefined ? { deadline: s.deadline + Math.max(0, now - s.paused) } : {}) }
}
