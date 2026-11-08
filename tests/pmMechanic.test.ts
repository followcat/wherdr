import { describe, expect, it } from 'vitest'
import { nextMove, redCiText, type MechFacts, type PrState } from '../shared/pm/mechanic'
import { combineGuards } from '../shared/pm/guards'
import type { PlannedStep, StepState } from '../shared/pm/steps'
import type { Task } from '../shared/pm/run'

const plan: PlannedStep[] = [
  { id: 'work', holder: 'worker', ends: 'report', text: '' },
  { id: 'push', ends: 'action', action: { kind: 'git.push' }, text: '' },
  { id: 'pr', ends: 'action', action: { kind: 'github.pr', base: 'v3' }, text: '' },
  { id: 'merge', ends: 'action', action: { kind: 'github.merge' }, text: '' },
]
const guards = combineGuards([{ source: 'project', guards: { protected: ['main'], merge: { others: 'engine' } } }])
const step = (at: number, more: Partial<StepState> = {}): StepState => ({ at, started: true, proofs: {}, rounds: {}, ...more })
const task = (more: Partial<Task> = {}): Task => ({ id: 'CO-1', project: 'CO', title: 'Fix', description: '', type: 'feature', state: 'working', run: 'r1', createdAt: 0, step: step(3, { acting: true }), ...more })
const pr = (more: Partial<PrState> = {}): PrState => ({ url: 'https://gh/pr/7', baseRefName: 'v3', headRefOid: 'abc1234', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...more })
const facts = (more: Partial<MechFacts> = {}): MechFacts => ({ task: task(), plan, guards, branch: 'task/CO-1', agentBusy: false, head: 'abc1234', pr: pr(), ...more })
const red = (conclusion: string, name = 'e2e') => [{ name, status: 'COMPLETED', conclusion }]

describe('mechanical moves', () => {
  it('restarts a task stopped on a login once the login is back, once per run', () => {
    const waiting = task({ state: 'waiting', waitKind: 'auth', step: step(0) })
    expect(nextMove(facts({ task: waiting, loggedIn: false }))).toBeUndefined()
    expect(nextMove(facts({ task: waiting, loggedIn: true }))).toEqual({ key: 'restart:r1', move: { kind: 'restart' } })
    expect(nextMove(facts({ task: { ...waiting, mech: { 'restart:r1': 1 } }, loggedIn: true }))).toBeUndefined()
    // A question or permission wait is not the engine's.
    expect(nextMove(facts({ task: { ...waiting, waitKind: 'question' }, loggedIn: true }))).toBeUndefined()
  })

  it('retries a push that failed on a passing error, not a send-back nor a guarded step', () => {
    const failed = (badge: string, tries = 1) => task({ step: step(1, { tries: { push: tries }, yourTurn: { reason: 'action', badge } }) })
    expect(nextMove(facts({ task: failed('push: remote end hung up') }))).toEqual({ key: 'retry:push:1', move: { kind: 'retry-action', step: 'push' } })
    expect(nextMove(facts({ task: failed('push: rejected (non-fast-forward)') }))).toBeUndefined()
    expect(nextMove(facts({ task: failed('push: remote end hung up', 3) }))).toBeUndefined()
    const guarded = plan.map(s => (s.id === 'push' ? { ...s, guarded: true as const } : s))
    expect(nextMove(facts({ task: failed('push: remote end hung up'), plan: guarded }))).toBeUndefined()
  })

  it('fixes the base of a PR opened against the wrong branch', () => {
    expect(nextMove(facts({ pr: pr({ baseRefName: 'main' }) }))).toEqual({ key: 'base:abc1234', move: { kind: 'fix-base', base: 'v3' } })
    // Not the task's commit, or before the PR step: nothing.
    expect(nextMove(facts({ pr: pr({ baseRefName: 'main', headRefOid: 'other' }) }))).toBeUndefined()
    // At the merge step, a PR head that is not the task's commit (a CI fix not pushed): the merge step sorts it out, once per attempt.
    expect(nextMove(facts({ pr: pr({ headRefOid: 'other' }) }))).toEqual({ key: 'merge:abc1234', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } })
    expect(nextMove(facts({ pr: pr({ headRefOid: 'other' }), agentBusy: true }))).toBeUndefined()
    expect(nextMove(facts({ task: task({ step: step(3, { acting: true, tries: { merge: 2 } }) }) }))?.key).toBe('merge:abc1234:2')
    // Merged on GitHub already: never edited, the merge step records it.
    const merged = pr({ baseRefName: 'main', headRefOid: 'later', merged: true, statusCheckRollup: [] })
    expect(nextMove(facts({ pr: merged, task: task({ step: step(2) }) }))).toBeUndefined()
    const mergedMove = { key: 'merged:https://gh/pr/7', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } }
    expect(nextMove(facts({ pr: { ...merged, baseRefName: 'v3' } }))).toEqual(mergedMove)
    // Merged by hand after the step's own attempt was refused at this head: recorded all the same.
    expect(nextMove(facts({ pr: { ...merged, baseRefName: 'v3' }, task: task({ mech: { 'merge:abc1234': 1 } }) }))).toEqual(mergedMove)
    expect(nextMove(facts({ task: task({ step: step(1) }), pr: pr({ baseRefName: 'main' }) }))).toBeUndefined()
  })

  it('catches up a branch behind its target, never while the agent works nor on a protected branch', () => {
    const behind = pr({ mergeStateStatus: 'BEHIND' })
    expect(nextMove(facts({ pr: behind }))).toEqual({ key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } })
    expect(nextMove(facts({ pr: behind, agentBusy: true }))).toBeUndefined()
    expect(nextMove(facts({ pr: behind, branch: 'main' }))?.move.kind).not.toBe('catch-up')
  })

  it('re-runs CI once when it failed for infrastructure reasons', () => {
    const f = facts({ pr: pr({ statusCheckRollup: red('CANCELLED') }) })
    expect(nextMove(f)).toEqual({ key: 'rerun:abc1234', move: { kind: 'rerun-ci', checks: ['e2e'] } })
    expect(nextMove({ ...f, task: task({ mech: { 'rerun:abc1234': 1 } }) })).toBeUndefined()
    // Still running: wait.
    expect(nextMove(facts({ pr: pr({ statusCheckRollup: [{ name: 'e2e', status: 'IN_PROGRESS' }, ...red('FAILURE', 'unit')] }) }))).toBeUndefined()
  })

  it('sends red CI back to the agent once per commit, within the rounds', () => {
    const f = facts({ pr: pr({ statusCheckRollup: [...red('FAILURE', 'unit'), ...red('CANCELLED')] }) })
    expect(nextMove(f)).toEqual({ key: 'red:abc1234', move: { kind: 'ci-to-agent', checks: ['unit', 'e2e'] } })
    expect(nextMove({ ...f, agentBusy: true })).toBeUndefined()
    expect(nextMove({ ...f, task: task({ mech: { 'red:abc1234': 1 } }) })).toBeUndefined()
    expect(nextMove({ ...f, task: task({ mech: { 'red:a': 1, 'red:b': 1 } }) })).toBeUndefined()
    expect(redCiText(['unit'], 'abc1234ffff')).toMatch(/^CI failed on unit \(commit abc1234\)/)
  })

  it('merges what the branch rule gives the engine, never a protected branch', () => {
    expect(nextMove(facts())).toEqual({ key: 'merge:abc1234', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } })
    // The user's rule for other branches.
    const userOnly = combineGuards([{ source: 'project', guards: { merge: { others: 'user' } } }])
    expect(nextMove(facts({ guards: userOnly }))).toBeUndefined()
    // A protected base, even with a rule that says engine.
    const loose = combineGuards([{ source: 'project', guards: { protected: ['v3'], merge: { protected: 'engine', others: 'engine' } } }])
    expect(nextMove(facts({ guards: loose }))).toBeUndefined()
    const guardedPlan = plan.map(s => (s.id === 'merge' ? { ...s, guarded: true as const } : s))
    expect(nextMove(facts({ plan: guardedPlan }))).toBeUndefined()
    // Checks not green, or not at the merge step.
    expect(nextMove(facts({ pr: pr({ statusCheckRollup: [{ name: 'unit', status: 'QUEUED' }] }) }))).toBeUndefined()
    expect(nextMove(facts({ task: task({ step: step(2, { acting: true }) }) }))).toBeUndefined()
  })
})

describe('what a task waits for', () => {
  it('reads the agent\'s report label, else a permission prompt; a login failure is told apart', async () => {
    const { waitOf, isAuthFailure } = await import('../shared/pm/run')
    expect(waitOf({ labels: { 'wherdr.report': 'blocked:question' }, status: { state: 'idle' } })).toBe('question')
    expect(waitOf({ labels: { 'wherdr.report': 'blocked:auth' } })).toBe('auth')
    expect(waitOf({ status: { state: 'blocked' } })).toBe('permission')
    expect(waitOf({ labels: { 'wherdr.report': 'done' }, status: 'working' })).toBeUndefined()
    expect(isAuthFailure('Invalid API key · Please run /login')).toBe(true)
    expect(isAuthFailure('Error: ENOENT')).toBe(false)
  })

  it('syncWaits: a task waits with the kind its terminal shows, and works again once it is gone', async () => {
    const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
    const { createPmStore } = await import('../server/utils/pmStore')
    const { syncWaits } = await import('../server/utils/pmMechanic')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-mech-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'CO', machine: '', path: '/src', addedAt: 1 }] }))
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
      await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: 'host/t3', attempt: 1, state: 'running', startedAt: 1 })
      await store.saveTask({ ...t, state: 'working', run: 'r1' })
      let term: Record<string, unknown> = { address: 'host/t3', status: { state: 'blocked' } }
      const deps = { store, call: async () => ({ terminals: [term] }) } as unknown as Parameters<typeof syncWaits>[0]
      await syncWaits(deps)
      expect(await store.task(t.id)).toMatchObject({ state: 'waiting', waitKind: 'permission' })
      term = { address: 'host/t3', status: { state: 'working' } }
      await syncWaits(deps)
      expect((await store.task(t.id))!.state).toBe('working')
      term = { address: 'host/t3', labels: { 'wherdr.report': 'blocked:question' }, status: { state: 'idle' } }
      await syncWaits(deps)
      expect(await store.task(t.id)).toMatchObject({ state: 'waiting', waitKind: 'question', waiting: 'The agent asks a question' })
      // A permission says what is asked, as herdr-core reads it.
      await store.saveTask({ ...(await store.task(t.id))!, state: 'working', waitKind: undefined, waiting: undefined })
      term = { address: 'host/t3', status: { state: 'blocked', msg: 'approve Bash: npm test' } }
      await syncWaits(deps)
      expect(await store.task(t.id)).toMatchObject({ waitKind: 'permission', waiting: 'approve Bash: npm test' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('syncWaits answers the trust dialog of the task\'s own worktree once, and no other dialog', async () => {
    const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
    const { createPmStore } = await import('../server/utils/pmStore')
    const { syncWaits } = await import('../server/utils/pmMechanic')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-mech-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'CO', machine: '', path: '/src', addedAt: 1 }] }))
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
      const run = (id: string, terminal: string, worktree: string) => ({ id, task: t.id, role: 'worker' as const, program: 'claude', model: 'opus', machine: '', worktree, branch: 'b', instructions: '', terminal, attempt: 1, state: 'running' as const, startedAt: Date.now() })
      await store.saveRun(run('r2', 'h/t4', '/home/u/.wherdr/pm/worktrees/CO-1'))
      await store.saveRun(run('r3', 'h/t5', '/home/u/.wherdr/pm/worktrees/CO-9'))
      await store.saveTask({ ...t, state: 'working', run: 'r2' })
      const screen: Record<string, string> = {
        'h/t4': 'Accessing workspace:\n /home/u/.wherdr/pm/worktrees/CO-1\n ❯ No, exit\n   Yes, I trust this folder',
        'h/t5': 'Accessing workspace:\n /home/u/elsewhere\n ❯ No, exit\n   Yes, I trust this folder',
      }
      const keys: unknown[] = []
      const call = async (method: string, p: { terminal: string, keys?: string[] }) => {
        if (method === 'terminal.list') return { terminals: [{ address: 'h/t4', status: null }, { address: 'h/t5', status: null }] }
        if (method === 'terminal.read') return { text: screen[p.terminal] }
        if (method === 'terminal.keys') keys.push([p.terminal, p.keys])
        return {}
      }
      const deps = { store, call } as unknown as Parameters<typeof syncWaits>[0]
      await syncWaits(deps)
      await syncWaits(deps)
      expect(keys).toEqual([['h/t4', ['down', 'enter']]])
      expect((await store.task(t.id))!.log?.at(-1)?.text).toBe('trusted the task\'s worktree for the worker (/home/u/.wherdr/pm/worktrees/CO-1)')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
