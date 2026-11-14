import { describe, expect, it, vi } from 'vitest'
import { parseCommand } from '../shared/pm/coordinator'
import { actionStamp, cardNow, keepCards, parseActionLine, UI_CARD_MS, type UiCard } from '../shared/uiActions'
import type { PlannedStep } from '../shared/pm/steps'
import type { Task } from '../shared/pm/run'

const userStep = vi.fn(async () => ({}))
const resumeTask = vi.fn(async () => ({}))
vi.mock('../server/utils/pmBoard', () => ({ userStep: (...a: unknown[]) => userStep(...a as []) }))
vi.mock('../server/utils/pmStop', () => ({ resumeTask: (...a: unknown[]) => resumeTask(...a as []) }))
vi.mock('../shared/pm/run', async orig => ({ ...await orig<object>(), taskPlan: () => plan }))
const { actOnCard, addAction, readCard } = await import('../server/utils/uiActions')

const plan = [{ id: 'work', holder: 'worker' }, { id: 'merge', holder: 'none', ends: 'user', userLabel: 'Merge' }] as PlannedStep[]
const atMerge: Task = { id: 'WEB-3', project: 'WEB', title: 't', type: 'feature', state: 'working', step: { at: 1, started: true, since: 500, proofs: {}, rounds: {} } } as unknown as Task
const stopped: Task = { ...atMerge, step: { ...atMerge.step!, at: 0 }, stopped: { by: 'the user', why: 'x', at: 900 } }

describe('ui action: the stamp', () => {
  it('holds only while the task waits the same way', () => {
    expect(actionStamp('step', atMerge, plan)).toBe('step:WEB-3:merge:500')
    // The worker's step, a done task, a stopped one: no button to give.
    expect(actionStamp('step', { ...atMerge, step: { ...atMerge.step!, at: 0 } }, plan)).toBeNull()
    expect(actionStamp('step', { ...atMerge, step: { ...atMerge.step!, done: true } }, plan)).toBeNull()
    expect(actionStamp('step', { ...atMerge, stopped: stopped.stopped }, plan)).toBeNull()
    expect(actionStamp('resume', stopped, plan)).toBe('stopped:WEB-3:900')
    expect(actionStamp('resume', atMerge, plan)).toBeNull()
    expect(actionStamp('open', atMerge, plan)).toBe('open:WEB-3')
  })

  it('goes stale when the stamp moved or after a day', () => {
    const card = { id: 'a', at: 0, stamp: 'step:WEB-3:merge:500', state: 'open' } as UiCard
    expect(cardNow(card, 'step:WEB-3:merge:500', 1000).state).toBe('open')
    expect(cardNow(card, 'step:WEB-3:merge:700', 1000).state).toBe('stale')
    expect(cardNow(card, null, 1000).state).toBe('stale')
    expect(cardNow(card, card.stamp, UI_CARD_MS + 1).state).toBe('stale')
    expect(cardNow({ ...card, state: 'done' }, null, 1000).state).toBe('done')
  })

  it('keeps one card per task and action', () => {
    const a = { id: 'a', task: 'WEB-3', kind: 'step', at: 10 } as UiCard, b = { id: 'b', task: 'WEB-3', kind: 'resume', at: 10 } as UiCard
    expect(keepCards([a, b], { ...a, id: 'c', at: 20 }, 30).map(c => c.id)).toEqual(['c', 'b'])
  })
})

describe('ui action: the command and the block', () => {
  it('takes a closed list of actions', () => {
    expect(parseCommand(['ui', 'action', 'step', 'WEB-3'])).toEqual({ name: 'ui action', action: 'step', task: 'WEB-3' })
    expect(parseCommand(['ui', 'action', 'merge', 'WEB-3'])).toMatchObject({ error: expect.stringContaining('usage') })
    expect(parseCommand(['ui', 'action', 'resume'])).toMatchObject({ error: expect.stringContaining('usage') })
    expect(parseActionLine('action 0123456789abcdef')).toBe('0123456789abcdef')
    expect(parseActionLine('action WEB-3')).toBeNull()
  })
})

describe('ui action: the click', () => {
  function store(task: Task) {
    const rec = { project: 'WEB', tokenHash: '' } as { project: string, tokenHash: string, cards?: UiCard[] }
    const s = {
      task: async () => task, projects: async () => [{ key: 'WEB' }], project: async () => ({ key: 'WEB' }),
      workflow: async () => ({ taskTypes: {} }), coordinator: async () => rec, coordinators: async () => [rec],
      saveCoordinator: async (r: typeof rec) => { Object.assign(rec, r) },
    }
    return { s: s as never, rec }
  }

  it('is refused in a wake and on a step that does not wait for the user', async () => {
    const { s } = store(atMerge)
    await expect(addAction(s, { scope: 'WEB', turn: 'wake', by: 'WEB coordinator', kind: 'step', task: atMerge })).rejects.toThrow(/never in a wake/)
    await expect(addAction(s, { scope: 'WEB', turn: 'user', by: 'WEB coordinator', kind: 'resume', task: atMerge })).rejects.toThrow(/not stopped/)
  })

  it('runs the step\'s own handler once, from the session only', async () => {
    const { s, rec } = store(atMerge)
    const out = await addAction(s, { scope: 'WEB', turn: 'user', by: 'WEB coordinator', kind: 'step', task: atMerge })
    expect(out.button).toBe('Merge')
    const id = rec.cards![0]!.id
    expect(out.note).toContain(`action ${id}`)
    expect(userStep).not.toHaveBeenCalled()
    // A CLI token never clicks.
    await expect(actOnCard({ store: s } as never, id, 'Bearer abc')).rejects.toThrow(/never a token/)
    const done = await actOnCard({ store: s } as never, id, undefined)
    expect(done).toMatchObject({ state: 'done', outcome: { text: 'Merge: done by you' } })
    expect(userStep).toHaveBeenCalledTimes(1)
    // Clicked again: nothing runs.
    await actOnCard({ store: s } as never, id, undefined)
    expect(userStep).toHaveBeenCalledTimes(1)
  })

  it('keeps the card open on a refused merge, and says a queued one has not merged', async () => {
    const { s, rec } = store(atMerge)
    await addAction(s, { scope: 'WEB', turn: 'user', by: 'WEB coordinator', kind: 'step', task: atMerge })
    const id = rec.cards![0]!.id
    const refused = { ...atMerge, step: { ...atMerge.step!, yourTurn: { reason: 'action', badge: 'Merge: the PR has conflicts' } } }
    userStep.mockResolvedValueOnce(refused as never)
    expect(await actOnCard({ store: s } as never, id, undefined)).toMatchObject({ state: 'open', refused: 'Merge: the PR has conflicts' })
    expect(rec.cards![0]!.state).toBe('open')
    // The click approves the merge; the PR is not ready yet, so no queue place either.
    userStep.mockResolvedValueOnce({ ...atMerge, step: { ...atMerge.step!, approved: { by: 'user', at: 1 } } } as never)
    expect(await actOnCard({ store: s } as never, id, undefined)).toMatchObject({ state: 'done', outcome: { text: 'Merge: approved by you, merges once ready' } })
  })

  it('runs nothing once the step changed', async () => {
    const { s, rec } = store(atMerge)
    await addAction(s, { scope: 'WEB', turn: 'user', by: 'WEB coordinator', kind: 'step', task: atMerge })
    // The task was sent back and entered merge again later.
    atMerge.step!.since = 800
    expect(await readCard(s, rec.cards![0]!.id)).toMatchObject({ state: 'stale' })
    const before = userStep.mock.calls.length
    expect(await actOnCard({ store: s } as never, rec.cards![0]!.id, undefined)).toMatchObject({ state: 'stale' })
    expect(userStep).toHaveBeenCalledTimes(before)
    expect(resumeTask).not.toHaveBeenCalled()
  })
})
