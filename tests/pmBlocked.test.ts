import { expect, it } from 'vitest'
import { github, wherdr } from '../shared/pm/examples'
import { durationMs, onEvent, planSteps, type StepState } from '../shared/pm/steps'
import { awaitsHolder, backToWork, failingTests, HANDLE_AFTER_MS, IDLE_WAIT_MS, RED_CI_WAIT_MS, RESTART_AFTER_MS, stallMoves, stallOf } from '../shared/pm/blocked'
import { DEFAULT_AUTOPILOT, autopilotEvents } from '../shared/pm/autopilot'
import { cardOf, handleLabel, toHandle } from '../shared/pm/board'
import { ciOf } from '../shared/pm/mechanic'
import type { Task } from '../shared/pm/run'

// github / simple: todo, work, pr (github.pr), review, merge (github.merge), done.
const plan = planSteps(github, { type: 'simple' })
const at = (i: number, more: Partial<StepState> = {}): StepState => ({ at: i, started: true, since: 1000, proofs: {}, rounds: {}, ...more })
const task = (step: StepState, more: Partial<Task> = {}): Task =>
  ({ id: 'CO-1', project: 'CO', title: 'T', description: '', type: 'simple', state: 'working', step, createdAt: 1, ...more })

it('red CI sent to the agent stalls the task after 10 min while it stays red on that commit', () => {
  const sent = 5000, red = task(at(4), { mech: { 'base:abc': 2000, 'red:abc': sent }, ci: { head: 'abc', red: true } })
  expect(stallOf(red, plan, sent + RED_CI_WAIT_MS - 1)).toBeUndefined()
  expect(stallOf(red, plan, sent + RED_CI_WAIT_MS)).toEqual({ cause: 'red:abc', reason: 'CI red, no new push for 10 min', since: sent + RED_CI_WAIT_MS })
  // The fix committed or pushed, CI green, a later engine move, a new step, or already the user's: no stall.
  const late = sent + RED_CI_WAIT_MS * 2
  expect(stallOf({ ...red, ci: { head: 'def', red: false } }, plan, late)).toBeUndefined()
  expect(stallOf({ ...red, ci: { head: 'abc', red: false } }, plan, late)).toBeUndefined()
  expect(stallOf({ ...red, mech: { ...red.mech, 'catch-up:abc': sent + 1 } }, plan, late)).toBeUndefined()
  expect(stallOf({ ...red, step: at(4, { since: sent + 1 }) }, plan, late)).toBeUndefined()
  expect(stallOf({ ...red, stopped: { by: 'user', why: 'test', at: 1 } }, plan, late)).toBeUndefined()
  // What the engine reads: red only at the task's commit, once the checks finished.
  const pr = (headRefOid: string, conclusion: string, status = 'COMPLETED') => ({ url: 'u', baseRefName: 'v3', headRefOid, statusCheckRollup: [{ name: 'test', status, conclusion }] })
  expect(ciOf(pr('abc', 'FAILURE'), 'abc')).toEqual({ head: 'abc', red: true })
  expect(ciOf(pr('abc', 'FAILURE'), 'def')).toEqual({ head: 'def', red: false })
  expect(ciOf(pr('abc', '', 'IN_PROGRESS'), 'abc')).toEqual({ head: 'abc', red: false, running: true })
})

it('an idle agent whose step waits for its report stalls the task after 5 min', () => {
  const idle = task(at(1, { told: 1000 }), { idle: 3000 })
  expect(awaitsHolder(idle, plan)).toBe(true)
  expect(awaitsHolder(task(at(1)), plan)).toBe(false) // instructions not delivered yet
  expect(stallOf(idle, plan, 3000 + IDLE_WAIT_MS - 1)).toBeUndefined()
  expect(stallOf(idle, plan, 3000 + IDLE_WAIT_MS)).toEqual({ cause: 'idle:1:1000', reason: 'The worker stopped before saying it is done', since: 3000 + IDLE_WAIT_MS })
  // Idle again after its nudge: the same cause, still dated from when it first began.
  expect(stallOf({ ...idle, idle: 9e5, stalls: { 'idle:1:1000': { since: 3000 + IDLE_WAIT_MS, nudged: 4e5 } } }, plan, 1.3e6)?.since).toBe(3000 + IDLE_WAIT_MS)
  expect(stallOf({ ...idle, idle: undefined }, plan, 1e9)).toBeUndefined()
})

it('a stall shows on the card; after 30 min it is Your turn and in Tasks to handle', () => {
  const red = task(at(4, { since: 0 }), { mech: { 'red:abc': 0 }, ci: { head: 'abc', red: true } })
  const young = cardOf(red, plan, [], RED_CI_WAIT_MS)
  expect(young.stall?.reason).toBe('CI red, no new push for 10 min')
  expect(young.yourTurn).toBeUndefined()
  expect(toHandle([young])).toEqual([])
  const old = cardOf(red, plan, [], RED_CI_WAIT_MS + HANDLE_AFTER_MS)
  expect(old.yourTurn).toBe('Stalled: CI red, no new push for 10 min')
  expect(toHandle([old])).toEqual([{ id: 'CO-1', shown: 'CO-1', project: 'CO', title: 'T', action: 'Stalled: CI red, no new push for 10 min', label: 'Unblock' }])
  // What already waits for the user is there at once, with its action.
  const merge = cardOf(task(at(4, { yourTurn: { reason: 'action', badge: 'merge: head moved' } })), plan, [])
  expect(merge.stall).toBeUndefined()
  expect(handleLabel(merge)).toBe('Retry')
  expect(handleLabel({ stopped: { by: 'user', why: 'x', at: 1 } })).toBe('Resume')
})

it('back to work: a timeout leaves Your turn and its deadline starts again; what the user must do stays', () => {
  // The coordinator tells the agent something, starts it again, or the agent is seen working.
  const timed = planSteps(wherdr, { type: 'simple' }) // work: 3h
  const late = onEvent(timed, at(1, { deadline: 2000, told: 1000 }), { kind: 'tick' }, 5000).state
  expect(late.yourTurn?.badge).toBe('Check work: over 3h')
  const back = backToWork(task(late), timed, 6000)!
  expect(back.step!.yourTurn).toBeUndefined()
  expect(back.step!.deadline).toBe(6000 + durationMs('3h'))
  expect(cardOf(back, timed, [], 6000).yourTurn).toBeUndefined()
  // The new deadline passes too: Your turn again.
  expect(onEvent(timed, back.step!, { kind: 'tick' }, 6000 + durationMs('3h')).state.yourTurn?.reason).toBe('timeout')
  // Told while still idle since long before: a new stall counts from now, nothing to hand over yet.
  const told = backToWork(task(late, { idle: 2000 }), timed, 6000)!
  expect(told.idle).toBe(6000)
  expect(stallOf(told, timed, 6000 + IDLE_WAIT_MS)?.since).toBe(6000 + IDLE_WAIT_MS)
  expect(toHandle([cardOf(told, timed, [], 6000 + IDLE_WAIT_MS)])).toEqual([])
  // A merge, an answer or a decision is the user's: kept.
  expect(backToWork(task(at(4, { yourTurn: { reason: 'action', badge: 'merge: head moved' } })), plan, 6000)).toBeUndefined()
  expect(backToWork(task(at(1), { state: 'waiting', waiting: 'The agent asks a question', waitKind: 'question' }), plan, 6000)).toBeUndefined()
})

it('back to work: a working agent clears a stall from Tasks to handle, its clock starts again', () => {
  const since = 3000 + IDLE_WAIT_MS, now = since + HANDLE_AFTER_MS
  const stalled = task(at(1, { told: 1000 }), { idle: 3000, stall: { cause: 'idle:1:1000', reason: 'r', since }, stalls: { 'idle:1:1000': { since, nudged: since, handled: now } } })
  expect(toHandle([cardOf(stalled, plan, [], now)])).toHaveLength(1)
  const back = backToWork({ ...stalled, idle: undefined }, plan, now)!
  expect(back.stalls!['idle:1:1000']).toEqual({ since, nudged: since, back: now })
  expect(toHandle([cardOf(back, plan, [], now)])).toEqual([])
  // Idle again: a stall dated from the return, no hand-over before another 30 min.
  const again = { ...back, idle: now + 1 }
  expect(stallOf(again, plan, now + IDLE_WAIT_MS + 1)?.since).toBe(now)
  expect(toHandle([cardOf(again, plan, [], now + HANDLE_AFTER_MS - 1)])).toEqual([])
  expect(stallMoves(again, stallOf(again, plan, now + HANDLE_AFTER_MS)!, now + HANDLE_AFTER_MS).handle).toBe(true)
})

it('one nudge per cause at once, one restart 10 min later, one hand-over to the user 30 min after the stall began', () => {
  const s = { cause: 'red:abc', reason: 'CI red', since: 1000 }
  expect(stallMoves({}, s, 1000)).toEqual({ nudge: true, restart: false, handle: false })
  const nudged = { stalls: { 'red:abc': { since: 1000, nudged: 1000 } } }
  expect(stallMoves(nudged, s, 1000 + RESTART_AFTER_MS - 1).restart).toBe(false)
  expect(stallMoves(nudged, s, 1000 + RESTART_AFTER_MS).restart).toBe(true)
  const restarted = { stalls: { 'red:abc': { ...nudged.stalls['red:abc'], restarted: 1000 + RESTART_AFTER_MS } } }
  expect(stallMoves(restarted, s, 1000 + HANDLE_AFTER_MS - 1)).toEqual({ nudge: false, restart: false, handle: false })
  expect(stallMoves(restarted, s, 1000 + HANDLE_AFTER_MS)).toEqual({ nudge: false, restart: false, handle: true })
  expect(stallMoves({ stalls: { 'red:abc': { ...restarted.stalls['red:abc'], handled: 2e6 } } }, s, 1e9)).toEqual({ nudge: false, restart: false, handle: false })
  // A new commit red again is a new cause: one more nudge.
  expect(stallMoves(nudged, { ...s, cause: 'red:def' }, 1000).nudge).toBe(true)
})

it('the failing tests are read from gh run view --log-failed', () => {
  const log = [
    'test\tRun tests\t2026-11-09T01:02:03.4567890Z \x1B[31m FAIL \x1B[39m tests/a.test.ts > adds',
    'test\tRun tests\t2026-11-09T01:02:03.4567890Z  × tests/b.test.ts > keeps 12ms',
    'test\tRun tests\t2026-11-09T01:02:04.0000000Z  FAIL  tests/a.test.ts > adds',
    'test\tRun tests\t2026-11-09T01:02:05.0000000Z ✓ tests/c.test.ts > fine',
  ].join('\n')
  expect(failingTests(log)).toEqual(['tests/a.test.ts > adds', 'tests/b.test.ts > keeps'])
})

it('an action refused wakes the coordinator as stuck with its reason; a stall too, once, while the engine still tries', () => {
  const ap = { ...DEFAULT_AUTOPILOT, events: ['stuck' as const] }
  const stalled = task(at(4), { stall: { cause: 'red:abc', reason: 'CI red, no new push for 10 min', since: 1 } })
  expect(autopilotEvents(ap, [stalled], { 'CO-1': 'working' }).reasons).toEqual(['CO-1 (T): stuck: CI red, no new push for 10 min'])
  const gaveUp = { ...stalled, selfFix: { step: '4:1000', block: 'stall', tried: ['a nudge', 'a restart'], at: 1, woke: 2 } }
  expect(autopilotEvents(ap, [gaveUp], { 'CO-1': 'working' }).reasons).toEqual(['CO-1 (T): stuck: CI red, no new push for 10 min'])
  expect(autopilotEvents(ap, [stalled], { 'CO-1': 'stalled' }).reasons).toEqual([])
  const refused = task(at(4, { yourTurn: { reason: 'action', badge: 'merge: head moved' } }))
  expect(autopilotEvents(ap, [refused], { 'CO-1': 'working' }).reasons).toEqual(['CO-1 (T): stuck: merge: head moved'])
})
