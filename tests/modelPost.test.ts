// POST /api/model: request validation around the driver — bad pane, a
// missing or oversized label, parts whittled to lead/sidekick, and the
// controller's own errors (busy, bad_model) passed through.
import { afterEach, expect, it, vi } from 'vitest'
import { PANE_RE } from '../shared/ids'
import { HerdrError } from '../server/utils/herdr'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

const handler = async (setModel: (pane: string, wanted: string, parts?: Record<string, string>) => Promise<unknown>, refresh = vi.fn()) => {
  for (const [k, v] of Object.entries({
    defineApi: (h: unknown) => h,
    PANE_RE,
    HerdrError,
    coreModelCtl: () => ({ setModel }),
    findPane: () => ({ id: 'w1:p1' }),
    refreshModel: refresh,
  })) vi.stubGlobal(k, v)
  return (await import('../server/api/model.post')).default as unknown as (e: unknown, b: unknown) => Promise<unknown>
}

it('rejects a malformed pane id', async () => {
  const h = await handler(async () => ({}))
  await expect(h({}, { pane_id: 'nope', label: 'Sonnet 5' })).rejects.toMatchObject({ code: 'bad_pane' })
})

it('rejects an oversized label before the driver', async () => {
  const calls: unknown[] = []
  const h = await handler(async (p, w) => { calls.push([p, w]); return {} })
  await expect(h({}, { pane_id: 'w1:p1', label: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'bad_model' })
  expect(calls).toHaveLength(0)
})

it('passes label/wanted to the driver and keeps only lead/sidekick parts', async () => {
  const calls: unknown[] = []
  const h = await handler(async (p, w, parts) => { calls.push([p, w, parts]); return { label: 'Sonnet 5' } })
  const r = await h({}, { pane_id: 'w1:p1', label: 'Sonnet 5', parts: { lead: 'L', sidekick: 'S', other: 'x', bad: 3 } })
  expect(r).toEqual({ ok: true, model: { label: 'Sonnet 5' } })
  expect(calls).toEqual([['w1:p1', 'Sonnet 5', { lead: 'L', sidekick: 'S' }]])
  const h2 = await handler(async (p, w, parts) => { calls.push([p, w, parts]); return {} })
  await h2({}, { pane_id: 'w1:p1', wanted: 'acme/alpha' })
  expect(calls[1]).toEqual(['w1:p1', 'acme/alpha', undefined])
})

it('propagates controller errors and refreshes the pane on success', async () => {
  const refresh = vi.fn()
  const h = await handler(async () => { throw new HerdrError('busy', 'Model operation already running') }, refresh)
  await expect(h({}, { pane_id: 'w1:p1', label: 'Sonnet 5' })).rejects.toMatchObject({ code: 'busy' })
  expect(refresh).not.toHaveBeenCalled()
  const h2 = await handler(async () => ({ label: 'Sonnet 5' }), refresh)
  await h2({}, { pane_id: 'w1:p1', label: 'Sonnet 5' })
  expect(refresh).toHaveBeenCalledWith({ id: 'w1:p1' })
})
