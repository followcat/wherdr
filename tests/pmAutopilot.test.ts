import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTOPILOT, quietEvents, holdsSlot, skippedWake, autopilotEvents, coordinatorStartRefusal, sentence, cleanAutopilot, inHours, routinesDue, LOOK_PER_DAY, bump, limitsLeft, lookAddRefusal, nothingToDo, pastLimit, scheduledWake, startRefusal, today, tellRefusal, countFix } from '../shared/pm/autopilot'
import type { Run, Task } from '../shared/pm/run'
import { HEALTH_ACK, healthSummary, oneSchedule } from '../shared/pm/health'
import { accountQuota, pacedStart, paceLine } from '../shared/pm/pace'
import { DEFAULT_PACE, type PaceVerdict } from '../shared/pm/pacing'
import type { Quotas } from '../shared/types'

const task = (n: number, more: Partial<Task> = {}): Task => ({ id: `CO-${n}`, project: 'CO', title: `T${n}`, description: '', type: 'feature', state: 'working', createdAt: 0, ...more })
const run = (n: number, startedAt: number): Run => ({ id: `r${n}`, task: `CO-${n}`, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '', branch: '', instructions: '', attempt: 1, state: 'running', startedAt })
const at = (h: number) => new Date(2026, 10, 5, h, 30).getTime()

describe('routines', () => {
  const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
  const ap = { ...DEFAULT_AUTOPILOT, on: true, goal: 'Ship', routines: [
    { id: 'night', when: 'daily 08:00', goal: 'Summarise the night', on: true },
    { id: 'week', when: 'mon,thu 18:00', goal: 'Plan the week', on: true },
  ] }
  it('wakes each routine at its time with its own goal, once for missed slots', () => {
    const ran = { night: day(2, 9), week: day(2, 19) } // 2 Nov 2026: a Monday, after its 18:00
    expect(routinesDue(ap, ran, day(3, 7, 59)).wake).toEqual([])
    expect(routinesDue(ap, ran, day(3, 8))).toEqual({ wake: [ap.routines[0]], ran: { night: day(3, 8), week: day(2, 19) } })
    expect(routinesDue(ap, ran, day(5, 18)).wake.map(r => r.goal)).toEqual(['Summarise the night', 'Plan the week'])
    // A new one counts from now.
    expect(routinesDue(ap, {}, day(3, 8))).toEqual({ wake: [], ran: { night: day(3, 8), week: day(3, 8) } })
  })
  it('skips a slot with the autopilot or the routine off, or outside the hours: counted as run', () => {
    const ran = { night: day(2, 9), week: day(2, 19) }
    for (const off of [{ ...ap, on: false }, { ...ap, hours: { from: 9, to: 18 } }, { ...ap, routines: ap.routines.map(r => ({ ...r, on: false })) }])
      expect(routinesDue(off, ran, day(3, 8))).toEqual({ wake: [], ran: { night: day(3, 8), week: day(2, 19) } })
  })
  it('reads an older At as one routine with the goal', () => {
    const old = { ...DEFAULT_AUTOPILOT, on: true, goal: 'Triage', at: 'daily 08:00' }
    expect(routinesDue(old, { at: day(2, 9) }, day(3, 8)).wake).toEqual([{ id: 'at', when: 'daily 08:00', goal: 'Triage', on: true }])
    expect(cleanAutopilot(old)).toMatchObject({ autopilot: { routines: [{ id: 'at', when: 'daily 08:00', goal: 'Triage', on: true }] } })
    expect((cleanAutopilot(old) as { autopilot: object }).autopilot).not.toHaveProperty('at')
  })
})

describe('autopilot settings', () => {
  it('keeps what is valid and refuses the rest', () => {
    expect(cleanAutopilot({ on: true, goal: ' ship v3 ', every: '2h', events: ['done', 'done', 'stuck'], perDay: 5, atOnce: 2, hours: { from: 22, to: 6 }, extra: 1 }))
      .toEqual({ autopilot: { on: true, goal: 'ship v3', every: '2h', events: ['done', 'stuck'], perDay: 5, atOnce: 2, hours: { from: 22, to: 6 } } })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, every: '0m' })).toEqual({ error: expect.stringMatching(/every/) })
    for (const when of ['every 2h', 'soon']) expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, routines: [{ id: 'a', when, goal: '', on: true }] })).toEqual({ error: expect.stringMatching(/^routines:/) })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, events: ['merged'] })).toEqual({ error: expect.stringMatching(/events/) })
    // Tasks / day: empty is no daily limit, up to 1000 otherwise.
    for (const perDay of ['', null]) expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, perDay })).toEqual({ autopilot: { on: false, goal: '', events: [], perDay: null, atOnce: 2 } })
    // Every off: no interval wake; the old health field is dropped.
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, every: 'off', health: '6h' })).toEqual({ autopilot: DEFAULT_AUTOPILOT })
    for (const perDay of [0, 250]) expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, perDay })).toMatchObject({ autopilot: { perDay } })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, perDay: 2000 })).toEqual({ error: expect.stringMatching(/perDay/) })
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
    // While the account burns, tasks at once are Auto.
    expect(startRefusal(ap, [...tasks, task(4)], [], at(12), { go: true, burning: true })).toBeUndefined()
    // Auto (null): no project ceiling, the machines decide; only the day's limit holds.
    expect(cleanAutopilot({ ...ap, atOnce: null })).toMatchObject({ autopilot: { atOnce: null } })
    expect(startRefusal({ ...ap, atOnce: null }, [...tasks, task(4), task(5)], [], at(12))).toBeUndefined()
    expect(limitsLeft({ ...ap, atOnce: null }, tasks, [], at(12))).toMatchObject({ startLeft: 3, atOnce: null })
  })

  it('a working task whose step holds no agent takes no slot, unless the engine handed its worker work', () => {
    const plan = [{ holder: 'worker' as const }, { holder: 'none' as const }]
    const step = (at: number, more = {}) => ({ step: { at, started: true, proofs: {}, rounds: {}, ...more } })
    const tasks = [task(1, step(0)), task(2, step(1)), task(3, step(1, { agent: { kind: 'catch-up', head: 'abc', at: 0 } }))]
    const holds = (t: Task) => holdsSlot(t, plan)
    expect(limitsLeft(ap, tasks, [], at(12), holds)).toMatchObject({ working: 2, startLeft: 0 })
    expect(startRefusal(ap, tasks.slice(0, 2), [], at(12), undefined, holds)).toBeUndefined()
    // Without its plan, a task holds its slot.
    expect(holdsSlot(tasks[1]!)).toBe(true)
  })

  it('counts the tasks started since midnight, a task once', () => {
    const tasks = [1, 2, 3].map(n => task(n, { state: 'waiting' }))
    const runs = [run(1, at(1)), run(1, at(2)), run(2, at(3)), run(3, at(3) - 86_400_000)]
    expect(limitsLeft(ap, tasks, runs, at(12))).toMatchObject({ started: 2, startLeft: 1 })
    // A task first started yesterday does not count today.
    expect(startRefusal(ap, [...tasks, task(4, { state: 'waiting' })], [...runs, run(3, at(4)), run(4, at(4))], at(12))).toMatch(/Today's limit is reached \(3/)
    expect(startRefusal({ ...ap, hours: { from: 22, to: 6 } }, [], [], at(12))).toMatch(/hours/)
  })

  it('has no daily limit without Tasks / day: only At once holds', () => {
    const noCap = { ...ap, perDay: null }
    const runs = [1, 2, 3, 4].map(n => run(n, at(n)))
    const tasks = [1, 2, 3, 4].map(n => task(n, { state: 'waiting' }))
    expect(limitsLeft(noCap, tasks, runs, at(12))).toMatchObject({ started: 4, perDay: null, startLeft: 2 })
    expect(startRefusal(noCap, tasks, runs, at(12))).toBeUndefined()
    expect(startRefusal(noCap, [...tasks, task(5), task(6)], runs, at(12))).toMatch(/at once/)
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

  it('by default, wakes only for what needs judgment', () => {
    const seen = { 'CO-1': 'working', 'CO-2': 'working', 'CO-3': 'working', 'CO-4': 'working', 'CO-5': 'working', 'CO-6': 'todo' } as const
    const step = { at: 2, started: true, proofs: {}, rounds: {} }
    const tasks = [
      task(1, { state: 'waiting', waitKind: 'question', waiting: 'Which DB?' }),
      task(2, { state: 'waiting', waitKind: 'permission', waiting: 'Run rm?' }), // the user's
      task(3, { step: { ...step, yourTurn: { reason: 'rounds', badge: 'Decide: review failed 3 times' } } }),
      task(4, { step: { ...step, done: true } }),
      task(5, { step: { ...step, yourTurn: { reason: 'user', badge: 'Merge' } } }),
      task(6), // started
      task(7, { state: 'todo' }), // added
    ]
    expect(autopilotEvents(DEFAULT_AUTOPILOT, tasks, seen).reasons).toEqual(['CO-1 (T1): question: Which DB?', 'CO-3 (T3): decide: Decide: review failed 3 times'])
    // Turned back on, routine events come too; a question is never also stuck.
    expect(autopilotEvents({ ...DEFAULT_AUTOPILOT, events: ['added', 'done', 'stuck', 'ready'] }, tasks, seen).reasons)
      .toEqual(['CO-1 (T1): question: Which DB?', 'CO-2 (T2): stuck: Run rm?', 'CO-3 (T3): decide: Decide: review failed 3 times', 'CO-4 (T4): done', 'CO-5 (T5): ready', 'CO-7 (T7): added'])
  })

  it('a question a tell answered, back while its agent\'s label stays, wakes no one again', () => {
    const asked = task(1, { state: 'waiting', waitKind: 'question', waiting: 'Which DB?', answered: 50 })
    expect(autopilotEvents(DEFAULT_AUTOPILOT, [asked], { 'CO-1': 'working' })).toMatchObject({ reasons: [], skipped: ['CO-1 (T1): its question was answered already'] })
    // Its label gone, answered is cleared: the next question wakes.
    expect(autopilotEvents(DEFAULT_AUTOPILOT, [{ ...asked, answered: undefined }], { 'CO-1': 'working' }).reasons).toEqual(['CO-1 (T1): question: Which DB?'])
  })

  it('an autopilot saved with the old default events drops them; any other choice stays', () => {
    expect(quietEvents({ ...DEFAULT_AUTOPILOT, on: true, events: ['stuck', 'done'] })).toEqual({ ...DEFAULT_AUTOPILOT, on: true, events: [] })
    for (const events of [['done'], ['done', 'stuck', 'ready'], []] as const) expect(quietEvents({ ...DEFAULT_AUTOPILOT, events: [...events] }).events).toEqual(events)
  })

  it('wakes for a task added by someone else than this coordinator only', () => {
    const ap = { ...DEFAULT_AUTOPILOT, events: ['added' as const] }
    const self = { key: 'CO', by: 'coordinator CO' }
    const log = (by: string) => ({ log: [{ at: 0, by, text: 'added the task' }] })
    const tasks = [
      task(1, { state: 'todo', origin: 'user', addedBy: 'user' }), // the user, in wherdr
      task(2, { state: 'todo', origin: 'user', addedBy: 'CO' }), // this coordinator, in a user turn
      task(3, { state: 'todo', origin: 'coordinator', addedBy: '_main' }), // another coordinator
      task(4, { state: 'todo', origin: 'automation', addedBy: 'automation' }),
      task(5, { state: 'todo', ...log('coordinator CO') }), // made before addedBy: its log
      task(6, { state: 'todo', ...log('main coordinator') }),
    ]
    expect(autopilotEvents(ap, tasks, {}, self).reasons).toEqual(['CO-1 (T1): added', 'CO-3 (T3): added', 'CO-4 (T4): added', 'CO-6 (T6): added'])
    expect(autopilotEvents(ap, tasks, {}, { key: '_main', by: 'main coordinator' }).reasons).toEqual(['CO-1 (T1): added', 'CO-2 (T2): added', 'CO-4 (T4): added', 'CO-5 (T5): added'])
  })
})

describe('nothing to do: scheduled wakes skipped', () => {
  const done = (n: number) => task(n, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } })
  const last = { at: 100, seen: { 'CO-1': 'done', 'CO-2': 'done' } } as const
  const wake = { ...last, seen: { ...last.seen } }
  it('only when every task is done and nothing changed since the last wake', () => {
    expect(nothingToDo([done(1), done(2)], wake)).toBe(true)
    expect(nothingToDo([], { at: 1, seen: {} })).toBe(true)
    // Never known before a first wake.
    expect(nothingToDo([done(1)], {})).toBe(false)
    // Under way, to do, waiting for the user or ready for them.
    for (const t of [task(2), task(2, { state: 'todo' }), task(2, { state: 'waiting' }), task(2, { step: { at: 3, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'user', badge: 'Merge' } } })])
      expect(nothingToDo([done(1), t], wake)).toBe(false)
    // A change since: a task finished, added or removed, a message of the user.
    expect(nothingToDo([done(1), done(2)], { at: 100, seen: { 'CO-1': 'done', 'CO-2': 'working' } })).toBe(false)
    expect(nothingToDo([done(1), done(2), done(3)], wake)).toBe(false)
    expect(nothingToDo([done(1)], wake)).toBe(false)
    expect(nothingToDo([done(1), done(2)], wake, 101)).toBe(false)
    expect(nothingToDo([done(1), done(2)], wake, 99)).toBe(true)
  })
  it('kept with "look for new work", within the tasks those wakes may add a day', () => {
    const idle = [done(1), done(2)]
    expect(scheduledWake(DEFAULT_AUTOPILOT, idle, wake, undefined, 0)).toBe('idle')
    expect(scheduledWake(DEFAULT_AUTOPILOT, [done(1), task(2)], wake, undefined, 0)).toBe('send')
    const look = { ...DEFAULT_AUTOPILOT, lookForWork: true as const }
    expect(scheduledWake(look, idle, wake, undefined, LOOK_PER_DAY - 1)).toBe('look')
    expect(scheduledWake(look, idle, wake, undefined, LOOK_PER_DAY)).toBe('limit')
    expect(scheduledWake({ ...look, lookPerDay: 5 }, idle, wake, undefined, 4)).toBe('look')
    expect(scheduledWake({ ...look, lookPerDay: 0 }, idle, wake, undefined, 0)).toBe('limit')
    // Work to do is never limited by it.
    expect(scheduledWake(look, [task(1)], wake, undefined, 99)).toBe('send')
    expect(lookAddRefusal(look, 2)).toBeUndefined()
    expect(lookAddRefusal(look, 3)).toMatch(/limit of new work is reached \(3 tasks.*until tomorrow/)
    // The settings: on by default at 3 a day, editable, kept only with the option on.
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, lookForWork: true })).toEqual({ autopilot: { ...DEFAULT_AUTOPILOT, lookForWork: true, lookPerDay: 3 } })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, lookForWork: true, lookPerDay: 7 })).toEqual({ autopilot: { ...DEFAULT_AUTOPILOT, lookForWork: true, lookPerDay: 7 } })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, lookForWork: true, lookPerDay: 21 })).toEqual({ error: expect.stringMatching(/^lookPerDay/) })
    expect(cleanAutopilot({ ...DEFAULT_AUTOPILOT, lookForWork: 'yes', lookPerDay: 7 })).toEqual({ autopilot: DEFAULT_AUTOPILOT })
  })
  it('skipped while nothing it could act on changed: to-do tasks that cannot start, no new block or answer', () => {
    const blocked = [done(1), task(2, { state: 'todo', after: 'CO-1' }), task(3, { state: 'todo', sameFiles: 'CO-4' }), task(4, { state: 'waiting', waiting: 'Waits for its machine' })]
    const last = { at: 100, seen: { 'CO-1': 'done', 'CO-2': 'todo', 'CO-3': 'todo', 'CO-4': 'waiting' } as const }
    expect(scheduledWake(DEFAULT_AUTOPILOT, blocked, last, undefined, 0)).toBe('waits')
    // A task startable now (Keep the board busy off), a new block or answer, a message of the user: it goes.
    expect(scheduledWake({ ...DEFAULT_AUTOPILOT, on: true, keepBusy: false }, [...blocked, task(5, { state: 'todo' })], { ...last, seen: { ...last.seen, 'CO-5': 'todo' } }, undefined, 0)).toBe('send')
    expect(scheduledWake(DEFAULT_AUTOPILOT, blocked, { ...last, seen: { ...last.seen, 'CO-4': 'working' } }, undefined, 0)).toBe('send')
    expect(scheduledWake(DEFAULT_AUTOPILOT, blocked, last, 101, 0)).toBe('send')
    expect(scheduledWake(DEFAULT_AUTOPILOT, blocked, {}, undefined, 0)).toBe('send')
  })
  it('counts per local day', () => {
    const c = { day: new Date(at(9)).toDateString(), n: 3 }
    expect(today(c, at(23))).toBe(3)
    expect(today(c, at(9) + 86_400_000)).toBe(0)
    expect(today(undefined, at(9))).toBe(0)
    expect(bump(c, at(10))).toEqual({ ...c, n: 4 })
    expect(bump(c, at(9) + 86_400_000)).toEqual({ day: new Date(at(9) + 86_400_000).toDateString(), n: 1 })
  })
})

describe('tell', () => {
  it('in a wake, only answers a question; a permission is always the user\'s', () => {
    expect(tellRefusal({ state: 'waiting', waitKind: 'question' }, true)).toBeUndefined()
    expect(tellRefusal({ state: 'working' }, true)).toMatch(/only answers an agent's question/)
    expect(tellRefusal({ state: 'working' }, false)).toBeUndefined()
    expect(tellRefusal({ state: 'waiting', waitKind: 'permission' }, false)).toMatch(/permission request is the user's/)
  })
  it('in a wake, fixes a mechanical block: a project coordinator, its autopilot on, twice per step', () => {
    const on = { autopilot: { ...DEFAULT_AUTOPILOT, on: true }, main: false }
    const step = { at: 2, since: 50, started: true, proofs: {} }
    expect(tellRefusal({ state: 'working', step }, true, on)).toBeUndefined()
    expect(tellRefusal({ state: 'working' }, true, { ...on, autopilot: DEFAULT_AUTOPILOT })).toMatch(/only with the autopilot on/)
    expect(tellRefusal({ state: 'working' }, true, { ...on, main: true })).toMatch(/only the project's coordinator/)
    expect(tellRefusal({ state: 'waiting', waitKind: 'permission' }, true, on)).toMatch(/permission request is the user's/)
    expect(tellRefusal({ state: 'waiting', stopped: { by: 'the user', why: 'x', at: 1 } }, true, on)).toMatch(/was stopped: --fix does not start it again/)
    expect(tellRefusal({ state: 'working', step: { ...step, done: true } }, true, on)).toMatch(/task is done/)
    const twice = countFix({ step, fixes: countFix({ step }) })
    expect(twice).toEqual({ step: '2:50', n: 2 })
    expect(tellRefusal({ state: 'working', step, fixes: twice }, true, on)).toMatch(/Already fixed 2 times in this step/)
    // The next step counts again; the user's turn is never counted.
    expect(tellRefusal({ state: 'working', step: { ...step, at: 3, since: 90 }, fixes: twice }, true, on)).toBeUndefined()
    expect(tellRefusal({ state: 'working', step, fixes: twice }, false, on)).toBeUndefined()
  })
})

describe('starting a task (coordinator, or the engine for a chained one)', () => {
  const ap = { ...DEFAULT_AUTOPILOT, on: true, perDay: 2, atOnce: 1 }
  const todo = (n: number, more: Partial<Task> = {}) => task(n, { state: 'todo', ...more })
  const done = task(1, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } })

  it('in a wake only with the autopilot on, within its limits', () => {
    expect(coordinatorStartRefusal(ap, todo(2), [todo(2)], [], at(12), true)).toBeUndefined()
    expect(coordinatorStartRefusal({ ...ap, on: false }, todo(2), [todo(2)], [], at(12), true)).toBe('A task starts only on a request from the user, sent from wherdr, or in a wake with the autopilot on')
    expect(coordinatorStartRefusal({ ...ap, on: false }, todo(2), [todo(2)], [], at(12), false)).toBeUndefined()
    const finished = (n: number) => task(n, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } })
    expect(coordinatorStartRefusal(ap, todo(2), [todo(2), finished(4), finished(5)], [run(4, at(9)), run(5, at(10))], at(12), true)).toMatch(/Today's limit/)
    expect(coordinatorStartRefusal({ ...ap, hours: { from: 22, to: 6 } }, todo(2), [todo(2)], [], at(12), true)).toBe('Outside the autopilot\'s hours')
    expect(coordinatorStartRefusal(ap, task(2), [task(2)], [], at(12), false)).toBe('CO-2 is not to do (working)')
    // Stopped on a failure: started again, in a wake only while it ran few times; a question is not a stop.
    const stopped = task(2, { state: 'waiting', waiting: 'git worktree failed' })
    expect(coordinatorStartRefusal(ap, stopped, [stopped], [run(2, at(9))], at(12), true)).toBeUndefined()
    // An agent that exited at once: its second attempt is the same start.
    expect(coordinatorStartRefusal(ap, stopped, [stopped], [run(2, at(9)), { ...run(2, at(9)), id: 'r2b', attempt: 2 }], at(12), true)).toBeUndefined()
    expect(coordinatorStartRefusal(ap, stopped, [stopped], [run(2, at(9)), run(2, at(10))], at(12), true)).toBe('CO-2 already ran 2 times: starting it again is the user\'s call')
    expect(coordinatorStartRefusal(ap, stopped, [stopped], [run(2, at(9)), run(2, at(10))], at(12), false)).toBeUndefined()
    expect(coordinatorStartRefusal(ap, { ...stopped, waitKind: 'question' }, [stopped], [], at(12), false)).toBe('CO-2 is not to do (waiting)')
  })

  it('a user turn goes past each limit, and says so; a wake and the engine are still refused', () => {
    const finished = (n: number) => task(n, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } })
    const cases: [typeof ap, Task[], Run[], RegExp, string][] = [
      [ap, [task(3), todo(2)], [], /1 tasks already work at once/, 'past the autopilot\'s limit of 1 at once'],
      [ap, [todo(2), finished(4), finished(5)], [run(4, at(9)), run(5, at(10))], /Today's limit/, 'past the autopilot\'s limit of 2 tasks a day'],
      [{ ...ap, hours: { from: 22, to: 6 } }, [todo(2)], [], /hours/, 'outside the autopilot\'s hours'],
    ]
    for (const [pilot, tasks, runs, refused, past] of cases) {
      expect(coordinatorStartRefusal(pilot, todo(2), tasks, runs, at(12), false)).toBeUndefined()
      expect(pastLimit(pilot, tasks, runs, at(12))).toBe(past)
      expect(coordinatorStartRefusal(pilot, todo(2), tasks, runs, at(12), true)).toMatch(refused)
      expect(coordinatorStartRefusal(pilot, todo(2), tasks, runs, at(12), false, { engine: true })).toMatch(refused)
    }
    expect(pastLimit(ap, [todo(2)], [], at(12))).toBeUndefined()
    // Real refusals stay: not to do, 'after' not done.
    expect(coordinatorStartRefusal(ap, task(2), [task(2)], [], at(12), false)).toBe('CO-2 is not to do (working)')
    expect(coordinatorStartRefusal(ap, todo(2, { after: 'CO-1' }), [task(1, { state: 'todo' }), todo(2, { after: 'CO-1' })], [], at(12), false)).toMatch(/starts after CO-1/)
  })

  it('a chained task waits until the task before it is done', () => {
    const next = todo(2, { after: 'CO-1' })
    expect(coordinatorStartRefusal(ap, next, [task(1, { state: 'todo' }), next], [], at(12), true)).toBe('CO-2 starts after CO-1, which is not done')
    expect(coordinatorStartRefusal(ap, next, [done, next], [], at(12), true)).toBeUndefined()
  })
})

it('puts the goal in a wake with one final period', () => {
  expect(['Ship v3', 'Ship v3.', ' Ship v3? '].map(sentence)).toEqual(['Ship v3.', 'Ship v3.', 'Ship v3?'])
})

describe('the pace holds automatic starts only', () => {
  const ap = { ...DEFAULT_AUTOPILOT, on: true, perDay: 5, atOnce: 2 }
  const wait: PaceVerdict = { go: false, reason: 'ahead', until: new Date(2026, 10, 6, 0, 0).getTime() }
  const todo = (n: number, more: Partial<Task> = {}) => task(n, { state: 'todo', ...more })
  const done = task(1, { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} } })
  const start = (t: Task, wake: boolean, engine = false) => coordinatorStartRefusal(ap, t, [done, t], [], at(12), wake, { pace: wait, engine })

  it('refuses a wake\'s start and an automatic chain, after the task-count limits', () => {
    expect(start(todo(2), true)).toMatch(/^Paced: ahead of the target line until Fri 00:00/)
    expect(start(todo(2, { after: 'CO-1', origin: 'coordinator' }), false, true)).toMatch(/^Paced:/)
    expect(start(todo(2, { after: 'CO-1', auto: 'nightly' }), false, true)).toMatch(/^Paced:/)
    expect(startRefusal({ ...ap, atOnce: 0 }, [], [], at(12), wait)).toMatch(/at once/)
    expect(startRefusal(ap, [], [], at(12), { go: true, unknown: true })).toBeUndefined()
  })

  it('never refuses a task the user starts (their turn), even one the coordinator added', () => {
    expect(start(todo(2), false)).toBeUndefined()
    expect(start(todo(2, { origin: 'coordinator', autopilot: true }), false)).toBeUndefined()
  })

  it('never holds a chain the user made', () => {
    expect(start(todo(2, { after: 'CO-1', origin: 'user' }), false, true)).toBeUndefined()
    expect(start(todo(2, { after: 'CO-1' }), false, true)).toBeUndefined() // made before `origin`
  })

  it('never holds the steps of a task under way', () => {
    const stopped = task(2, { state: 'waiting', waiting: 'git worktree failed', origin: 'automation', step: { at: 2, started: true, proofs: {}, rounds: {} } })
    expect(pacedStart(stopped, 'wake')).toBe(false)
    expect(coordinatorStartRefusal(ap, stopped, [stopped], [], at(12), true, { pace: wait })).toBeUndefined()
  })

  it('skips a scheduled wake that would go, as run', () => {
    const wake = { at: 1, seen: { 'CO-1': 'done' as const } }
    expect(scheduledWake(DEFAULT_AUTOPILOT, [task(1)], wake, undefined, 0, wait)).toBe('paced')
    expect(scheduledWake({ ...DEFAULT_AUTOPILOT, lookForWork: true }, [done], wake, undefined, 0, wait)).toBe('paced')
    expect(scheduledWake(DEFAULT_AUTOPILOT, [done], wake, undefined, 0, wait)).toBe('idle')
    expect(scheduledWake(DEFAULT_AUTOPILOT, [task(1)], wake, undefined, 0, { go: true })).toBe('send')
    expect(['send', 'look', 'idle', 'limit', 'waits', 'paced'].map(k => skippedWake(k as never))).toEqual([false, false, true, true, true, true])
  })

  it('finds the account\'s quota and describes the pace for `autopilot show`', () => {
    const now = new Date(2026, 10, 5, 12).getTime(), reset = now + 3.5 * 86_400_000
    const quota = { at: now, five: { used: 30, resetsAt: now + 3_600_000, minutes: 300 }, week: { used: 41, resetsAt: reset, minutes: 10080 } }
    const account = { key: 'claude:ab12cd34', program: 'claude' as const, name: 'Pro work', machines: [''] }
    const q: Quotas = { claude: quota, codex: null, accounts: [account] }
    expect(accountQuota(q, account)).toBe(quota)
    expect(accountQuota({ ...q, claudeAccounts: [{ ...quota, key: 'claude:ffff0000', machines: [] }] }, account)).toBeNull()
    const s = { program: 'claude', account, quota, policy: { ...DEFAULT_PACE, mode: 'free' as const }, verdict: { go: true } as PaceVerdict, today: 9 }
    expect(paceLine(s, now)).toBe('claude:ab12cd34 Pro work · free with reserve · week 41 % / limit 60 % · today +9 % · 5 h 30 % · go')
    expect(paceLine({ ...s, policy: DEFAULT_PACE }, now)).toBe('claude:ab12cd34 Pro work · free · week 41 % / limit 100 % · today +9 % · 5 h 30 % · go')
    expect(paceLine({ ...s, policy: { ...DEFAULT_PACE, mode: 'workdays' }, verdict: wait }, now)).toMatch(/· working days · week 41 % \/ line \d+ % · .* · wait: ahead of the target line until Fri 00:00$/)
    expect(paceLine({ ...s, account: null, quota: null, verdict: { go: true, unknown: true }, today: null }, now)).toBe('claude · quota unknown (no reading of claude on this project\'s machine) · task-count limits only')
  })
})

describe('the health lines', () => {
  const now = at(12), hour = 3_600_000
  it('migrate: the shorter of the health interval (3h when unset) and Every becomes Every; off keeps Every', () => {
    expect(oneSchedule(DEFAULT_AUTOPILOT)).toEqual({ ...DEFAULT_AUTOPILOT, every: '3h' })
    expect(oneSchedule({ ...DEFAULT_AUTOPILOT, every: '4h', health: '90m' })).toEqual({ ...DEFAULT_AUTOPILOT, every: '90m' })
    expect(oneSchedule({ ...DEFAULT_AUTOPILOT, every: '30m', health: '6h' })).toEqual({ ...DEFAULT_AUTOPILOT, every: '30m' })
    expect(oneSchedule({ ...DEFAULT_AUTOPILOT, health: 'off' })).toEqual(DEFAULT_AUTOPILOT)
  })

  it('sums up done, waiting for the user, stuck for long and idle machines', () => {
    const step = { at: 2, started: true, proofs: {}, rounds: {} }
    const tasks = [
      task(1, { step: { ...step, done: true } }),
      task(2, { step: { ...step, done: true } }), // done before the last check
      task(3, { state: 'waiting', waiting: 'Which DB?\nmore' }),
      task(4, { step: { ...step, yourTurn: { reason: 'user', badge: 'Merge' } } }),
      task(5, { stall: { cause: 'idle', reason: 'agent idle', since: now - 2 * hour } }),
      task(6, { stall: { cause: 'idle', reason: 'agent idle', since: now - 10 * 60_000 } }), // not long yet
      task(7, { state: 'todo', createdAt: 1 }),
    ]
    const seen = { 'CO-1': 'working', 'CO-2': 'done' } as const
    expect(healthSummary(tasks, seen, now, ['mini'])).toEqual([
      'Done since the last check: CO-1 (T1).',
      'Waiting for the user: CO-3 (T3): Which DB?; CO-4 (T4): Merge.',
      'Stuck for over 1 h: CO-5 (T5): agent idle, for 2 h.',
      'Machines idle while 1 to-do task waits: mini.',
      HEALTH_ACK,
    ])
    // No machine idle: no line for it. Nothing at all to say: no wake.
    expect(healthSummary(tasks, seen, now, [])).not.toContainEqual(expect.stringMatching(/^Machines idle/))
    expect(healthSummary([task(2, { step: { ...step, done: true } }), task(6)], seen, now, ['mini'])).toEqual([])
  })
})
