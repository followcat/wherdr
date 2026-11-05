import { describe, expect, it } from 'vitest'
import { EXAMPLES, common, company, github, vibe } from '../shared/pm/examples'
import { currentStep, initialState, onEvent, planSteps, type Effect, type StepEvent, type StepState } from '../shared/pm/steps'
import { validateTemplate, type Template } from '../shared/pm/workflow'
import type { Finding } from '../shared/pm/verdict'

const MIN = 60_000
const bug: Finding = { id: 'bug', severity: 'major', title: 'Crashes on empty input', proof: 'npm test: 1 failed' }

// Plays a stream of [minute, event] and keeps what the board and the server would see.
function play(t: Template, type: string, events: [number, StepEvent][], input: { instructions?: string } = {}) {
  const plan = planSteps(t, { type, ...input })
  let state: StepState = initialState()
  const steps = [plan[0]!.id], effects: Effect[] = [], refused: string[] = []
  for (const [m, ev] of events) {
    const r = onEvent(plan, state, ev, m * MIN)
    state = r.state
    effects.push(...r.effects)
    if (r.refused) refused.push(r.refused)
    const id = currentStep(plan, state)!.id
    if (steps.at(-1) !== id) steps.push(id)
  }
  return { plan, state, steps, effects, refused }
}
const kinds = (effects: Effect[]) => effects.map(e => e.kind === 'done' ? 'done' : `${e.kind}:${e.step}`)

describe('example templates', () => {
  it('are valid templates', () => {
    for (const t of EXAMPLES) expect(validateTemplate(t), t.id).toEqual([])
  })
})

describe('step engine, vibe', () => {
  it('works, lands on dev and is done', () => {
    const r = play(vibe, 'simple', [
      [0, { kind: 'start' }],
      [5, { kind: 'report', from: 'worker' }],
      [6, { kind: 'action-result', ok: true }],
    ])
    expect(r.steps).toEqual(['todo', 'work', 'land', 'done'])
    expect(kinds(r.effects)).toEqual(['instruct:work', 'action:land', 'done'])
    expect(r.effects[1]).toMatchObject({ action: { kind: 'git.land', target: 'dev' } })
    expect(r.state.done).toBe(true)
  })

  it('sends the instructions of every level, broadest first, when a step starts', () => {
    const r = play(vibe, 'simple', [[0, { kind: 'start' }]], { instructions: 'Only touch the footer.' })
    expect(r.effects[0]).toEqual({ kind: 'instruct', step: 'work', holder: 'worker',
      text: 'Commit small, clear commits.\n\nOnly touch the footer.\n\nRun the quick check (npm run lint) before saying done.' })
  })

  it('a failed land puts the task in Your turn; the user tries again', () => {
    const r = play(vibe, 'simple', [
      [0, { kind: 'start' }], [5, { kind: 'report', from: 'worker' }],
      [6, { kind: 'action-result', ok: false, error: 'conflict in app.vue' }],
    ])
    expect(r.state.yourTurn).toEqual({ reason: 'action', badge: 'land: conflict in app.vue' })
    const again = onEvent(r.plan, r.state, { kind: 'user' }, 7 * MIN)
    expect(again.effects).toEqual([{ kind: 'action', step: 'land', action: { kind: 'git.land', target: 'dev' }, attempt: 2 }])
    expect(again.state.yourTurn).toBeUndefined()
  })
})

describe('step engine, company flow', () => {
  const toMerge: [number, StepEvent][] = [
    [0, { kind: 'start' }],
    [10, { kind: 'report', from: 'worker' }],
    [20, { kind: 'verdict', from: 'reviewer', findings: [bug] }],
    [30, { kind: 'report', from: 'worker' }],
    [40, { kind: 'verdict', from: 'reviewer', findings: [] }],
    [50, { kind: 'report', from: 'worker' }], // no link: refused
    [51, { kind: 'report', from: 'worker', evidence: { link: 'https://git.example/pr/7' } }],
  ]

  it('needs the PR link, then goes straight to Your turn with a badge for the manual merge', () => {
    const r = play(company, 'feature', toMerge)
    expect(r.steps).toEqual(['todo', 'work', 'review', 'work', 'review', 'pr', 'merge'])
    expect(r.refused).toEqual(['Not done yet: step "pr" needs a link.'])
    expect(r.state.proofs.pr).toEqual({ link: 'https://git.example/pr/7' })
    expect(r.state.rounds).toEqual({ review: 1 })
    expect(r.state.yourTurn).toEqual({ reason: 'user', badge: 'Merge the PR' })
    expect(kinds(r.effects)).toEqual(['instruct:work', 'instruct:review', 'instruct:work', 'instruct:review', 'instruct:pr', 'instruct:pr'])
    expect(r.effects[5]).toMatchObject({ text: 'Not done yet: step "pr" needs a link.' })
  })

  it('checks "Merged" in git; not merged keeps the step open in Your turn', () => {
    const r = play(company, 'feature', [...toMerge,
      [60, { kind: 'user' }],
      [61, { kind: 'action-result', ok: false, error: 'commit not in develop' }],
    ])
    expect(r.effects.at(-1)).toEqual({ kind: 'action', step: 'merge', action: { kind: 'git.verify-merged', target: 'develop' }, attempt: 1 })
    expect(currentStep(r.plan, r.state)!.id).toBe('merge')
    expect(r.state.yourTurn).toEqual({ reason: 'action', badge: 'Merge the PR: commit not in develop' })
  })

  it('the coordinator watches the deploy, is told again on recheck, and the timeout goes to Your turn', () => {
    const r = play(company, 'feature', [...toMerge,
      [60, { kind: 'user' }], [61, { kind: 'action-result', ok: true }],
      [64, { kind: 'tick' }], [66, { kind: 'tick' }], [151, { kind: 'tick' }],
    ])
    expect(r.steps.at(-1)).toBe('deploy')
    expect(kinds(r.effects).slice(-3)).toEqual(['instruct:deploy', 'instruct:deploy', 'instruct:deploy'])
    expect(r.effects.at(-1)).toMatchObject({ holder: 'coordinator', text: expect.stringMatching(/^Check again: /) })
    expect(r.state.yourTurn).toEqual({ reason: 'timeout', badge: 'Check deploy: over 90m' })
    const end = onEvent(r.plan, r.state, { kind: 'report', from: 'coordinator' }, 152 * MIN)
    expect(end.state).toMatchObject({ done: true, yourTurn: undefined })
  })

  it('takes a step\'s end only from its holder', () => {
    const r = play(company, 'feature', [
      [0, { kind: 'start' }],
      [1, { kind: 'verdict', from: 'reviewer', findings: [] }],
      [2, { kind: 'user' }],
      [3, { kind: 'report', from: 'reviewer' }],
    ])
    expect(r.steps).toEqual(['todo', 'work'])
    expect(r.refused).toEqual(['Step "work" does not end with a verdict', 'Step "work" does not wait for you', 'Step "work" is held by the worker'])
  })
})

describe('step engine, GitHub flow', () => {
  it('opens the PR, sends back twice, then the third failure goes to Your turn', () => {
    const fail: StepEvent = { kind: 'verdict', from: 'reviewer', findings: [bug] }
    const back: [number, StepEvent][] = [[0, { kind: 'report', from: 'worker' }], [0, { kind: 'action-result', ok: true }], [0, fail]]
    const r = play(github, 'simple', [[0, { kind: 'start' }], ...back, ...back, ...back])
    expect(r.steps).toEqual(['todo', 'work', 'pr', 'review', 'work', 'pr', 'review', 'work', 'pr', 'review'])
    expect(r.state.rounds).toEqual({ review: 3 })
    expect(r.state.yourTurn).toMatchObject({ reason: 'rounds', badge: 'Decide: review failed 3 times' })
    expect(r.effects.at(-1)).toMatchObject({ kind: 'instruct', step: 'review', holder: 'reviewer', text: expect.stringMatching(/^Code, commits and PR in English\.\nCheck only these findings/) })
  })

  it('merges after a passing review', () => {
    const r = play(github, 'simple', [
      [0, { kind: 'start' }], [1, { kind: 'report', from: 'worker' }], [2, { kind: 'action-result', ok: true }],
      [3, { kind: 'verdict', from: 'reviewer', findings: [] }], [4, { kind: 'action-result', ok: true }],
    ])
    expect(kinds(r.effects)).toEqual(['instruct:work', 'action:pr', 'instruct:review', 'action:merge', 'done'])
    expect(r.state.done).toBe(true)
    expect(onEvent(r.plan, r.state, { kind: 'tick' }, 5 * MIN).refused).toBe('The task is done')
  })
})

describe('step engine, study and feature split', () => {
  it('a study does not pass without its report', () => {
    const r = play(common, 'study', [[0, { kind: 'start' }], [5, { kind: 'report', from: 'worker', evidence: { report: '  ' } }]])
    expect(r.steps).toEqual(['todo', 'work'])
    expect(r.refused).toEqual(['Not done yet: step "work" needs your report.'])
    expect(r.effects[0]).toMatchObject({ text: expect.stringContaining('Before you say you are done, give your report.') })
    const ok = onEvent(r.plan, r.state, { kind: 'report', from: 'worker', evidence: { report: '/reports/1.md' } }, 6 * MIN)
    expect(ok.state.done).toBe(true)
  })

  it('a split starts at once, needs the proposed tasks, then waits for the user', () => {
    const r = play(common, 'feature-split', [
      [0, { kind: 'start' }],
      [5, { kind: 'report', from: 'worker', evidence: { 'proposed-tasks': '3 tasks' } }],
    ])
    expect(r.steps).toEqual(['split', 'pick'])
    expect(r.state.yourTurn).toEqual({ reason: 'user', badge: 'Create these tasks' })
    expect(onEvent(r.plan, r.state, { kind: 'user' }, 6 * MIN).state.done).toBe(true)
  })

  it('a task\'s own timeout sends the step to Your turn once it is due', () => {
    const plan = planSteps(common, { type: 'study', steps: { work: { timeout: '1h' } } })
    const s = onEvent(plan, initialState(), { kind: 'start' }, 0).state
    expect(onEvent(plan, s, { kind: 'tick' }, 59 * MIN).state.yourTurn).toBeUndefined()
    expect(onEvent(plan, s, { kind: 'tick' }, 60 * MIN).state.yourTurn).toEqual({ reason: 'timeout', badge: 'Check work: over 1h' })
  })
})
