import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DONE_CMD, READ_SEP, chainState, dueText, parseRead, proofsOf, runsNow, signalEvent, type SignalRead } from '../shared/pm/advance'
import { initialState, onEvent, planSteps, type StepEvent, type StepState } from '../shared/pm/steps'
import { company, github, vibe, common } from '../shared/pm/examples'
import type { Template } from '../shared/pm/workflow'
import type { Task } from '../shared/pm/run'

const read = (more: Partial<SignalRead> = {}): SignalRead => ({ head: 'abc1234', diffLines: 12, note: '', verdict: '', ...more })
const major = '{"findings":[{"id":"no-test","severity":"major","title":"No test","proof":"npm test: 0 tests"}]}'

// A task through its plan: the worker's first step is told by its
// instructions file (startTask), then each agent's "done" goes through signalEvent.
function walk(t: Template, type: string) {
  const plan = planSteps(t, { type })
  const first = onEvent(plan, initialState(), { kind: 'start' }, 0).state
  let s: StepState = { ...first, told: first.since }
  let now = 1
  const step = () => plan[s.at]!
  const on = (ev: StepEvent) => {
    const r = onEvent(plan, s, ev, now++)
    if (!r.refused) s = r.state
    return r
  }
  const done = (role: 'worker' | 'reviewer', r = read()) => {
    const ev = signalEvent(step(), role, r)
    if (!ev || 'fix' in ev) throw new Error(`no event: ${JSON.stringify(ev)}`)
    return on(ev)
  }
  // What the engine tells the holder now, marked told as the advance pass does.
  const tell = () => { const d = dueText(plan, s); if (d) s = { ...s, told: s.since }; return d }
  return { plan, get s() { return s }, step, on, done, tell }
}

describe('after the worker, with each example template', () => {
  it('vibe: the worker\'s done lands the branch at once, then the task is done', () => {
    const w = walk(vibe, 'simple')
    expect(w.tell()).toBeUndefined()
    w.done('worker')
    expect(w.step().id).toBe('land')
    expect(runsNow(w.step(), w.s)).toBe(true)
    w.on({ kind: 'action-result', ok: true, evidence: { commit: 'abc' } })
    expect(w.s.done).toBe(true)
    expect(w.s.yourTurn).toBeUndefined()
  })

  it('company: a reviewer of another model, a send-back, the PR by the worker, then the user\'s "Merged"', () => {
    const w = walk(company, 'feature')
    w.done('worker')
    expect(w.step().id).toBe('review')
    const review = w.tell()!
    expect(review.holder).toBe('reviewer')
    expect(review.text).toContain('{"findings":')
    expect(w.tell()).toBeUndefined() // once per step start
    // The worker cannot end the reviewer's step.
    expect(signalEvent(w.step(), 'worker', read())).toBeUndefined()
    w.done('reviewer', read({ verdict: `Looks wrong.\n${major}` }))
    expect(w.step().id).toBe('work')
    const back = w.tell()!
    expect(back).toMatchObject({ holder: 'worker' })
    expect(back.text).toContain('no-test [major] No test')
    expect(back.text).toContain(DONE_CMD)
    w.done('worker')
    expect(w.tell()!.text).toContain('Check only these findings of the last round')
    w.done('reviewer', read({ verdict: '{"findings":[]}' }))
    expect(w.step().id).toBe('pr')
    expect(w.tell()!.text).toContain('Create the PR to develop')
    // The PR step needs its link: missing, the agent is told and the step stays.
    expect(w.done('worker').refused).toBe('Not done yet: step "pr" needs a link.')
    w.done('worker', read({ note: 'PR: https://github.com/o/r/pull/7\nDone.' }))
    expect(w.s.proofs.pr?.link).toBe('https://github.com/o/r/pull/7')
    // The template asks for the user's gesture here, and only here.
    expect(w.step().id).toBe('merge')
    expect(w.s.yourTurn).toMatchObject({ reason: 'user', badge: 'Merge the PR' })
    expect(runsNow(w.step(), w.s)).toBe(false)
    expect(w.tell()).toBeUndefined()
    w.on({ kind: 'user' })
    w.on({ kind: 'action-result', ok: true })
    // The deploy step is the coordinator's (pmWakes tells it), not an agent's.
    expect(w.step().id).toBe('deploy')
    expect(w.tell()).toBeUndefined()
    w.on({ kind: 'report', from: 'coordinator' })
    expect(w.s.done).toBe(true)
  })

  it('github: the engine opens the PR, the reviewer checks it, the merge waits for its checks', () => {
    const w = walk(github, 'simple')
    w.done('worker')
    expect(w.step().id).toBe('pr')
    expect(runsNow(w.step(), w.s)).toBe(true)
    w.on({ kind: 'action-result', ok: true, evidence: { link: 'https://github.com/o/r/pull/8' } })
    expect(w.tell()?.holder).toBe('reviewer')
    w.done('reviewer', read({ verdict: '{"findings":[{"id":"nit","severity":"minor","title":"Name"}]}' }))
    // A merge the branch rule gives the engine: pmMechanic merges once CI is green.
    expect(w.step().id).toBe('merge')
    expect(w.s.acting).toBe(true)
    expect(runsNow(w.step(), w.s)).toBe(false)
    w.on({ kind: 'action-result', ok: true })
    expect(w.s.done).toBe(true)
    // Into a protected base, the merge runs now so its guard hands it to the user.
    const guarded = walk({ ...github, taskTypes: { simple: { steps: github.taskTypes.simple!.steps.map(s => (typeof s !== 'string' && s.id === 'pr' ? { ...s, action: { kind: 'github.pr' as const, base: 'main' } } : s)) } } }, 'simple')
    const merge = guarded.plan.find(p => p.id === 'merge')!
    expect(merge.guarded).toBe(true)
    expect(runsNow(merge, { ...guarded.s, acting: true })).toBe(true)
  })

  it('common: a study ends with its report; a split waits for the user to create the tasks', () => {
    const study = walk(common, 'study')
    expect(study.done('worker', read({ note: '' })).refused).toBe('Not done yet: step "work" needs your report.')
    study.done('worker', read({ note: 'Findings: …' }))
    expect(study.s.done).toBe(true)
    const split = walk(common, 'feature-split')
    split.done('worker', read({ note: '1. CO-2 …\n2. CO-3 …' }))
    expect(split.step().id).toBe('pick')
    expect(split.s.yourTurn).toMatchObject({ reason: 'user', badge: 'Create these tasks' })
  })

  it('a conflict an action sends back reaches the worker as what to fix', () => {
    const w = walk(vibe, 'simple')
    w.done('worker')
    w.on({ kind: 'action-result', ok: false, error: 'land: conflict in a.ts', toAgent: true })
    expect(w.step().id).toBe('work')
    expect(w.tell()!.text).toMatch(/^land: conflict in a\.ts\. Fix it, commit/)
  })
})

describe('end signals', () => {
  it('reads the engine\'s script output, and the proofs a note gives', () => {
    const r = parseRead(['abc1234', '42', 'See https://github.com/o/r/pull/3.\n', '{"findings":[]}'].join(`\n${READ_SEP}\n`))
    expect(r).toEqual({ head: 'abc1234', diffLines: 42, note: 'See https://github.com/o/r/pull/3.', verdict: '{"findings":[]}' })
    expect(proofsOf(r)).toMatchObject({ link: 'https://github.com/o/r/pull/3.', commit: 'abc1234', report: r.note })
    expect(proofsOf(read({ head: undefined }))).toEqual({})
  })

  it('a verdict that does not parse is sent back to the reviewer, with how to answer', () => {
    const step = planSteps(company, { type: 'feature' }).find(s => s.id === 'review')
    expect(signalEvent(step, 'reviewer', read({ verdict: 'LGTM' }))).toEqual({ fix: expect.stringContaining(DONE_CMD) })
    expect(signalEvent(step, 'reviewer', read({ verdict: major, diffLines: 30 }))).toMatchObject({ kind: 'verdict', diffLines: 30, findings: [{ id: 'no-test' }] })
  })
})

describe('chained tasks', () => {
  const task = (id: string, more: Partial<Task> = {}): Task => ({ id, project: 'CO', title: id, description: '', type: 'simple', state: 'todo', createdAt: 0, ...more })
  const finished = (id: string, more: Partial<StepState> = {}) => task(id, { state: 'working', step: { ...initialState(), started: true, done: true, ...more } })

  it('starts once every task before it is done; waits for the user when one failed or stopped', () => {
    const next = task('CO-3', { after: 'CO-1, CO-2' })
    expect(chainState(next, [finished('CO-1'), task('CO-2', { state: 'working' }), next])).toBeUndefined()
    // An agent's question is not a failure.
    expect(chainState(next, [finished('CO-1'), task('CO-2', { state: 'waiting', waitKind: 'question' }), next])).toBeUndefined()
    expect(chainState(next, [finished('CO-1'), finished('CO-2'), next])).toBe('go')
    expect(chainState(next, [finished('CO-1'), finished('CO-2', { abandoned: true }), next])).toEqual({ wait: 'CO-2, which this task starts after, was abandoned' })
    expect(chainState(next, [finished('CO-1'), task('CO-2', { state: 'waiting', waiting: 'git worktree failed\nmore' }), next]))
      .toEqual({ wait: 'CO-2, which this task starts after, stopped: git worktree failed' })
    expect(chainState(next, [finished('CO-1'), next])).toEqual({ wait: 'CO-2, which this task starts after, does not exist' })
  })
})

describe('advanceTick (store and a fake herdr-core)', () => {
  it('a task stopped at its review, started again, gets its reviewer again, never a new worker', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const { startTask } = await import('../server/utils/pmLaunch')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'simple' })
      const at = planSteps(github, { type: 'simple' }).findIndex(s => s.id === 'review')
      await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'sonnet', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/h/.wherdr/pm/tasks/CO-1/instructions.md', attempt: 1, state: 'ended', startedAt: 1 })
      await store.saveTask({ ...t, state: 'waiting', waiting: 'The reviewer (claude) stopped right after starting', run: 'r1', step: { at, started: true, since: 5, told: 5, proofs: {}, rounds: {} } })
      const calls: [string, Record<string, unknown>][] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        calls.push([method, p])
        if (method === 'terminal.list') return { terminals: [] }
        if (method === 'terminal.run') return { address: 'h/t2' }
        if (method === 'terminal.get') return { state: 'running' }
        return method === 'machine.exec' ? { code: 0, stdout: '' } : {}
      }
      const deps = { store, call, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0]
      expect(await startTask(deps, t.id)).toMatchObject({ state: 'working', step: { at } })
      expect(calls.some(([m]) => m === 'terminal.run')).toBe(false)
      await advanceTick(deps)
      const runs = calls.filter(([m]) => m === 'terminal.run')
      expect(runs).toHaveLength(1)
      expect(runs[0]![1]).toMatchObject({ cwd: '/w', labels: { 'wherdr.role': 'reviewer' } })
    }
    finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('turns the worker\'s done into the PR, starts the reviewer of another model, then reads its verdict', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const { startChained } = await import('../server/utils/pmMechanic')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'simple' })
      const next = await store.addTask({ project: 'CO', title: 'Then', type: 'simple', after: t.id })
      const plan = planSteps(github, { type: 'simple' })
      const first = onEvent(plan, initialState(), { kind: 'start' }, 1).state
      await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'sonnet', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/h/.wherdr/pm/tasks/CO-1/instructions.md', terminal: 'h/t1', attempt: 1, state: 'running', startedAt: 1 })
      await store.saveTask({ ...t, state: 'working', run: 'r1', step: { ...first, told: first.since } })
      const terms: Record<string, Record<string, string>> = { 'h/t1': { 'wherdr.report': 'done' } }
      let verdict = ''
      const calls: [string, Record<string, unknown>][] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        calls.push([method, p])
        if (method === 'terminal.list') return { terminals: Object.entries(terms).map(([address, labels]) => ({ address, labels })) }
        if (method === 'terminal.label') Object.assign(terms[p.terminal as string]!, p.labels)
        if (method === 'terminal.run') { terms['h/t2'] = {}; return { address: 'h/t2' } }
        if (method === 'terminal.get') return { state: 'running' }
        if (method !== 'machine.exec') return {}
        const script = (p.argv as string[])[2]!
        const out = script.includes(READ_SEP) ? ['abc1234', '5', '', verdict].join(`\n${READ_SEP}\n`)
          : script.includes('gh pr create') ? 'https://github.com/o/r/pull/9'
            : script.includes('command -v') ? 'claude' : script.includes('$HOME') ? '/h' : ''
        return { code: script.includes('--contains') ? 1 : 0, stdout: Buffer.from(out).toString('base64') }
      }
      const deps = { store, call, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0]

      await advanceTick(deps)
      let task = (await store.task(t.id))!
      // The worker's done went on to the PR, opened at once; its signal is cleared.
      expect(plan[task.step!.at]!.id).toBe('review')
      expect(task.step!.proofs.pr?.link).toBe('https://github.com/o/r/pull/9')
      expect(terms['h/t1']!['wherdr.report']).toBe('')
      expect(task.log?.map(l => l.text)).toContain('work: done')

      await advanceTick(deps)
      task = (await store.task(t.id))!
      const started = calls.find(([m]) => m === 'terminal.run')![1]
      expect(started).toMatchObject({ cwd: '/w', labels: { 'wherdr.role': 'reviewer', 'wherdr.task': t.id }, env: { DISABLE_AUTOUPDATER: '1' } })
      expect(started.line).toContain(`exec claude '--model' 'opus' 'Read /h/.wherdr/pm/tasks/CO-1/review.md and follow it.'`)
      expect(task.run).not.toBe('r1')
      expect(task.step!.told).toBe(task.step!.since)
      await advanceTick(deps) // nothing new: told once
      expect(calls.filter(([m]) => m === 'terminal.run')).toHaveLength(1)

      // A major finding: back to the worker, its old note removed (a stale link proves nothing).
      verdict = major
      terms['h/t2']!['wherdr.report'] = 'done'
      await advanceTick(deps)
      expect(plan[(await store.task(t.id))!.step!.at]!.id).toBe('work')
      await advanceTick(deps)
      const sent = calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t1').map(([, p]) => p.text as string)
      expect(sent.at(-1)).toContain('no-test [major] No test')
      expect(calls.some(([m, p]) => m === 'machine.exec' && (p.argv as string[]).includes('/h/.wherdr/pm/tasks/CO-1/report.md') && (p.argv as string[])[2] === 'rm -f "$1"')).toBe(true)
      // The fix, then the review again in the same reviewer's terminal.
      terms['h/t1']!['wherdr.report'] = 'done'
      await advanceTick(deps) // the PR again (same branch), then the review
      await advanceTick(deps)
      expect(calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t2').at(-1)![1].text).toBe('Review again: read /h/.wherdr/pm/tasks/CO-1/review.md and follow it.')
      expect(calls.filter(([m]) => m === 'terminal.run')).toHaveLength(1)
      verdict = '{"findings":[]}'
      terms['h/t2']!['wherdr.report'] = 'done'
      await advanceTick(deps)
      task = (await store.task(t.id))!
      expect(plan[task.step!.at]!.id).toBe('merge')
      expect(task.log?.at(-1)?.text).toBe('review: verdict, 0 finding(s)')

      // Merged (pmMechanic's move): the task is done, its agents stop, the chained one starts.
      await store.saveTask({ ...task, step: onEvent(plan, task.step!, { kind: 'action-result', ok: true }, 9).state })
      await advanceTick(deps)
      expect(calls.filter(([m]) => m === 'terminal.kill').map(([, p]) => p.terminal).sort()).toEqual(['h/t1', 'h/t2'])
      expect((await store.runs()).every(r => r.state === 'ended')).toBe(true)
      expect((await store.task(next.id))!.state).toBe('todo')
      const before = calls.length
      await startChained(deps)
      expect(calls.slice(before).some(([m]) => m === 'terminal.run')).toBe(true)
      expect((await store.task(next.id))!.log?.at(-1)?.text).toBe(`started: ${t.id} done`)

      // A chained task held because the task before it stopped: to do again once that one goes on.
      const third = await store.addTask({ project: 'CO', title: 'Last', type: 'simple', after: next.id })
      await store.saveTask({ ...(await store.task(next.id))!, state: 'waiting', waiting: 'git worktree failed' })
      await startChained(deps)
      expect(await store.task(third.id)).toMatchObject({ state: 'waiting', waiting: `${next.id}, which this task starts after, stopped: git worktree failed` })
      await store.saveTask({ ...(await store.task(next.id))!, state: 'working', waiting: undefined })
      await startChained(deps)
      expect(await store.task(third.id)).toMatchObject({ state: 'todo' })
      expect((await store.task(third.id))!.waiting).toBeUndefined()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
