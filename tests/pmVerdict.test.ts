import { describe, expect, it } from 'vitest'
import { company, github } from '../shared/pm/examples'
import { reviewSwitch, reviewerPlan, type Task } from '../shared/pm/run'
import { initialState, onEvent, planSteps, type Effect, type StepEvent, type StepState } from '../shared/pm/steps'
import { advise, blocking, parseFindings, weight, type Finding, type Round } from '../shared/pm/verdict'
import { validateTemplate, type Template } from '../shared/pm/workflow'
import { accountOut } from '../shared/pm/pace'

const f = (id: string, severity: Finding['severity'], more: Partial<Finding> = {}): Finding => ({ id, severity, title: `${id} title`, proof: `${id} proof`, ...more })
const round = (findings: Finding[], more: Partial<Round> = {}): Round => ({ findings, ...more })

describe('findings', () => {
  it('reads the last JSON block of the reviewer\'s answer and checks it', () => {
    const text = 'Looked at it.\n{"findings":[{"id":"nul","severity":"major","title":" Crash ","proof":"npm test","outOfScope":true},{"severity":"minor","title":"Typo","where":""}]}'
    expect(parseFindings(text)).toEqual([
      { id: 'nul', severity: 'major', title: 'Crash', proof: 'npm test', outOfScope: true },
      { id: 'f2', severity: 'minor', title: 'Typo' },
    ])
    expect(parseFindings('{"findings":[]}')).toEqual([])
    expect(parseFindings('LGTM')).toEqual({ error: 'The verdict is not valid JSON' })
    expect(parseFindings('{"findings":[{"severity":"huge","title":"x"}]}')).toEqual({ error: 'findings[0].severity must be one of minor, major, critical' })
  })

  it('weighs a finding without proof one level down, a preexisting one as minor', () => {
    expect(weight(f('a', 'critical'))).toBe('critical')
    expect(weight(f('a', 'critical', { proof: '' }))).toBe('major')
    expect(weight(f('a', 'major', { proof: undefined }))).toBe('minor')
    expect(weight(f('a', 'critical', { preexisting: true }))).toBe('minor')
    expect(blocking([f('a', 'minor'), f('b', 'major'), f('c', 'major', { proof: ' ' })]).map(x => x.id)).toEqual(['b'])
  })
})

// One test per row of the after-N table (design §3), in its order.
describe('after N send-backs: the advice', () => {
  const a = f('a', 'major'), b = f('b', 'major')

  it('nothing above minor: pass', () => {
    expect(advise({ rounds: [round([a]), round([a]), round([f('c', 'major', { proof: undefined })])] }))
      .toMatchObject({ outcome: 'pass', options: ['pass'] })
  })

  it('a new major with proof: one more round limited to it, or split; after that round, split', () => {
    const rounds = [round([a]), round([a]), round([a, b])]
    expect(advise({ rounds })).toMatchObject({ outcome: 'round', options: ['round', 'split'], findings: ['b'] })
    expect(advise({ rounds, extraUsed: true })).toMatchObject({ outcome: 'split', options: ['split'], findings: ['b'] })
  })

  it('the same finding sent back twice and contested by the agent: arbitrate', () => {
    const r = advise({ rounds: [round([a]), round([a], { disputed: ['a'] }), round([a])] })
    expect(r).toMatchObject({ outcome: 'arbitrate', options: ['worker', 'reviewer'], findings: ['a'] })
  })

  it('the work is right but what is left is out of scope: split', () => {
    const r = advise({ rounds: [round([a]), round([b]), round([f('x', 'major', { outOfScope: true })])] })
    expect(r).toMatchObject({ outcome: 'split', options: ['split'], findings: ['x'] })
  })

  it('a critical with proof, or a guarded next step: Your turn, the coordinator never passes', () => {
    const contested = [round([a]), round([a], { disputed: ['a'] })]
    expect(advise({ rounds: [...contested, round([a, f('k', 'critical')])] })).toMatchObject({ outcome: 'your-turn', options: [], findings: ['k'] })
    expect(advise({ rounds: [round([a]), round([a]), round([b])], nextGuarded: true })).toMatchObject({ outcome: 'your-turn', options: [] })
  })

  it('the agent goes round in circles: change agent or abandon, once', () => {
    const rounds = [round([a]), round([a, b], { diffLines: 120 }), round([a, b], { diffLines: 300 })]
    expect(advise({ rounds })).toMatchObject({ outcome: 'swap', options: ['swap', 'abandon'] })
    expect(advise({ rounds, swapped: true })).toMatchObject({ outcome: 'swap', options: ['abandon'] })
    // Same findings but the diff did not grow: not a loop, it goes to the user.
    expect(advise({ rounds: [round([a]), round([a], { diffLines: 300 }), round([a], { diffLines: 280 })] })).toMatchObject({ outcome: 'your-turn' })
  })
})

describe('verdict steps in the engine', () => {
  const MIN = 60_000
  function play(t: Template, type: string, events: StepEvent[]) {
    const plan = planSteps(t, { type })
    let state: StepState = initialState()
    const effects: Effect[] = [], refused: string[] = []
    events.forEach((ev, i) => {
      const r = onEvent(plan, state, ev, i * MIN)
      state = r.state
      effects.push(...r.effects)
      if (r.refused) refused.push(r.refused)
    })
    return { plan, state, effects, refused, at: () => plan[state.at]!.id }
  }
  const bug = f('bug', 'major'), typo = f('typo', 'minor')
  const verdict = (...findings: Finding[]): StepEvent => ({ kind: 'verdict', from: 'reviewer', findings })
  const report: StepEvent = { kind: 'report', from: 'worker' }

  it('the engine decides: minor findings pass, a proven major sends back with what to fix', () => {
    expect(play(company, 'feature', [{ kind: 'start' }, report, verdict(typo)]).at()).toBe('pr')
    const r = play(company, 'feature', [{ kind: 'start' }, report, verdict(bug, typo)])
    expect(r.at()).toBe('work')
    expect(r.effects.at(-1)).toEqual({ kind: 'instruct', step: 'work', holder: 'worker',
      text: 'Step "review" sent it back:\n- bug [major] bug title: bug proof\nFix them, commit, then say you are done. If you contest one, say so with its id.' })
  })

  it('round 2: the reviewer checks only the last findings and hears what the worker contests', () => {
    const r = play(company, 'feature', [{ kind: 'start' }, report, verdict(bug), { ...report, disputes: ['bug'] }])
    expect(r.state.reviews?.review).toEqual([{ findings: [bug], disputed: ['bug'] }])
    expect(r.effects.at(-1)).toMatchObject({ step: 'review', text: expect.stringContaining('Check only these findings of the last round') })
    expect(r.effects.at(-1)).toMatchObject({ text: expect.stringContaining('- bug [major] bug title: bug proof\nThe agent contests: bug.') })
  })

  const twice = [{ kind: 'start' }, report, verdict(bug), { ...report, disputes: ['bug'] }, verdict(bug), report] as StepEvent[]

  it('the third send-back goes to Your turn with the advice; the coordinator is held to its options', () => {
    const r = play(company, 'feature', [...twice, verdict(bug)])
    expect(r.at()).toBe('review')
    expect(r.state.yourTurn).toMatchObject({ reason: 'rounds', advice: { outcome: 'arbitrate', options: ['worker', 'reviewer'] } })
    const { plan, state } = r
    expect(onEvent(plan, state, { kind: 'decide', by: 'coordinator', choice: 'pass', note: 'nitpick' }, 0).refused).toBe('The coordinator may only choose worker or reviewer')
    // A pass on a spec change (cited, checked by the server) ends the loop outside the options.
    expect(onEvent(plan, state, { kind: 'decide', by: 'coordinator', choice: 'pass', note: 'Spec change of 2026-11-10.', spec: true }, 0).effects[0]).toMatchObject({ text: expect.stringMatching(/^review: coordinator chose pass on a spec change/) })
    expect(onEvent(plan, state, { kind: 'decide', by: 'coordinator', choice: 'worker' }, 0).refused).toBe('Give the reason of the choice')
    const ok = onEvent(plan, state, { kind: 'decide', by: 'coordinator', choice: 'worker', note: 'The test was wrong' }, 0)
    expect(ok.effects[0]).toEqual({ kind: 'log', text: 'review: coordinator chose worker (advice: arbitrate, Sent back again and contested by the agent: bug title). The test was wrong' })
    expect(plan[ok.state.at]!.id).toBe('pr')
  })

  it('one more round is limited to the findings in question; after it, the advice is split', () => {
    const fresh = f('fresh', 'major')
    const r = play(company, 'feature', [{ kind: 'start' }, report, verdict(bug), report, verdict(bug), report, verdict(bug, fresh),
      { kind: 'decide', by: 'user', choice: 'round' }])
    expect(r.state.extra).toEqual({ review: true })
    expect(r.effects.at(-1)).toMatchObject({ step: 'work', text: expect.not.stringContaining('bug [major]') })
    const after = play(company, 'feature', [{ kind: 'start' }, report, verdict(bug), report, verdict(bug), report, verdict(bug, fresh),
      { kind: 'decide', by: 'user', choice: 'round' }, report, verdict(f('other', 'major'))])
    expect(after.state.yourTurn?.advice).toMatchObject({ outcome: 'split', findings: ['other'] })
    const split = onEvent(after.plan, after.state, { kind: 'decide', by: 'user', choice: 'split' }, 0)
    expect(split.effects.map(e => e.kind)).toEqual(['log', 'split', 'instruct'])
    expect(split.effects[1]).toMatchObject({ findings: [{ id: 'other' }] })
  })

  it('a change of agent happens once, then only abandon is left', () => {
    const r = play(company, 'feature', [...twice, verdict(bug), { kind: 'decide', by: 'user', choice: 'swap' }])
    expect(r.effects.slice(-2).map(e => e.kind)).toEqual(['swap', 'instruct'])
    expect(r.at()).toBe('work')
    const again = play(company, 'feature', [...twice, verdict(bug), { kind: 'decide', by: 'user', choice: 'swap' }, report, verdict(bug)])
    expect(onEvent(again.plan, again.state, { kind: 'decide', by: 'user', choice: 'swap' }, 0).refused).toBe('The agent was already changed once')
    const end = onEvent(again.plan, again.state, { kind: 'decide', by: 'user', choice: 'abandon' }, 0)
    expect(end.state).toMatchObject({ done: true, abandoned: true })
  })

  it('a review before a merge only the user may do: Your turn', () => {
    const guarded: Template = { ...github, id: 'g', taskTypes: { simple: { steps: github.taskTypes.simple!.steps.map(s =>
      typeof s !== 'string' && s.id === 'pr' ? { ...s, action: { kind: 'github.pr' as const, base: 'main' } } : s) } } }
    expect(planSteps(guarded, { type: 'simple' }).find(s => s.id === 'merge')?.guarded).toBe(true)
    expect(planSteps(github, { type: 'simple' }).find(s => s.id === 'merge')?.guarded).toBeUndefined()
    const ok: StepEvent = { kind: 'action-result', ok: true }
    const r = play(guarded, 'simple', [{ kind: 'start' }, report, ok, verdict(bug), report, ok, verdict(bug), report, ok, verdict(bug)])
    expect(r.state.yourTurn?.advice).toMatchObject({ outcome: 'your-turn', why: 'The next step is a merge only you may do' })
    expect(onEvent(r.plan, r.state, { kind: 'decide', by: 'coordinator', choice: 'pass', note: 'x' }, 0).refused).toBe('This one is for the user')
    expect(onEvent(r.plan, r.state, { kind: 'decide', by: 'coordinator', choice: 'pass', note: 'x', spec: true }, 0).refused).toBe('The next step is a merge only the user may do: this one is for the user')
    // Nor a critical finding with proof, whatever the spec change.
    const leak = play(company, 'feature', [...twice, verdict(f('leak', 'critical'))])
    expect(onEvent(leak.plan, leak.state, { kind: 'decide', by: 'coordinator', choice: 'pass', note: 'x', spec: true }, 0).refused).toBe('A critical finding with proof is for the user')
  })
})

describe('reviewer plan', () => {
  const task = (prefs: Task['prefs'] = {}): Task => ({ id: 'P-1', project: 'P', title: 't', description: '', type: 'feature', state: 'todo', createdAt: 0, prefs })
  it('uses another model than the worker', () => {
    expect(reviewerPlan(company, task())).toEqual({ program: 'claude', model: 'opus' })
    expect(reviewerPlan(company, task({ reviewAgent: 'codex', reviewModel: 'gpt-5.5' }))).toEqual({ program: 'codex', model: 'gpt-5.5' })
    expect(reviewerPlan(company, task({ reviewModel: 'sonnet' }))).toEqual({ reason: 'The reviewer must use another model than the worker (sonnet), or set reviewModel to "same"' })
    // "same": a fresh session of the worker's own model, asked for by the template.
    expect(reviewerPlan(company, task({ reviewModel: 'same' }))).toEqual({ program: 'claude', model: 'sonnet' })
    expect(reviewerPlan(company, task({ reviewModel: 'same', reviewAgent: 'codex' }))).toEqual({ reason: 'reviewModel "same" needs the worker\'s agent (claude)' })
    expect(reviewerPlan({ ...company, prefs: { agent: 'claude', model: 'sonnet' } }, task())).toEqual({ reason: 'No review model set: add prefs.reviewModel to the template' })
  })
  // The engine's reading says the review agent's account is out (`out`); none: as before.
  const out = 'Codex out of quota until 14:52'
  it('a review agent out of quota: the fallback the prefs set, whatever the pair', () => {
    const codexFirst = task({ reviewAgent: 'codex', reviewModel: 'gpt-6.1-sol', reviewFallbackAgent: 'claude', reviewFallbackModel: 'same' })
    expect(reviewerPlan(company, codexFirst, out)).toEqual({ program: 'claude', model: 'sonnet', switched: out })
    // Its quota back (an expired reading counts as back): the review agent again.
    expect(reviewerPlan(company, codexFirst)).toEqual({ program: 'codex', model: 'gpt-6.1-sol' })
    const claudeFirst = task({ reviewFallbackAgent: 'codex', reviewFallbackModel: 'gpt-6.1-sol' })
    expect(reviewerPlan(company, claudeFirst, 'Claude out of quota until 09:10')).toEqual({ program: 'codex', model: 'gpt-6.1-sol', switched: 'Claude out of quota until 09:10' })
  })
  it('reads the review agent\'s account on the machine: limit reached, or an expired reading that does not count', () => {
    const now = new Date(2026, 10, 10, 13, 0).getTime(), resetsAt = new Date(2026, 10, 10, 14, 52).getTime()
    const q = (at: number) => ({ claude: null, codex: { at, five: null, week: null, limited: { resetsAt } } })
    expect(accountOut(q(now - 60_000), 'codex', '', now)).toBe(out)
    expect(accountOut(q(now - 60_000), 'codex', '', resetsAt + 1)).toBeUndefined()
    expect(accountOut(q(now - 60_000), 'claude', '', now)).toBeUndefined()
  })
  it('no fallback set: the review agent, as before; an invalid one says why', () => {
    expect(reviewerPlan(company, task({ reviewAgent: 'codex', reviewModel: 'gpt-6.1-sol' }), out)).toEqual({ program: 'codex', model: 'gpt-6.1-sol' })
    expect(reviewerPlan(company, task({ reviewFallbackAgent: 'claude' }), out)).toEqual({ reason: 'reviewFallbackAgent and reviewFallbackModel go together' })
    expect(reviewerPlan(company, task({ reviewFallbackAgent: 'claude', reviewFallbackModel: 'sonnet' }), out)).toEqual({ reason: 'The reviewer must use another model than the worker (sonnet), or set reviewFallbackModel to "same"' })
  })
  it('the task sheet shows the last start when the fallback took it', () => {
    const log = (...texts: string[]) => texts.map(text => ({ text }))
    expect(reviewSwitch(log('review: started the reviewer (codex gpt-6.1-sol)', `review: ${out}, reviewed by claude sonnet`))).toBe(`${out}, reviewed by claude sonnet`)
    expect(reviewSwitch(log(`review: ${out}, reviewed by claude sonnet`, 'review: sent to the reviewer', 'review: started the reviewer (codex gpt-6.1-sol)'))).toBeUndefined()
  })
  it('a workflow with an invalid fallback is refused at save', () => {
    const errors = (prefs: Template['prefs']) => validateTemplate({ ...company, prefs: { ...company.prefs, ...prefs } })
    expect(errors({ reviewFallbackAgent: 'claude', reviewFallbackModel: 'same' })).toEqual([])
    expect(errors({ reviewFallbackAgent: 'codex', reviewFallbackModel: 'gpt-6.1-sol' })).toEqual([])
    expect(errors({ reviewFallbackModel: 'opus' })).toContainEqual({ path: 'prefs.reviewFallbackModel', message: 'reviewFallbackAgent and reviewFallbackModel go together' })
    expect(errors({ reviewFallbackAgent: 'codex', reviewFallbackModel: 'same' })).toContainEqual({ path: 'prefs.reviewFallbackModel', message: 'reviewFallbackModel "same" needs the worker\'s agent (claude) (task type feature)' })
    expect(errors({ reviewFallbackAgent: 'gemini', reviewFallbackModel: 'pro' })).toContainEqual(expect.objectContaining({ path: 'prefs.reviewFallbackAgent' }))
  })
})
