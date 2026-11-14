import { expect, it } from 'vitest'
import { github } from '../shared/pm/examples'
import { planSteps, type StepState } from '../shared/pm/steps'
import { cardTime, spent, timesOf, timesText, withMark } from '../shared/pm/times'
import type { Run, Task } from '../shared/pm/run'

// github / simple: todo, work, pr (github.pr), review (verdict), merge (github.merge), done.
const plan = planSteps(github, { type: 'simple' })
const ix = (id: string) => plan.findIndex(p => p.id === id)
const MIN = 60_000
const state = (id: string, more: Partial<StepState> = {}): StepState => ({ at: ix(id), started: true, proofs: {}, rounds: {}, ...more })
const base: Task = { id: 'CO-1', project: 'CO', title: 'T', description: '', type: 'simple', state: 'working', createdAt: 1 }
const run: Run = { id: 'r1', task: 'CO-1', role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '~/project', branch: 'b', instructions: 'i', attempt: 1, state: 'running', startedAt: 0 }

// The store's writes, one after the other: each adds a mark when the step or the turn changed.
function replay(writes: [number, Partial<Task>][]): Task {
  let t = base
  for (const [m, change] of writes) t = withMark({ ...t, ...change }, t.marks, m * MIN)
  return t
}

it('times each step, counts a send-back as a second round and keeps waits for the user apart', () => {
  const t = replay([
    [0, { step: state('work') }],
    [10, { step: state('work') }], // a log line in the same step: no new mark
    [20, { step: state('review') }],
    [30, { step: state('work', { rounds: { review: 1 } }) }], // sent back
    [35, { step: state('review', { rounds: { review: 1 } }) }],
    [40, { step: state('merge', { rounds: { review: 1 }, yourTurn: { reason: 'user', badge: 'Merge' } }) }],
    [100, { step: state('merge', { rounds: { review: 1 }, acting: true }) }],
    [108, { step: state('merge', { rounds: { review: 1 }, done: true, since: 108 * MIN }) }],
    [120, { tags: ['late'] }], // after done: nothing more
  ])
  expect(t.marks).toHaveLength(7)
  const x = timesOf(t, plan, [run], 200 * MIN)
  expect(x.steps).toEqual([{ id: 'work', ms: 25 * MIN }, { id: 'review', ms: 15 * MIN }, { id: 'merge', ms: 8 * MIN }])
  expect(x.waited).toBe(60 * MIN)
  expect(x.total).toBe(108 * MIN)
  expect(x.rounds).toBe(2)
  expect(timesText({ ...x, ciFixes: 1 })).toBe('work 25 min · review 15 min · merge 8 min · waited for you 1 h · 2 review rounds · 1 CI fix · 1 h 48 min in all')
})

it('counts a stop, an agent question and red CI sent back', () => {
  const t = replay([
    [0, { step: state('work') }],
    [5, { state: 'waiting', waiting: 'A question' }],
    [15, { state: 'working', waiting: undefined }],
    [20, { stopped: { by: 'the user', why: 'later', at: 20 * MIN } }],
  ])
  const x = timesOf({ ...t, mech: { 'red:abc': 1, 'red:def': 2, 'base:abc': 3 } }, plan, [], 50 * MIN)
  expect(x.steps).toEqual([{ id: 'work', ms: 10 * MIN }])
  expect(x.waited).toBe(40 * MIN)
  expect(x.total).toBeUndefined()
  expect(x.ciFixes).toBe(2)
  expect(x.rounds).toBe(0)
})

it('a task done before marks existed: its total from its first run, no step times', () => {
  const t = { ...base, step: state('merge', { done: true, since: 42 * MIN }) }
  const x = timesOf(t, plan, [{ ...run, startedAt: 0 }, { ...run, id: 'r2', role: 'reviewer', startedAt: 20 * MIN }], 99 * MIN)
  expect(x).toMatchObject({ steps: [], waited: 0, total: 42 * MIN, rounds: 1 })
  expect(cardTime({ phase: 'done', times: x }, 99 * MIN)).toBe('42 min')
  expect(cardTime({ phase: 'working', step: 'review', state: { since: 0 } }, 12 * MIN)).toBe('12 min in review')
  expect(cardTime({ phase: 'todo' }, 0)).toBeUndefined()
  expect([spent(30_000), spent(60 * MIN), spent(26 * 60 * MIN)]).toEqual(['<1 min', '1 h', '1 d 2 h'])
})
