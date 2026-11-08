import { describe, expect, it } from 'vitest'
import { EXAMPLES, common, company, github, vibe, wherdr } from '../shared/pm/examples'
import { currentStep, initialState, onEvent, planSteps, withBase, type Effect, type StepEvent, type StepState } from '../shared/pm/steps'
import { validateTemplate, type Template } from '../shared/pm/workflow'
import type { Finding } from '../shared/pm/verdict'
import { taskBase } from '../shared/pm/run'
import { guardAction } from '../shared/pm/actions'
import { combineGuards } from '../shared/pm/guards'

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

  it('wherdr: the engine squash-merges into v3 after review; a visual change waits for the user; a study opens no PR', () => {
    const plan = (type: string) => planSteps(wherdr, { type })
    expect(plan('simple').map(s => s.id)).toEqual(['todo', 'work', 'pr', 'review', 'merge', 'done'])
    expect(plan('simple')[4]).toMatchObject({ action: { kind: 'github.merge', method: 'squash', checks: ['smoke'] } })
    expect(plan('simple')[4].guarded).toBeUndefined()
    expect(plan('simple')[3]).toMatchObject({ rounds: 3, sendBack: 'work' })
    expect(plan('visual')[4]).toMatchObject({ ends: 'user', userLabel: 'Merge' })
    expect(plan('visual')[1].evidence).toEqual(['screenshots'])
    expect(plan('study').some(s => s.action)).toBe(false)
    // develop and main stay the user's, whatever the template's merge step.
    const toDevelop = { ...wherdr, steps: { ...wherdr.steps, pr: { ...wherdr.steps!.pr!, action: { kind: 'github.pr' as const, base: 'develop' } } } }
    expect(planSteps(toDevelop, { type: 'simple' })[4].guarded).toBe(true)
  })
})

describe('the user sends a visual merge back', () => {
  it('goes back to the work step with the note as what to fix; refused with no note or off a user step', () => {
    const plan = planSteps(wherdr, { type: 'visual' })
    const merge: StepState = { ...initialState(), started: true, at: 4, yourTurn: { reason: 'user', badge: 'Look at the screenshots, then merge' }, shots: { work: [{ file: 'aaaaaaaaaaaa.png', phase: 'after', at: 1 }] } }
    const r = onEvent(plan, merge, { kind: 'back', note: 'The button is cut on the phone' }, 0)
    expect(r.state).toMatchObject({ at: 1, yourTurn: undefined, fix: expect.stringContaining('The button is cut on the phone') })
    // The screens sent back are dropped: the work step needs new ones before it can report.
    expect(r.state.shots?.work).toBeUndefined()
    expect(onEvent(plan, r.state, { kind: 'report', from: 'worker' }, 1).refused).toMatch(/screenshot/i)
    expect(r.effects).toMatchObject([{ kind: 'instruct', step: 'work', holder: 'worker' }, { kind: 'log' }])
    expect(onEvent(plan, merge, { kind: 'back', note: ' ' }, 0).refused).toBe('Say what to change')
    expect(onEvent(plan, { ...merge, at: 3 }, { kind: 'back', note: 'x' }, 0).refused).toContain('does not wait for you')
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
    expect(r.state.yourTurn).toEqual({ reason: 'action', badge: 'land: conflict in app.vue', error: 'conflict in app.vue' })
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
    expect(r.state.yourTurn).toEqual({ reason: 'action', badge: 'Merge the PR: commit not in develop', error: 'commit not in develop' })
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

describe('working branch', () => {
  it('fills the branch a step leaves out: its own first, then the project\'s, else none', () => {
    expect(withBase({ kind: 'github.pr', base: 'next' }, 'v3')).toEqual({ kind: 'github.pr', base: 'next' })
    expect(withBase({ kind: 'github.pr' }, 'v3')).toEqual({ kind: 'github.pr', base: 'v3' })
    expect(withBase({ kind: 'git.land' }, 'v3')).toEqual({ kind: 'git.land', target: 'v3' })
    expect(withBase({ kind: 'git.push' }, 'v3')).toEqual({ kind: 'git.push' })
    expect(withBase({ kind: 'github.pr' })).toEqual({ kind: 'github.pr' })
    expect(guardAction(combineGuards([]), { kind: 'github.pr' }, { branch: 'task/X-1', by: 'engine' })).toMatch(/has no branch/)
  })

  it('reaches the plan, the merge guard and {base} in the instructions', () => {
    const t: Template = { ...github, instructions: 'Merge origin/{base} first.', taskTypes: { simple: { steps: github.taskTypes.simple!.steps.map(s => (typeof s !== 'string' && s.id === 'pr' ? { ...s, action: { kind: 'github.pr' as const } } : s)) } } }
    const plan = planSteps(t, { type: 'simple' }, 'main')
    expect(plan.find(s => s.id === 'pr')?.action).toEqual({ kind: 'github.pr', base: 'main' })
    expect(plan.find(s => s.id === 'merge')?.guarded).toBe(true) // main is protected
    expect(plan.find(s => s.id === 'work')?.text).toMatch(/^Merge origin\/main first\./)
    expect(planSteps(t, { type: 'simple' }).find(s => s.id === 'work')?.text).toMatch(/^Merge origin\/the base branch first\./)
  })

  it('stays the one a task started with', () => {
    expect(taskBase({}, { base: 'v3' })).toBe('v3')
    expect(taskBase({ base: 'main' }, { base: 'v3' })).toBe('main')
    expect(taskBase({ base: '' }, { base: 'v3' })).toBeUndefined()
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
