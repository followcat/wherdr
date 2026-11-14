// GET /api/efforts and POST /api/effort: request validation around the
// driver — bad pane, oversized level — and the controller's own errors
// (busy, unsupported) passed through; refreshModel on success only.
import { afterEach, expect, it, vi } from 'vitest'
import { PANE_RE } from '../shared/ids'
import { HerdrError } from '../server/utils/herdr'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

const getHandler = async (listEfforts: (pane: string) => Promise<unknown>, refresh = vi.fn()) => {
  for (const [k, v] of Object.entries({
    defineApi: (h: unknown) => h,
    getQuery: (e: any) => e.query || {},
    PANE_RE,
    HerdrError,
    coreModelCtl: () => ({ listEfforts }),
    findPane: () => ({ id: 'w1:p1' }),
    refreshModel: refresh,
  })) vi.stubGlobal(k, v)
  return (await import('../server/api/efforts.get')).default as unknown as (e: unknown) => Promise<unknown>
}

const postHandler = async (setEffort: (pane: string, level: string) => Promise<unknown>, refresh = vi.fn()) => {
  for (const [k, v] of Object.entries({
    defineApi: (h: unknown) => h,
    PANE_RE,
    HerdrError,
    coreModelCtl: () => ({ setEffort }),
    findPane: () => ({ id: 'w1:p1' }),
    refreshModel: refresh,
  })) vi.stubGlobal(k, v)
  return (await import('../server/api/effort.post')).default as unknown as (e: unknown, b: unknown) => Promise<unknown>
}

it('efforts.get rejects a malformed pane id', async () => {
  const h = await getHandler(async () => ({}))
  await expect(h({ query: { pane: 'nope' } })).rejects.toMatchObject({ code: 'bad_pane' })
})

it('efforts.get returns the list and refreshes only when a current exists', async () => {
  const refresh = vi.fn()
  const h = await getHandler(async () => ({ levels: ['low', 'high'], current: 'low' }), refresh)
  const r = await h({ query: { pane: 'w1:p1' } })
  expect(r).toEqual({ levels: ['low', 'high'], current: 'low' })
  expect(refresh).toHaveBeenCalledWith({ id: 'w1:p1' })
  const h2 = await getHandler(async () => ({ levels: [], current: null }), refresh)
  await h2({ query: { pane: 'w1:p1' } })
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('efforts.get propagates busy', async () => {
  const h = await getHandler(async () => { throw new HerdrError('busy', 'A model operation is already running on this pane') })
  await expect(h({ query: { pane: 'w1:p1' } })).rejects.toMatchObject({ code: 'busy' })
})

it('effort.post rejects a malformed pane id and an oversized level', async () => {
  const calls: unknown[] = []
  const h = await postHandler(async (p, l) => { calls.push([p, l]); return {} })
  await expect(h({}, { pane_id: 'nope', level: 'high' })).rejects.toMatchObject({ code: 'bad_pane' })
  await expect(h({}, { pane_id: 'w1:p1', level: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'bad_effort' })
  expect(calls).toHaveLength(0)
})

it('effort.post passes the level to the driver and refreshes on success', async () => {
  const calls: unknown[] = []
  const refresh = vi.fn()
  const h = await postHandler(async (p, l) => { calls.push([p, l]); return { label: 'Opus 5.5', effort: 'high' } }, refresh)
  const r = await h({}, { pane_id: 'w1:p1', level: 'high' })
  expect(r).toEqual({ ok: true, model: { label: 'Opus 5.5', effort: 'high' } })
  expect(calls).toEqual([['w1:p1', 'high']])
  expect(refresh).toHaveBeenCalledWith({ id: 'w1:p1' })
})

it('effort.post propagates busy and unsupported, without refreshing', async () => {
  const refresh = vi.fn()
  const busy = await postHandler(async () => { throw new HerdrError('busy', 'A model operation is already running on this pane') }, refresh)
  await expect(busy({}, { pane_id: 'w1:p1', level: 'high' })).rejects.toMatchObject({ code: 'busy' })
  const uns = await postHandler(async () => { throw new HerdrError('unsupported', 'This agent’s effort cannot be changed from wherdr') }, refresh)
  await expect(uns({}, { pane_id: 'w1:p1', level: 'high' })).rejects.toMatchObject({ code: 'unsupported' })
  expect(refresh).not.toHaveBeenCalled()
})
