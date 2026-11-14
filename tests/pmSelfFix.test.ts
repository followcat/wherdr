import { describe, expect, it } from 'vitest'
import { infraLog, nextMove, type MechFacts, type PrState } from '../shared/pm/mechanic'
import { SELF_FIX_GRACE_MS, SELF_FIX_IDLE_MS, blockOf, engineOwns, escalation, mayTry, noteFix } from '../shared/pm/selfFix'
import { wakesFor } from '../shared/pm/wakes'
import { handToAgent, agentBack } from '../shared/pm/release'
import { MAIN } from '../shared/pm/coordinator'
import { DEFAULT_AUTOPILOT, autopilotEvents } from '../shared/pm/autopilot'
import { combineGuards } from '../shared/pm/guards'
import type { PlannedStep, StepState } from '../shared/pm/steps'
import type { Task } from '../shared/pm/run'

const plan: PlannedStep[] = [
  { id: 'work', holder: 'worker', ends: 'report', text: '' },
  { id: 'pr', ends: 'action', action: { kind: 'github.pr', base: 'v3' }, text: '' },
  { id: 'merge', ends: 'action', action: { kind: 'github.merge' }, text: '' },
]
const guards = combineGuards([{ source: 'project', guards: { merge: { others: 'engine' } } }])
const step = (at: number, more: Partial<StepState> = {}): StepState => ({ at, started: true, since: 100, proofs: {}, rounds: {}, ...more })
const failed = (at: number, error: string, more: Partial<StepState> = {}) => step(at, { yourTurn: { reason: 'action', badge: `x: ${error}`, error }, ...more })
const task = (s: StepState, more: Partial<Task> = {}): Task => ({ id: 'CO-1', project: 'CO', title: 'T', description: '', type: 'feature', state: 'working', run: 'r1', createdAt: 0, step: s, ...more })
const pr = (more: Partial<PrState> = {}): PrState => ({ url: 'https://gh/pr/7', baseRefName: 'v3', headRefOid: 'abc1234', mergeStateStatus: 'CLEAN', statusCheckRollup: [], ...more })
const facts = (t: Task, more: Partial<MechFacts> = {}): MechFacts => ({ task: t, plan, guards, branch: 'task/CO-1', agentBusy: false, head: 'abc1234', pr: pr(), ...more })
const ap = { ...DEFAULT_AUTOPILOT, events: ['stuck' as const] }
// Two tries made on the task's block, the last at `at`.
const tried = (t: Task, at = 0) => {
  const b = blockOf(t)!
  const once = { ...t, selfFix: noteFix(t, b, at, 'one') }
  return { ...once, selfFix: noteFix(once, b, at, 'two') }
}

describe('blocks the engine fixes itself', () => {
  const push = task(failed(1, 'pr: hint: See the \'Note about fast-forwards\' in \'git push --help\' for details.'))
  const conflict = task(failed(2, 'merge: the PR conflicts with v3'), { mech: { 'merge:abc1234': 1 } })
  const interrupted = task(failed(2, 'github.merge was interrupted before its result was known: check by hand, then try again', { tries: { merge: 1 } }))
  const stall = task(step(0), { stall: { cause: 'idle:0:100', reason: 'The worker stopped', since: 100 } })

  it('reads each block, and wakes no coordinator for it while the engine has it', () => {
    expect([push, conflict, interrupted, stall].map(blockOf)).toEqual(['push', 'conflict', 'interrupted', 'stall'])
    expect(blockOf(task(failed(2, 'merge: 1 check(s) failed')))).toBeUndefined()
    for (const t of [push, conflict, interrupted, stall]) {
      expect(engineOwns(t)).toBe(true)
      expect(autopilotEvents(ap, [t], { 'CO-1': 'working' }).reasons).toEqual([])
    }
    // Another failure is the coordinator's at once, as before.
    expect(autopilotEvents(ap, [task(failed(2, 'merge: 1 check(s) failed'))], { 'CO-1': 'working' }).reasons).toHaveLength(1)
  })

  it('makes its move on each: sync then push, run again, update with the base', () => {
    expect(nextMove(facts(push, { pr: undefined }))).toEqual({ key: 'sync:pr:0', move: { kind: 'sync-push', step: 'pr' } })
    expect(nextMove(facts(interrupted))).toEqual({ key: 'again:merge:1', move: { kind: 'retry-action', step: 'merge' } })
    expect(nextMove(facts(conflict, { pr: pr({ mergeStateStatus: 'DIRTY' }) }))).toEqual({ key: 'catch-up:abc1234', move: { kind: 'catch-up', base: 'v3' } })
  })

  it('a sync conflict handed to the worker is synced and pushed again once the worker is back', () => {
    const first = nextMove(facts(push, { pr: undefined }))!
    const back = { ...push, mech: { [first.key]: 1 }, step: agentBack(handToAgent(push.step!, 'sync-push', 'abc1234', 2)) }
    expect(nextMove(facts(back, { pr: undefined }))).toEqual({ key: 'sync:pr:1', move: { kind: 'sync-push', step: 'pr' } })
  })

  it('a give-up wakes the project\'s coordinator and the main one, whatever their events', () => {
    const on = { terminal: 't1', autopilot: { ...DEFAULT_AUTOPILOT, on: true } }
    expect(wakesFor(['CO', MAIN], () => on, 0)).toEqual(['CO', MAIN])
    expect(wakesFor(['CO', MAIN], k => (k === MAIN ? on : undefined), 0)).toEqual([MAIN])
    expect(wakesFor(['CO', MAIN], k => (k === MAIN ? { ...on, autopilot: DEFAULT_AUTOPILOT } : { ...on, terminal: undefined }), 0)).toEqual([])
  })

  it('fixed alone: the block gone, nothing to escalate and no wake', () => {
    const fixed = { ...tried(push), step: step(2) }
    expect(blockOf(fixed)).toBeUndefined()
    expect(escalation(fixed, 1e9)).toBeUndefined()
    expect(autopilotEvents(ap, [fixed], { 'CO-1': 'working' }).reasons).toEqual([])
  })

  it('after 2 failed tries on the same step, the coordinator is woken once with what was tried', () => {
    for (const t of [push, conflict, interrupted]) {
      expect(mayTry({ ...t, selfFix: noteFix(t, blockOf(t)!, 0, 'one') }, blockOf(t)!)).toBe(true)
      const two = tried(t)
      expect(mayTry(two, blockOf(two)!)).toBe(false)
      expect(escalation(two, SELF_FIX_GRACE_MS - 1)).toBeUndefined()
      expect(escalation(two, SELF_FIX_GRACE_MS)).toMatch(/^CO-1 \(T\): stuck: .*; the engine tried one; two, without success\.$/)
      const woke = { ...two, selfFix: { ...two.selfFix, woke: 1 } }
      expect(escalation(woke, 1e9)).toBeUndefined()
      expect(engineOwns(woke)).toBe(false)
    }
    // A stalled agent: nudged, restarted, then 10 min for the restart to work.
    expect(escalation(tried(stall), SELF_FIX_GRACE_MS)).toBeUndefined()
    expect(escalation(tried(stall), 10 * 60_000)).toMatch(/its agent is stalled; the engine tried one; two/)
    // A new step counts again.
    expect(mayTry({ ...tried(push), step: failed(1, push.step!.yourTurn!.error!, { since: 200 }) }, 'push')).toBe(true)
    // Nothing to try on it for 15 min: the coordinator's too.
    const seen = { ...push, selfFix: noteFix(push, 'push', 0) }
    expect(escalation(seen, SELF_FIX_IDLE_MS - 1)).toBeUndefined()
    expect(escalation(seen, SELF_FIX_IDLE_MS)).toMatch(/nothing to try on it/)
  })
})

describe('red CI', () => {
  const red = pr({ statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  const merging = task(step(2))

  it('an infrastructure failure in the log is run again once; a code failure goes to the worker', () => {
    expect(nextMove(facts(merging, { pr: red, infra: true }))).toEqual({ key: 'rerun:abc1234', move: { kind: 'rerun-ci', checks: ['smoke'] } })
    expect(nextMove(facts({ ...merging, mech: { 'rerun:abc1234': 1 } }, { pr: red, infra: true }))?.move.kind).toBe('ci-to-agent')
    expect(nextMove(facts(merging, { pr: red, infra: false }))).toEqual({ key: 'red:abc1234', move: { kind: 'ci-to-agent', checks: ['smoke'] } })
  })

  it('tells an infrastructure error from a code failure in the log', () => {
    for (const log of [
      'curl: (22) The requested URL returned error: 504',
      'Error: HTTP 504 while fetching https://github.com/x/releases/download/v1/tool.tar.gz',
      'gh: HTTP 502: Bad Gateway',
      '503 Service Unavailable',
      'Downloading playwright chromium... Error: Request timed out',
      'The runner has received a shutdown signal.',
      'The self-hosted runner: r1 lost communication with the server.',
    ]) expect(infraLog(log), log).toBe(true)
    for (const log of ['FAIL tests/a.test.ts > adds', 'expected 504 to be 200', 'Error: Test timed out in 5000ms']) expect(infraLog(log), log).toBe(false)
  })
})
