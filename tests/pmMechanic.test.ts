import { describe, expect, it } from 'vitest'
import { nextMove, redCiText, type MechFacts, type PrState } from '../shared/pm/mechanic'
import { combineGuards } from '../shared/pm/guards'
import { caughtUpSettled, onEvent, SETTLE_MS, type PlannedStep, type StepState } from '../shared/pm/steps'
import { boardLanes, cardOf, cardStatus, mayAccept, statusText, toHandle } from '../shared/pm/board'
import { inMergeQueue } from '../shared/pm/mergeQueue'
import { agentBack, handToAgent } from '../shared/pm/release'
import { addShot } from '../shared/pm/shots'
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
    // Refused as behind its remote: synced first (selfFix.ts), not tried again as is.
    expect(nextMove(facts({ task: failed('push: rejected (non-fast-forward)') }))?.move.kind).toBe('sync-push')
    expect(nextMove(facts({ task: failed('push: remote end hung up', 3) }))).toBeUndefined()
    const guarded = plan.map(s => (s.id === 'push' ? { ...s, guarded: true as const } : s))
    expect(nextMove(facts({ task: failed('push: remote end hung up'), plan: guarded }))).toBeUndefined()
  })

  it('fixes the base of a PR opened against the wrong branch', () => {
    expect(nextMove(facts({ pr: pr({ baseRefName: 'main' }) }))).toEqual({ key: 'base:abc1234', move: { kind: 'fix-base', base: 'v3' } })
    // Not the task's commit, and not the engine's to merge (main, or a merge waiting for the user):
    // only a head GitHub's Update branch made is taken in (pmActions takeUpdate), once per head.
    expect(nextMove(facts({ pr: pr({ baseRefName: 'main', headRefOid: 'other' }) }))).toEqual({ key: 'update:other', move: { kind: 'take-update' } })
    expect(nextMove(facts({ pr: pr({ baseRefName: 'main', headRefOid: 'other' }), task: task({ mech: { 'update:other': 1 } }) }))).toBeUndefined()
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
    // A guarded merge into main the guard refused, merged by the user on GitHub: recorded too.
    const guarded = plan.map(s => (s.id === 'merge' ? { ...s, guarded: true as const } : s))
    const refused = task({ step: step(3, { yourTurn: { reason: 'action', badge: 'merge: main is protected: only you may merge into it' } }) })
    expect(nextMove(facts({ plan: guarded, task: refused, pr: merged }))).toEqual({ ...mergedMove, move: { ...mergedMove.move, base: 'main' } })
  })

  it('catches up a branch behind its target, never while the agent works nor on a protected branch', () => {
    const behind = pr({ mergeStateStatus: 'BEHIND' })
    expect(nextMove(facts({ pr: behind }))).toEqual({ key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } })
    expect(nextMove(facts({ pr: behind, agentBusy: true }))).toBeUndefined()
    expect(nextMove(facts({ pr: behind, branch: 'main' }))?.move.kind).not.toBe('catch-up')
  })

  describe('a merge step waiting for the user', () => {
    const visual: PlannedStep[] = [
      { id: 'work', holder: 'worker', ends: 'report', text: '' },
      { id: 'pr', ends: 'action', action: { kind: 'github.pr', base: 'v3' }, text: '' },
      { id: 'review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', text: '' },
      { id: 'merge', ends: 'user', userLabel: 'Merge', badge: 'Look, then merge', action: { kind: 'github.merge' }, text: '', guarded: true },
    ]
    const waiting = step(3, { proofs: { review: { commit: 'abc1234' } }, yourTurn: { reason: 'user', badge: 'Look, then merge' } })
    const at = (st: StepState, more: Partial<MechFacts> = {}) => facts({ plan: visual, task: task({ step: st }), ...more })
    const status = (st: StepState) => { const s = cardStatus({ plan: visual, state: st, prNow: 'ready to merge' }); return s && statusText(s, String, true) }

    it('catches up a conflicting PR at once, one at a time, then hands it back to the user', () => {
      expect(nextMove(at(waiting))).toBeUndefined()
      const dirty = pr({ mergeStateStatus: 'DIRTY' })
      expect(nextMove(at(waiting, { pr: dirty }))).toEqual({ key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } })
      const up = onEvent(visual, waiting, { kind: 'catch-up', base: 'v3', head: 'abc1234' }, 5).state
      expect(up.yourTurn).toBeUndefined()
      expect(status(up)).toBe('updating with v3')
      // A second catch-up is refused while one runs; the conflict sent to the agent waits for its commit.
      expect(onEvent(visual, up, { kind: 'catch-up', base: 'v3', head: 'abc1234' }, 6).refused).toBeTruthy()
      const sent = { mech: { 'catch-up:abc1234': 1 } }
      expect(nextMove(at(up, { pr: dirty, now: 60_000, task: task({ step: up, ...sent }) }))).toBeUndefined()
      expect(nextMove(at(up, { head: 'def5678', agentBusy: true, task: task({ step: up, ...sent }) }))).toBeUndefined()
      expect(nextMove(at(up, { head: 'def5678', task: task({ step: up, ...sent }) }))?.key).toBe('catch-up:def5678')
      // Its conflict reached no worker (it could not start): tried again, spaced out; handed, it waits for the worker.
      expect(nextMove(at(up, { pr: dirty, now: 3 * 60_000, task: task({ step: up, ...sent }) }))?.key).toBe('catch-up:abc1234:2')
      expect(nextMove(at({ ...up, agent: { kind: 'catch-up', at: 1 } }, { pr: dirty, now: 3 * 60_000, task: task({ step: { ...up, agent: { kind: 'catch-up', at: 1 } }, ...sent }) }))).toBeUndefined()
      // The agent's resolution is reviewed again; a clean merge of the base is not, and the user's turn comes back.
      expect(onEvent(visual, up, { kind: 'caught-up', head: 'fff0000', review: { since: 'abc1234', head: 'fff0000' } }, 7).state).toMatchObject({ at: 2, rereview: { since: 'abc1234' } })
      const clean = onEvent(visual, up, { kind: 'caught-up', head: 'fff0000' }, 7).state
      expect(clean).toMatchObject({ at: 3, yourTurn: { reason: 'user' }, proofs: { review: { commit: 'fff0000' } } })
      expect(clean.catchUp).toBeUndefined()
      // Updated on GitHub while it waits: taken in and pushed, not left to the merge.
      expect(nextMove(at(waiting, { pr: pr({ headRefOid: 'gh00000' }) }))).toEqual({ key: 'update:gh00000', move: { kind: 'take-update' } })
    })

    it('leaves Your turn while its conflicting PR is updated, until GitHub reads it clean', () => {
      const T = Date.now()
      const card = (st: StepState, now: number, prNow = 'conflict with its base') => ({ ...cardOf(task({ step: st }), visual, [], now), prNow })
      const off = (c: ReturnType<typeof card>) => {
        expect(c.yourTurn).toBeUndefined()
        expect(toHandle([c])).toEqual([])
        expect(boardLanes([c], ['Merging'])[0]!.cards).toEqual([])
      }
      const line = (c: ReturnType<typeof card>) => statusText(cardStatus(c)!, String)
      expect(card(waiting, T).yourTurn).toBe('Look, then merge')
      const up = onEvent(visual, waiting, { kind: 'catch-up', base: 'v3', head: 'abc1234' }, T).state
      off(card(up, T))
      expect(line(card(up, T))).toBe('updating with v3')
      // Its conflict handed to the worker: the worker's, said so; waiting for its worker, the user's.
      const handed = { ...up, agent: { kind: 'catch-up', at: T } }
      off(card(handed, T))
      expect(line(card(handed, T))).toBe('the worker is solving a conflict with v3')
      expect(cardStatus(card({ ...handed, agent: { ...handed.agent, waits: 'Waits for its machine (offline)' } }, T))?.tone).toBe('bad')
      // Its live worker asks the user a permission while it solves the conflict: Your turn.
      const asking = { ...cardOf(task({ step: handed, state: 'waiting', waitKind: 'permission', waiting: 'Allow git merge?' }), visual, [], T), prNow: 'conflict with its base' }
      expect(boardLanes([asking], null)[0]!.cards).toEqual([asking])
      expect(toHandle([asking])).toHaveLength(1)
      // Updated cleanly: still off while GitHub reads the old conflict, never the red line.
      const clean = onEvent(visual, up, { kind: 'caught-up', head: 'fff0000' }, T).state
      off(card(clean, T))
      expect(line(card(clean, T))).toBe('updated with v3, GitHub is checking it')
      // Read clean at the new commit (or past SETTLE_MS): the engine clears it and the user's turn is back.
      expect(caughtUpSettled(clean.caughtUp!, pr({ headRefOid: 'fff0000', mergeStateStatus: 'DIRTY' }), T)).toBe(false)
      expect(caughtUpSettled(clean.caughtUp!, pr({ headRefOid: 'fff0000' }), T)).toBe(true)
      expect(caughtUpSettled(clean.caughtUp!, undefined, T + SETTLE_MS)).toBe(true)
      const { caughtUp: _, ...settled } = clean
      const back = card(settled, T, 'ready to merge')
      expect(back.yourTurn).toBe('Look, then merge')
      expect(boardLanes([back], ['Merging'])[0]!.cards).toEqual([back])
    })

    it('accepts in any PR state: the task leaves Your turn, enters the queue, and comes back only when the engine cannot go on', () => {
      const T = Date.now()
      const accept = (st: StepState) => { const r = onEvent(visual, st, { kind: 'user' }, T); expect(r.refused).toBeUndefined(); return r }
      const card = (st: StepState, prNow: string) => ({ ...cardOf(task({ step: st }), visual, [], T), prNow })
      const dirty = pr({ mergeStateStatus: 'DIRTY' })
      // In conflict, being updated (no Your turn, Accept still offered); its worker solving it; behind; red checks handed to the worker.
      const updating = onEvent(visual, waiting, { kind: 'catch-up', base: 'v3', head: 'abc1234' }, T).state
      const solving = handToAgent(updating, 'catch-up', 'abc1234', T)
      const red = handToAgent(waiting, 'ci-to-agent', 'abc1234', T)
      for (const [st, prNow] of [[waiting, 'conflict with its base'], [updating, 'conflict with its base'], [solving, 'conflict with its base'], [waiting, 'behind its base'], [red, 'checks failed (smoke)']] as const) {
        expect(mayAccept(card(st, prNow))).toBe(true)
        const r = accept(st)
        // Recorded at the reviewed commit, no merge attempted by the click: the queue merges it in its own order.
        expect(r.state).toMatchObject({ approved: { by: 'user', at: T, commit: 'abc1234' }, yourTurn: undefined })
        expect(r.effects).toEqual([])
        const c = card(r.state, prNow)
        expect(c.yourTurn).toBeUndefined()
        expect(toHandle([c])).toEqual([])
        expect(mayAccept(c)).toBe(false)
        expect(inMergeQueue(task({ step: r.state }), visual, guards, dirty)).toBe(true)
      }
      // Off the Your turn lane; the handed work coming in does not bring the user's turn back.
      const accepted = accept(solving).state
      expect(boardLanes([card(accepted, 'conflict with its base')], null)[0]!.cards).toEqual([])
      expect(agentBack(accepted).yourTurn).toBeUndefined()
      expect(nextMove(at(agentBack(accepted), { pr: dirty }))).toEqual({ key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } })
      // Back only when the engine cannot go on: the worker could not solve its conflict.
      const gaveUp = card({ ...accepted, agent: { ...accepted.agent!, waits: 'Waits for its machine (offline)', told: 'user' } }, 'conflict with its base')
      expect(gaveUp.yourTurn).toBe('Waits for its machine (offline)')
      expect(boardLanes([gaveUp], ['Merging'])[0]!.cards).toEqual([gaveUp])
    })

    it('keeps the user\'s approval through a refused merge, then merges by itself once ready', () => {
      const clicked = { ...onEvent(visual, waiting, { kind: 'user' }, 10).state, acting: true }
      expect(clicked.approved).toEqual({ by: 'user', at: 10, commit: 'abc1234' })
      // The engine running the step again is no approval.
      expect(onEvent(visual, waiting, { kind: 'user', engine: true }, 10).state.approved).toBeUndefined()
      const refused = onEvent(visual, clicked, { kind: 'action-result', ok: false, error: 'merge: the PR conflicts with v3', catchUp: { base: 'v3', head: 'abc1234' } }, 11).state
      expect(refused).toMatchObject({ acting: undefined, yourTurn: undefined, catchUp: { base: 'v3', from: 'abc1234' } })
      expect(status(refused)).toBe('Approved on 10, merges by itself · updating with v3')
      const clean = onEvent(visual, refused, { kind: 'caught-up', head: 'fff0000' }, 12).state
      expect(clean.yourTurn).toBeUndefined()
      expect(nextMove(at(clean, { head: 'fff0000', pr: pr({ headRefOid: 'fff0000' }) }))).toEqual({ key: 'merge:fff0000', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } })
      // A conflict resolution passes its short re-review and keeps the approval.
      const review = onEvent(visual, refused, { kind: 'caught-up', head: 'fff0000', review: { since: 'abc1234', head: 'fff0000' } }, 12).state
      const passed = onEvent(visual, review, { kind: 'verdict', from: 'reviewer', findings: [{ id: 'f1', severity: 'minor', title: 'a name' }], head: 'fff0000' }, 13).state
      expect(passed).toMatchObject({ at: 3, approved: { at: 10 }, yourTurn: undefined })
      // The merge finds the task's interface files changed since the approval: the user looks again.
      const ui = onEvent(visual, { ...passed, acting: true }, { kind: 'action-result', ok: false, error: 'merge: the interface changed', unapproved: true }, 14).state
      expect(ui).toMatchObject({ at: 3, acting: undefined, approved: undefined, yourTurn: { reason: 'user', badge: 'Look again, then merge: the interface changed' } })
      // A Send back after the click drops the approval: the reworked task waits for the user again.
      const failed = onEvent(visual, clicked, { kind: 'action-result', ok: false, error: 'merge: 1 check(s) failed' }, 14).state
      const sentBack = onEvent(visual, failed, { kind: 'back', note: 'make the button blue' }, 15)
      expect(sentBack.state).toMatchObject({ at: 0, approved: undefined })
      expect(sentBack.effects).toContainEqual({ kind: 'log', text: 'merge: sent back by the user, approval dropped. make the button blue' })
    })

    it('keeps the approval through a red CI fix; new screenshots drop it', () => {
      const shotsPlan = visual.map(p => (p.id === 'work' ? { ...p, evidence: ['screenshots' as const] } : p))
      const clicked = { ...onEvent(shotsPlan, { ...waiting, shots: { work: [{ file: 'a.png', phase: 'after', at: 1 }] } }, { kind: 'user' }, 10).state, acting: true }
      // Red CI goes back to the worker; fixed, reviewed again, the merge waits for no one.
      const red = onEvent(shotsPlan, clicked, { kind: 'action-result', ok: false, error: 'CI failed', toAgent: true }, 11).state
      expect(red).toMatchObject({ at: 0, approved: { at: 10 } })
      const ev = (st: StepState, e: Parameters<typeof onEvent>[2]) => onEvent(shotsPlan, st, e, 12).state
      const toMerge = (st: StepState) => ev(ev(ev(st, { kind: 'report', from: 'worker' }), { kind: 'action-result', ok: true }), { kind: 'verdict', from: 'reviewer', findings: [] })
      const reviewed = toMerge(red)
      expect(reviewed).toMatchObject({ at: 3, approved: { at: 10 }, yourTurn: undefined })
      // A new screenshot from the worker: the merge waits for the user's look again.
      const shot = addShot(shotsPlan, red, { file: 'b.png', phase: 'after', at: 12 })
      expect('state' in shot && shot.state.approved).toBeUndefined()
      expect(toMerge('state' in shot ? shot.state : red)).toMatchObject({ at: 3, yourTurn: { reason: 'user' } })
    })
  })

  it('re-runs CI once when it failed for infrastructure reasons, then sends it to the agent', () => {
    const f = facts({ pr: pr({ statusCheckRollup: red('CANCELLED') }) })
    expect(nextMove(f)).toEqual({ key: 'rerun:abc1234', move: { kind: 'rerun-ci', checks: ['e2e'] } })
    expect(nextMove({ ...f, task: task({ mech: { 'rerun:abc1234': 1 } }) })?.move.kind).toBe('ci-to-agent')
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

  it('merges what the guards give the engine, a protected branch only when they say engine', () => {
    expect(nextMove(facts())).toEqual({ key: 'merge:abc1234', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } })
    // The user's rule for other branches.
    const userOnly = combineGuards([{ source: 'project', guards: { merge: { others: 'user' } } }])
    expect(nextMove(facts({ guards: userOnly }))).toBeUndefined()
    // A protected base: the user's by default, the engine's when the guards say so.
    expect(nextMove(facts({ guards: combineGuards([{ source: 'project', guards: { protected: ['v3'] } }]) }))).toBeUndefined()
    const loose = combineGuards([{ source: 'project', guards: { protected: ['v3'], merge: { protected: 'engine' } } }])
    expect(nextMove(facts({ guards: loose }))?.move.kind).toBe('merge')
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
      // The agent's conversation, for the question's text.
      const panes = () => [{ id: 'w1:p1', coreAddress: 'host/t3' }], chat = async () => [{ role: 'assistant', text: 'Two options.\nPostgres or SQLite?', ts: null }]
      const deps = { store, call: async () => ({ terminals: [term] }), panes, chat } as unknown as Parameters<typeof syncWaits>[0]
      await syncWaits(deps)
      expect(await store.task(t.id)).toMatchObject({ state: 'waiting', waitKind: 'permission' })
      term = { address: 'host/t3', status: { state: 'working' } }
      await syncWaits(deps)
      expect((await store.task(t.id))!.state).toBe('working')
      term = { address: 'host/t3', labels: { 'wherdr.report': 'blocked:question' }, status: { state: 'idle' } }
      await syncWaits(deps)
      expect(await store.task(t.id)).toMatchObject({ state: 'waiting', waitKind: 'question', waiting: 'The agent asks a question: Two options. Postgres or SQLite?', question: 'Two options.\nPostgres or SQLite?' })
      // A question waiting from before the whole message was kept: read once more.
      await store.saveTask({ ...(await store.task(t.id))!, question: undefined })
      await syncWaits(deps)
      expect((await store.task(t.id))!.question).toBe('Two options.\nPostgres or SQLite?')
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

it('keeps an agent\'s whole question; a huge one cut in its middle, its question and choices kept', async () => {
  const { askedQuestion, QUESTION_MAX } = await import('../server/utils/pmRead')
  const ask = (text: string) => askedQuestion({ panes: () => [{ id: 'p', coreAddress: 't' }], chat: async () => [{ role: 'assistant', text, ts: null }] } as never, 't')
  const end = 'Should I continue?\n\n```wherdr\nchoices "Yes" | "No"\n```'
  const long = `${'context line\n'.repeat(1200)}${end}`
  expect((await ask(long))!.full).toBe(long)
  const huge = (await ask(`Start.\n${'x'.repeat(QUESTION_MAX)}\n${end}`))!.full
  expect([huge.startsWith('Start.'), huge.endsWith(end), huge.includes('[…]'), huge.length < QUESTION_MAX + 20]).toEqual([true, true, true, true])
})
