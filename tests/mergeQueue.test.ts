import { describe, expect, it } from 'vitest'
import { inMergeQueue, mergeAfterWake, mergeOrder, ordinal, queueOut } from '../shared/pm/mergeQueue'
import { idleSince } from '../shared/pm/release'
import { catchUpGaveUp, nextMove, type MechFacts, type PrState } from '../shared/pm/mechanic'
import { combineGuards } from '../shared/pm/guards'
import { cardStatus, statusText } from '../shared/pm/board'
import type { PlannedStep, StepState } from '../shared/pm/steps'
import type { Task } from '../shared/pm/run'

const plan: PlannedStep[] = [
  { id: 'work', holder: 'worker', ends: 'report', text: '' },
  { id: 'pr', ends: 'action', action: { kind: 'github.pr', base: 'v3' }, text: '' },
  { id: 'merge', ends: 'action', action: { kind: 'github.merge' }, text: '' },
]
const guards = combineGuards([{ source: 'project', guards: { protected: ['main'], merge: { others: 'engine' } } }])
const step = (more: Partial<StepState> = {}): StepState => ({ at: 2, started: true, proofs: {}, rounds: {}, ...more })
const task = (more: Partial<Task> = {}): Task => ({ id: 'CO-1', project: 'CO', title: 'Fix', description: '', type: 'feature', state: 'working', run: 'r1', createdAt: 0, step: step(), ...more })
const pr = (more: Partial<PrState> = {}): PrState => ({ url: 'https://gh/pr/7', baseRefName: 'v3', headRefOid: 'abc1234', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...more })
const facts = (more: Partial<MechFacts> = {}): MechFacts => ({ task: task(), plan, guards, branch: 'task/CO-1', agentBusy: false, head: 'abc1234', pr: pr(), ...more })

describe('merge queue', () => {
  it('holds the tasks whose merge goes on: engine merges and approved waiting merges', () => {
    expect(inMergeQueue(task(), plan, guards, pr())).toBe(true)
    expect(inMergeQueue(task({ state: 'waiting' }), plan, guards, pr())).toBe(false)
    expect(inMergeQueue(task(), plan, guards, pr({ merged: true }))).toBe(false)
    const visual = plan.map(s => (s.id === 'merge' ? { ...s, ends: 'user' as const, guarded: true as const } : s))
    expect(inMergeQueue(task(), visual, guards, pr())).toBe(false)
    expect(inMergeQueue(task({ step: step({ approved: { by: 'user', at: 1 } }) }), visual, guards, pr())).toBe(true)
  })

  it('lines up the PRs ready now, touching no shared file first, then smaller diffs; those that need work step out', () => {
    const e = (id: string, files: string[], size: number, more = {}) => ({ id, files, size, ...more })
    const entries = [e('A', ['x.ts'], 10), e('B', ['x.ts', 'y.ts'], 5), e('C', ['z.ts'], 50), e('D', ['w.ts'], 20)]
    expect(mergeOrder(entries)).toEqual(['D', 'C', 'B', 'A'])
    expect(mergeOrder(entries.map(x => (x.id === 'D' ? { ...x, out: 'conflict with its base' } : x)))).toEqual(['C', 'B', 'A', 'D'])
    // The coordinator's board order (task order) comes before files and size, among PRs in line.
    expect(mergeOrder(entries.map(x => ({ ...x, ...({ A: { order: -2 }, B: { order: -1 } } as Record<string, object>)[x.id] })))).toEqual(['A', 'B', 'D', 'C'])
    expect(mergeOrder(entries.map(x => (x.id === 'A' ? { ...x, order: -1, out: 'checks failed' } : x)))).toEqual(['D', 'C', 'B', 'A'])
    expect([1, 2, 3, 4, 11, 12, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '21st', '22nd'])
    // Why a PR is out of line; ready: none.
    const out = (more: Partial<MechFacts>) => queueOut(facts(more))
    expect(out({})).toBeUndefined()
    expect(out({ pr: pr({ mergeStateStatus: 'DIRTY' }) })).toBe('conflict with its base')
    expect(out({ pr: pr({ mergeStateStatus: 'BEHIND' }) })).toBe('updating with v3')
    expect(out({ pr: pr({ statusCheckRollup: [{ name: 'unit', status: 'IN_PROGRESS' }] }) })).toBe('waiting for its checks')
    expect(out({ pr: pr({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }) })).toBe('checks failed')
    expect(out({ task: task({ step: step({ agent: { kind: 'catch-up', head: 'abc1234', at: 0 } }) }) })).toBe('its agent resolves a conflict with the base')
  })

  it('a conflicting PR does not block a clean one; a clean green PR merges without an update unless GitHub requires it', () => {
    const merge = { key: 'merge:abc1234', move: { kind: 'merge', url: 'https://gh/pr/7', base: 'v3' } }
    const catchUp = { key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } }
    // A conflicting PR steps out: it is updated (its agent gets the conflict) whatever its place, and never merges meanwhile.
    const dirty = pr({ mergeStateStatus: 'DIRTY' })
    expect(mergeOrder([{ id: 'A', files: ['x.ts'], size: 1, out: queueOut(facts({ pr: dirty })) }, { id: 'B', files: ['y.ts'], size: 9 }])).toEqual(['B', 'A'])
    expect(nextMove(facts({ queue: 2, queueOut: 'conflict with its base', pr: dirty }))).toEqual(catchUp)
    // The clean one, first in line: merges at once, without an update GitHub does not require.
    expect(nextMove(facts({ queue: 1 }))).toEqual(merge)
    expect(nextMove(facts({ queue: 1, pr: pr({ mergeStateStatus: 'UNSTABLE' }) }))).toEqual(merge)
    // Behind when the branch rules require it: updated, every such PR in the same pass, whatever its place.
    expect(nextMove(facts({ queue: 3, queueOut: 'updating with v3', pr: pr({ mergeStateStatus: 'BEHIND' }) }))).toEqual(catchUp)
    // A merge refused at its commit, or green yet blocked by the branch rules: out of line, so the clean one behind it comes first.
    const policy = 'merge: base branch policy prohibits the merge'
    const refused = task({ mech: { 'merge:abc1234': 0 }, step: step({ yourTurn: { reason: 'action', badge: policy, error: policy } }) })
    const blocked = pr({ mergeStateStatus: 'BLOCKED' })
    expect(queueOut(facts({ task: refused, pr: blocked }))).toBe(`merge refused: ${policy}`)
    expect(queueOut(facts({ pr: blocked }))).toBe('blocked by the branch rules')
    expect(mergeOrder([{ id: 'A', files: ['x.ts'], size: 1, out: queueOut(facts({ task: refused, pr: blocked })) }, { id: 'B', files: ['y.ts'], size: 9 }])).toEqual(['B', 'A'])
    // A new commit since the refusal: back in line.
    expect(queueOut(facts({ task: refused, head: 'def5678', pr: pr({ headRefOid: 'def5678' }) }))).toBeUndefined()
    // Ready, but not first: waits one turn.
    expect(nextMove(facts({ queue: 2 }))).toBeUndefined()
    // Red: back to its worker as red CI, not to the user.
    const red = pr({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    expect(nextMove(facts({ queue: 2, queueOut: 'checks failed', pr: red }))?.move).toEqual({ kind: 'ci-to-agent', checks: ['unit'] })
  })

  it('releases the agents of a task waiting in the queue, not while its agent holds work', () => {
    expect(idleSince(undefined, task({ queue: 2 }), false, 10)).toBe(10)
    expect(idleSince(undefined, task({ queue: 2, step: step({ agent: { kind: 'catch-up', head: 'abc1234', at: 0 } }) }), false, 10)).toBeUndefined()
    expect(idleSince(undefined, task(), false, 10)).toBeUndefined()
  })

  it('tries a failed update again, spaced out, then stops updating that commit', () => {
    const at = (mech: Record<string, number>, more: Partial<MechFacts> = {}) => nextMove(facts({ queue: 1, pr: pr({ mergeStateStatus: 'BEHIND' }), now: 10 * 60_000, task: task({ mech }), ...more }))
    // Too soon after the failed try, or its agent holds a conflict: it waits.
    expect(at({ 'catch-up:abc1234': 9 * 60_000 })).toBeUndefined()
    expect(at({ 'catch-up:abc1234': 0 }, { task: task({ mech: { 'catch-up:abc1234': 0 }, step: step({ agent: { kind: 'catch-up', head: 'abc1234', at: 0 } }) }) })).toBeUndefined()
    expect(at({ 'catch-up:abc1234': 0 })).toEqual({ key: 'catch-up:abc1234:2', move: { kind: 'catch-up', base: 'v3' } })
    expect(at({ 'catch-up:abc1234': 0, 'catch-up:abc1234:2': 0 })?.key).toBe('catch-up:abc1234:3')
    // Past its tries: no more updates of that commit; it merges as GitHub allows.
    const spent = { 'catch-up:abc1234': 0, 'catch-up:abc1234:2': 0, 'catch-up:abc1234:3': 0 }
    expect(catchUpGaveUp(task({ mech: spent }), 'abc1234')).toBe(true)
    expect(at(spent, { pr: pr({ mergeStateStatus: 'UNKNOWN' }) })?.move.kind).toBe('merge')
  })

  it('a PR merging after other tasks waits out of line until they are done; a stopped one wakes the coordinator once', () => {
    const waiting = task({ mergeAfter: 'LED-4' })
    const led = (more: Partial<Task> = {}) => task({ id: 'LED-4', project: 'LED', ...more })
    const out = (up: Task) => queueOut(facts({ task: waiting }), [up])
    // Merged but its deploy still watched: not done yet. Others in its queue merge meanwhile.
    expect(out(led({ step: step({ at: 3 }) }))).toBe('waits for LED-4 to be done')
    expect(mergeOrder([{ id: 'CO-1', files: ['x.ts'], size: 1, out: out(led()) }, { id: 'CO-2', files: ['y.ts'], size: 9 }])).toEqual(['CO-2', 'CO-1'])
    expect(nextMove(facts({ task: waiting, queue: 2, queueOut: out(led()) }))).toBeUndefined()
    // New commits not on the PR yet: not pushed either, since the merge step would push and merge at once.
    const unpushed = facts({ task: waiting, head: 'def5678' })
    expect(queueOut(unpushed, [led()])).toBe('waits for LED-4 to be done')
    expect(nextMove({ ...unpushed, queue: 1, queueOut: queueOut(unpushed, [led()]) })?.move.kind).not.toBe('merge')
    // Its whole workflow done (merged, deploy watched): it goes.
    expect(out(led({ step: step({ done: true }) }))).toBeUndefined()
    // Stopped or abandoned: it keeps waiting; its coordinator is woken once per stop.
    const stopped = led({ stopped: { by: 'user', why: 'wrong approach', at: 5 } })
    expect(out(led({ step: step({ done: true, abandoned: true }) }))).toBe('waits for LED-4 to be done')
    expect(mergeAfterWake(waiting, [led()])).toBeUndefined()
    const wake = mergeAfterWake(waiting, [stopped])!
    expect(wake.key).toBe('merge-after:LED-4:5')
    expect(mergeAfterWake(task({ mergeAfter: 'LED-4', mech: { [wake.key]: 6 } }), [stopped])).toBeUndefined()
  })

  it('shows its place on the card, and a refused merge waiting its turn is not the user\'s', () => {
    const refused = step({ yourTurn: { reason: 'action', badge: 'merge: the PR conflicts with v3', error: 'merge: the PR conflicts with v3' } })
    expect(cardStatus({ plan, state: refused, prNow: 'conflict', queue: 2 })?.text).toBe('2nd in merge queue')
    expect(statusText(cardStatus({ plan, state: step({ approved: { by: 'user', at: 1 } }), queue: 3 })!, String)).toBe('Approved, merges by itself · 3rd in merge queue')
    expect(cardStatus({ plan, state: refused, prNow: 'conflict', queue: 1, queueOut: 'conflict with its base' })?.text).toBe('in merge queue, out of line: conflict with its base')
  })
})
