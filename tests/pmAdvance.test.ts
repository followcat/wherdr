import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DONE_CMD, READ_SEP, chainState, dueText, parseRead, proofsOf, runsNow, signalEvent, signalKept, type SignalRead } from '../shared/pm/advance'
import { initialState, onEvent, planSteps, type StepEvent, type StepState } from '../shared/pm/steps'
import { company, github, vibe, common } from '../shared/pm/examples'
import type { Template } from '../shared/pm/workflow'
import type { Task } from '../shared/pm/run'
import { taskHistory } from '../shared/pm/history'

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
    expect(w.s.yourTurn).toMatchObject({ reason: 'user', badge: 'Merge the PR on GitHub' })
    expect(runsNow(w.step(), w.s)).toBe(false)
    expect(w.tell()).toBeUndefined()
    w.on({ kind: 'user' })
    w.on({ kind: 'action-result', ok: true })
    // The engine watches the deploy: no agent is told.
    expect(w.step().id).toBe('deploy')
    expect(w.tell()).toBeUndefined()
    expect(runsNow(w.step(), w.s)).toBe(true)
    w.on({ kind: 'action-result', ok: true })
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
    expect(proofsOf(r)).toMatchObject({ link: 'https://github.com/o/r/pull/3', commit: 'abc1234', report: r.note })
    expect(proofsOf(read({ head: undefined }))).toEqual({})
    // Then the branch, its own commits' fingerprint and its files with their line counts (binary: 0).
    const w = parseRead(['abc1234', '42', '', '', 'task/X-1\n', '123 45\n', '3\t1\tsrc/a.ts\n-\t-\tlogo.png\n'].join(`${READ_SEP}\n`))
    expect(w.work).toEqual({ commits: '123 45', files: [{ path: 'src/a.ts', add: 3, del: 1 }, { path: 'logo.png', add: 0, del: 0 }] })
  })

  it('keeps each worker report as it arrives, and the commits a verdict read', () => {
    const w = (commits: string) => ({ commits, files: [] })
    const base = { id: 'X-1', project: 'X', title: 't', description: '', type: 'feature', state: 'working' } as Task
    const a = signalKept(base, 'work', { kind: 'report' }, read({ note: 'First', work: w('1') }))
    expect(a).toEqual({ work: w('1'), workReports: [{ step: 'work', text: 'First' }] })
    const b = signalKept({ ...base, ...a }, 'review', { kind: 'verdict' }, read({ verdict: '{}', work: w('1') }))
    expect(b).toEqual({ work: { ...w('1'), reviewed: '1' } })
    const c = signalKept({ ...base, ...a, ...b }, 'work', { kind: 'report' }, read({ note: 'Second', work: w('2') }))
    expect(c).toEqual({ work: { ...w('2'), reviewed: '1' }, workReports: [{ step: 'work', text: 'First' }, { step: 'work', text: 'Second' }] })

    // An empty report keeps its place: the earlier one stays on its own "done".
    const d = signalKept({ ...base, ...c }, 'work', { kind: 'report' }, read({ note: '', work: w('3') }))
    expect(d.workReports!.map(r => r.text)).toEqual(['First', 'Second', ''])
    const log = ['work: done', 'review: verdict, 0 finding(s)', 'work: done'].map((text, i) => ({ at: i, by: i === 1 ? 'reviewer x' : 'worker x', text }))
    const reports = [{ step: 'work', text: 'Original report' }, { step: 'work', text: '' }]
    expect(taskHistory(log, [{ id: 'work' }, { id: 'review' }], { proofs: {} }, false, reports).filter(e => e.who === 'worker').map(e => e.text))
      .toEqual(['Original report', 'Reported done.'])
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

  it('a reviewer that hits its account limit mid-review: the fallback takes the review over from the start', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate({ ...github, prefs: { ...github.prefs, reviewAgent: 'codex', reviewModel: 'gpt-6.1-sol', reviewFallbackAgent: 'claude', reviewFallbackModel: 'same' } })
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'simple' })
      const at = planSteps(github, { type: 'simple' }).findIndex(s => s.id === 'review')
      const run = { task: t.id, machine: '', worktree: '/w', branch: 'task/CO-1', attempt: 1, state: 'running' as const }
      await store.saveRun({ ...run, id: 'r1', role: 'worker', program: 'claude', model: 'sonnet', instructions: '/h/.wherdr/pm/tasks/CO-1/instructions.md', terminal: 'h/t1', startedAt: 1 })
      await store.saveRun({ ...run, id: 'r2', role: 'reviewer', program: 'codex', model: 'gpt-6.1-sol', instructions: '/h/.wherdr/pm/tasks/CO-1/review.md', terminal: 'h/t2', startedAt: 2 })
      await store.saveTask({ ...t, state: 'working', run: 'r2', step: { at, started: true, since: 5, told: 5, proofs: {}, rounds: {} } })
      const install = await store.install(), now = Date.now(), resetsAt = now + 3_600_000
      const labels = (id: string, role: string) => ({ 'wherdr.install': install, 'wherdr.task': t.id, 'wherdr.run': id, 'wherdr.role': role })
      const started: Record<string, unknown>[] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        if (method === 'terminal.list') return { terminals: [{ address: 'h/t1', labels: labels('r1', 'worker') }, { address: 'h/t2', state: 'finished', exit_code: 1, finished_ms: now, labels: labels('r2', 'reviewer') }] }
        if (method === 'terminal.run') { started.push(p); return { address: 'h/t3' } }
        return method === 'machine.exec' ? { code: 0, stdout: '' } : {}
      }
      // The engine's account reading: Codex at its limit for another hour.
      const quotas = async () => ({ claude: null, codex: { at: now, five: null, week: null, limited: { resetsAt } }, accounts: [] })
      await advanceTick({ store, call, quotas, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0], now)
      expect(started).toHaveLength(1)
      expect(started[0]!.line).toContain(`exec claude '--model' 'sonnet'`)
      const runs = await store.runs()
      expect(runs.find(r => r.id === 'r2')).toMatchObject({ state: 'ended', endedBy: 'lost' })
      expect(runs.find(r => r.role === 'reviewer' && r.id !== 'r2')).toMatchObject({ program: 'claude', model: 'sonnet' })
      const until = new Date(resetsAt).toTimeString().slice(0, 5)
      expect((await store.task(t.id))!.log?.map(l => l.text)).toContain(`review: Codex out of quota until ${until}, reviewed by claude sonnet`)
    }
    finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('a Codex reviewer idle on its usage-limit message, the reading empty: its review and the waiting ones go to the fallback', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick, SCREEN_OUT } = await import('../server/utils/pmAdvance')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate({ ...github, prefs: { ...github.prefs, reviewAgent: 'codex', reviewModel: 'gpt-6.1-sol', reviewFallbackAgent: 'claude', reviewFallbackModel: 'same' } })
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const at = planSteps(github, { type: 'simple' }).findIndex(s => s.id === 'review')
      const install = await store.install(), labels: Record<string, Record<string, string>> = {}
      for (const [n, told] of [[1, 5], [2, 0]] as const) {
        const t = await store.addTask({ project: 'CO', title: `Fix ${n}`, type: 'simple' })
        const run = { task: t.id, machine: '', worktree: `/w${n}`, branch: `task/CO-${n}`, attempt: 1, state: 'running' as const }
        await store.saveRun({ ...run, id: `w${n}`, role: 'worker', program: 'claude', model: 'sonnet', instructions: `/h/.wherdr/pm/tasks/CO-${n}/instructions.md`, terminal: `h/w${n}`, startedAt: 1 })
        labels[`h/w${n}`] = { 'wherdr.install': install, 'wherdr.task': t.id, 'wherdr.run': `w${n}`, 'wherdr.role': 'worker' }
        // CO-1's Codex reviewer was told and sits on the limit; CO-2's review is due, no reviewer yet.
        if (n === 1) {
          await store.saveRun({ ...run, id: 'r1', role: 'reviewer', program: 'codex', model: 'gpt-6.1-sol', instructions: '/h/.wherdr/pm/tasks/CO-1/review.md', terminal: 'h/r1', startedAt: 2 })
          labels['h/r1'] = { 'wherdr.install': install, 'wherdr.task': t.id, 'wherdr.run': 'r1', 'wherdr.role': 'reviewer' }
        }
        await store.saveTask({ ...t, state: 'working', ...(n === 1 ? { run: 'r1' } : {}), step: { at, started: true, since: 5, told, proofs: {}, rounds: {} } })
      }
      const screen = '• Reading the diff\n\n■ You\'ve hit your usage limit. Upgrade to Pro (https://example.com), or try again at 11:59 PM.\n\n› Ask Codex to do anything'
      const calls: [string, Record<string, unknown>][] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        calls.push([method, p])
        if (method === 'terminal.list') return { terminals: Object.entries(labels).map(([address, l]) => ({ address, labels: l })) }
        if (method === 'terminal.read') return { text: p.terminal === 'h/r1' ? screen : '' }
        if (method === 'terminal.run') return { address: `h/n${calls.length}` }
        return method === 'machine.exec' ? { code: 0, stdout: '' } : {}
      }
      // Codex's reading has no numbers: primary and secondary null.
      const quotas = async () => ({ claude: null, codex: { at: Date.now(), five: null, week: null }, accounts: [] })
      await advanceTick({ store, call, quotas, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0])
      expect(calls.some(([m, p]) => m === 'terminal.kill' && p.terminal === 'h/r1')).toBe(true)
      expect((await store.runs()).find(r => r.id === 'r1')).toMatchObject({ state: 'ended', endedBy: 'lost' })
      const started = calls.filter(([m]) => m === 'terminal.run').map(([, p]) => p)
      expect(started.map(p => [p.cwd, p.line])).toEqual([['/w1', expect.stringContaining(`exec claude '--model' 'sonnet'`)], ['/w2', expect.stringContaining(`exec claude '--model' 'sonnet'`)]])
      expect((await store.task('CO-2'))!.log?.map(l => l.text)).toContain('review: Codex out of quota until 23:59, reviewed by claude sonnet')
    }
    finally { SCREEN_OUT.clear(); await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('a live fallback reviewer keeps a new round while the review agent is out, then ends once it has quota again', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate({ ...github, prefs: { ...github.prefs, reviewAgent: 'codex', reviewModel: 'gpt-6.1-sol', reviewFallbackAgent: 'claude', reviewFallbackModel: 'same' } })
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'simple' })
      const at = planSteps(github, { type: 'simple' }).findIndex(s => s.id === 'review')
      const run = { task: t.id, machine: '', worktree: '/w', branch: 'task/CO-1', attempt: 1, state: 'running' as const }
      await store.saveRun({ ...run, id: 'r1', role: 'worker', program: 'claude', model: 'sonnet', instructions: '/h/.wherdr/pm/tasks/CO-1/instructions.md', terminal: 'h/t1', startedAt: 1 })
      await store.saveRun({ ...run, id: 'r3', role: 'reviewer', program: 'claude', model: 'sonnet', instructions: '/h/.wherdr/pm/tasks/CO-1/review.md', terminal: 'h/t3', startedAt: 3 })
      // A new review round: the step's text not told yet.
      const round = async () => store.saveTask({ ...(await store.task(t.id))!, state: 'working', run: 'r3', step: { at, started: true, since: 9, told: 5, proofs: {}, rounds: {} } })
      const install = await store.install(), now = Date.now()
      const labels = (id: string, role: string) => ({ 'wherdr.install': install, 'wherdr.task': t.id, 'wherdr.run': id, 'wherdr.role': role })
      const calls: [string, Record<string, unknown>][] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        calls.push([method, p])
        if (method === 'terminal.list') return { terminals: [{ address: 'h/t1', labels: labels('r1', 'worker') }, { address: 'h/t3', labels: labels('r3', 'reviewer') }] }
        if (method === 'terminal.run') return { address: 'h/t4' }
        return method === 'machine.exec' ? { code: 0, stdout: '' } : {}
      }
      let limited: { resetsAt: number } | undefined = { resetsAt: now + 3_600_000 }
      const quotas = async () => ({ claude: null, codex: { at: now, five: null, week: null, ...(limited ? { limited } : {}) }, accounts: [] })
      const deps = { store, call, quotas, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0]
      await round()
      await advanceTick(deps)
      expect(calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t3')).toHaveLength(1)
      expect(calls.some(([m]) => m === 'terminal.run' || m === 'terminal.kill')).toBe(false)
      // Codex has quota again: the next round goes to it, the fallback ends.
      limited = undefined
      await round()
      await advanceTick(deps)
      expect(calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t3')).toHaveLength(1)
      expect(calls.filter(([m]) => m === 'terminal.run').map(([, p]) => p.line as string)).toEqual([expect.stringContaining(`exec codex '-c' 'check_for_update_on_startup=false' '--model' 'gpt-6.1-sol'`)])
      expect((await store.runs()).find(r => r.id === 'r3')).toMatchObject({ state: 'ended', endedBy: 'stopped' })
      expect((await store.task(t.id))!.log?.map(l => l.text)).toEqual(expect.arrayContaining(['review: Codex has quota again, the fallback reviewer (claude sonnet) ends', 'review: started the reviewer (codex gpt-6.1-sol)']))
    }
    finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('two live workers on a task: the one the task tracks goes on, the other is ended and logged', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-advance-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      await store.addProject({ key: 'CO', machine: '', path: '/src', template: 'github' }, async (_m, p) => p)
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'simple' })
      const r = (id: string, startedAt: number) => store.saveRun({ id, task: t.id, role: 'worker', program: 'claude', model: 'sonnet', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/i.md', terminal: `h/${id}`, attempt: 1, state: 'running', startedAt })
      await r('r1', 1)
      await r('r2', 2)
      const first = onEvent(planSteps(github, { type: 'simple' }), initialState(), { kind: 'start' }, 1).state
      await store.saveTask({ ...t, state: 'working', run: 'r1', step: { ...first, told: first.since } })
      const install = await store.install()
      const killed: unknown[] = []
      const call = async (method: string, p: Record<string, unknown>) => {
        if (method === 'terminal.list') return { terminals: ['r1', 'r2'].map(id => ({ address: `h/${id}`, labels: { 'wherdr.install': install, 'wherdr.task': t.id, 'wherdr.run': id, 'wherdr.role': 'worker' } })) }
        if (method === 'terminal.kill') killed.push(p.terminal)
        return method === 'machine.exec' ? { code: 0, stdout: '' } : {}
      }
      await advanceTick({ store, call, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0])
      expect(killed).toEqual(['h/r2'])
      expect((await store.runs()).map(x => [x.id, x.state])).toEqual(expect.arrayContaining([['r1', 'running'], ['r2', 'ended']]))
      expect((await store.task(t.id))!.log?.map(l => l.text)).toContain('ended a second worker (run r2): one worker per task, run r1 goes on')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('turns the worker\'s done into the PR on the branch it checked out, starts the reviewer of another model, then reads its verdict', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const { startChained } = await import('../server/utils/pmMechanic')
    const { actionsSettled } = await import('../server/utils/pmBoard')
    // The step actions a tick starts run outside it: each tick here waits for them.
    const tick = async (d: Parameters<typeof advanceTick>[0]) => { await advanceTick(d); await actionsSettled() }
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
        // The worker checked out its own branch: the engine follows it.
        const out = script.includes(READ_SEP) ? ['abc1234', '5', '', verdict, 'feature/CO-1-fix'].join(`\n${READ_SEP}\n`)
          : script.includes('gh pr create') ? 'https://github.com/o/r/pull/9'
            : script.includes('command -v') ? 'claude' : script.includes('$HOME') ? '/h' : ''
        return { code: script.includes('--contains') ? 1 : 0, stdout: Buffer.from(out).toString('base64') }
      }
      const deps = { store, call, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0]

      await tick(deps)
      let task = (await store.task(t.id))!
      // The worker's done went on to the PR, opened at once; its signal is cleared.
      expect(plan[task.step!.at]!.id).toBe('review')
      expect(task.step!.proofs.pr?.link).toBe('https://github.com/o/r/pull/9')
      expect(terms['h/t1']!['wherdr.report']).toBe('')
      expect(task.log?.map(l => l.text)).toContain('work: done')
      expect(task.branch).toBe('feature/CO-1-fix')
      expect((await store.runs()).find(r => r.id === 'r1')!.branch).toBe('feature/CO-1-fix')
      const pr = calls.find(([m, p]) => m === 'machine.exec' && (p.argv as string[])[2]!.includes('gh pr create'))![1].argv as string[]
      expect(pr).toContain('feature/CO-1-fix')
      expect(pr).not.toContain('task/CO-1')

      await tick(deps)
      task = (await store.task(t.id))!
      const started = calls.find(([m]) => m === 'terminal.run')![1]
      expect(started).toMatchObject({ cwd: '/w', labels: { 'wherdr.role': 'reviewer', 'wherdr.task': t.id }, env: { DISABLE_AUTOUPDATER: '1' } })
      expect(started.line).toContain(`exec claude '--model' 'opus' 'Read /h/.wherdr/pm/tasks/CO-1/review.md and follow it.'`)
      expect(task.run).not.toBe('r1')
      expect(task.step!.told).toBe(task.step!.since)
      await tick(deps) // nothing new: told once
      expect(calls.filter(([m]) => m === 'terminal.run')).toHaveLength(1)

      // A major finding: back to the worker, its old note removed (a stale link proves nothing).
      verdict = major
      terms['h/t2']!['wherdr.report'] = 'done'
      await tick(deps)
      expect(plan[(await store.task(t.id))!.step!.at]!.id).toBe('work')
      await tick(deps)
      const sent = calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t1').map(([, p]) => p.text as string)
      expect(sent.at(-1)).toContain('no-test [major] No test')
      expect(calls.some(([m, p]) => m === 'machine.exec' && (p.argv as string[]).includes('/h/.wherdr/pm/tasks/CO-1/report.md') && (p.argv as string[])[2] === 'rm -f "$1"')).toBe(true)
      // The fix, then the review again in the same reviewer's terminal.
      terms['h/t1']!['wherdr.report'] = 'done'
      await tick(deps) // the PR again (same branch), then the review
      await tick(deps)
      expect(calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t2').at(-1)![1].text).toBe('Review again: read /h/.wherdr/pm/tasks/CO-1/review.md and follow it.')
      expect(calls.filter(([m]) => m === 'terminal.run')).toHaveLength(1)
      verdict = '{"findings":[]}'
      terms['h/t2']!['wherdr.report'] = 'done'
      await tick(deps)
      task = (await store.task(t.id))!
      expect(plan[task.step!.at]!.id).toBe('merge')
      expect(task.log?.at(-1)?.text).toBe('review: verdict, 0 finding(s)')

      // Merged (pmMechanic's move): the task is done, its agents stop, the chained one starts.
      await store.saveTask({ ...task, step: onEvent(plan, task.step!, { kind: 'action-result', ok: true }, 9).state })
      await tick(deps)
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
