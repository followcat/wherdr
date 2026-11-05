import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTOPILOT, autopilotEvents, cleanAutopilot, inHours, limitsLeft, startRefusal, tellRefusal } from '../shared/pm/autopilot'
import type { Run, Task } from '../shared/pm/run'

const task = (n: number, more: Partial<Task> = {}): Task => ({ id: `CO-${n}`, project: 'CO', title: `T${n}`, description: '', type: 'feature', state: 'working', createdAt: 0, ...more })
const run = (n: number, startedAt: number): Run => ({ id: `r${n}`, task: `CO-${n}`, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '', branch: '', instructions: '', attempt: 1, state: 'running', startedAt })
const at = (h: number) => new Date(2026, 10, 5, h, 30).getTime()

describe('autopilot settings', () => {
  it('keeps what is valid and refuses the rest', () => {
    expect(cleanAutopilot({ on: true, goal: ' ship v3 ', every: '2h', events: ['done', 'done', 'stuck'], perDay: 5, atOnce: 2, hours: { from: 22, to: 6 }, extra: 1 }))
      .toEqual({ autopilot: { on: true, goal: 'ship v3', every: '2h', events: ['done', 'stuck'], perDay: 5, atOnce: 2, hours: { from: 22, to: 6 } } })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, every: '0m' })).toEqual({ error: expect.stringMatching(/every/) })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, events: ['merged'] })).toEqual({ error: expect.stringMatching(/events/) })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, perDay: 1000 })).toEqual({ error: expect.stringMatching(/perDay/) })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, hours: { from: 8, to: 8 } })).toEqual({ error: expect.stringMatching(/hours/) })
  })

  it('hours may span midnight', () => {
    expect([at(23), at(3), at(12)].map(t => inHours({ from: 22, to: 6 }, new Date(t)))).toEqual([true, true, false])
    expect([at(9), at(18)].map(t => inHours({ from: 9, to: 18 }, new Date(t)))).toEqual([true, false])
  })
})

describe('autopilot limits', () => {
  const ap = { ...DEFAULT_AUTOPILOT, on: true, perDay: 3, atOnce: 2 }

  it('waiting and ready tasks take no slot', () => {
    const tasks = [task(1), task(2, { state: 'waiting', waiting: 'a question' }), task(3, { step: { at: 1, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'user', badge: 'Merge' } } })]
    expect(limitsLeft(ap, tasks, [], at(12))).toMatchObject({ working: 1, startLeft: 1 })
    expect(startRefusal(ap, tasks, [], at(12))).toBeUndefined()
    expect(startRefusal(ap, [...tasks, task(4)], [], at(12))).toMatch(/2 tasks already work at once/)
  })

  it('counts the tasks started since midnight, a task once', () => {
    const tasks = [1, 2, 3].map(n => task(n, { state: 'waiting' }))
    const runs = [run(1, at(1)), run(1, at(2)), run(2, at(3)), run(3, at(3) - 86_400_000)]
    expect(limitsLeft(ap, tasks, runs, at(12))).toMatchObject({ started: 2, startLeft: 1 })
    // A task first started yesterday does not count today.
    expect(startRefusal(ap, [...tasks, task(4, { state: 'waiting' })], [...runs, run(3, at(4)), run(4, at(4))], at(12))).toMatch(/Today's limit is reached \(3/)
    expect(startRefusal({ ...ap, hours: { from: 22, to: 6 } }, [], [], at(12))).toMatch(/hours/)
  })
})

describe('autopilot events', () => {
  it('wakes for the events it was given, once per change', () => {
    const ap = { ...DEFAULT_AUTOPILOT, events: ['added', 'stuck'] as const }
    const seen = { 'CO-1': 'working', 'CO-2': 'working' } as const
    const tasks = [task(1, { state: 'waiting', waiting: 'Which DB?\nmore' }), task(2, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } }), task(3, { state: 'todo' })]
    const r = autopilotEvents({ ...ap, events: [...ap.events] }, tasks, seen)
    expect(r.reasons).toEqual(['CO-1 (T1): stuck: Which DB?', 'CO-3 (T3): added'])
    expect(r.seen).toEqual({ 'CO-1': 'waiting', 'CO-2': 'done', 'CO-3': 'todo' })
    expect(autopilotEvents({ ...ap, events: [...ap.events] }, tasks, r.seen).reasons).toEqual([])
  })
})

describe('tell', () => {
  it('in a wake, only answers a question; a permission is always the user\'s', () => {
    expect(tellRefusal({ state: 'waiting', waitKind: 'question' }, true)).toBeUndefined()
    expect(tellRefusal({ state: 'working' }, true)).toMatch(/only answers an agent's question/)
    expect(tellRefusal({ state: 'working' }, false)).toBeUndefined()
    expect(tellRefusal({ state: 'waiting', waitKind: 'permission' }, false)).toMatch(/permission request is the user's/)
  })
})
