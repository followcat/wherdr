// OpenCode model switching goes through the service PATCH, never typed
// keys: its identity checks (provider-qualified labels, full model
// verification) are what keep the wrong entry from being selected.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ sent: [] as { method: string, params: Record<string, unknown> }[], pane: {} as Record<string, unknown> }))

vi.mock('../server/utils/env', async (importOriginal) => ({ ...(await importOriginal()), log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => calls.pane,
  poll: () => {},
  transcripts: {
    model: async () => ({ id: 'alpha-1', label: 'Alpha' }),
    opencodeModels: async () => [
      { id: 'alpha-1', providerID: 'prov-a', name: 'Alpha', enabled: true, variants: ['max'] },
      { id: 'alpha-2', providerID: 'prov-b', name: 'Alpha', enabled: true, variants: ['min'] },
      { id: 'solo', providerID: 'prov-a', name: 'Solo', enabled: true, variants: ['max'] },
    ],
    opencodePatchModel: async (_p: unknown, m: { id: string, providerID: string, variant?: string }) => ({ model: m }),
  },
}))
vi.mock('../server/utils/herdr', () => {
  const herdr = async (method: string, params: Record<string, unknown>) => {
    calls.sent.push({ method, params })
    return {}
  }
  return {
    HerdrError: class HerdrError extends Error {
      constructor(public code: string, message: string) { super(message) }
    },
    sleep: async () => {},
    herdr,
    agentPrompt: async (target: string, text: string) => { await herdr('agent.prompt', { target, text }) },
  }
})

import { setModel } from '../server/utils/modelctl'

beforeEach(() => {
  calls.sent = []
  calls.pane = { id: 'w1:p1', agent: 'opencode', status: 'idle' }
})

describe('opencodeSetModel identity', () => {
  it('duplicate display names need their provider-suffixed label', async () => {
    // Bare "Alpha" is ambiguous → refused before any PATCH.
    await expect(setModel('w1:p1', 'Alpha')).rejects.toMatchObject({ code: 'bad_model' })
    // The provider-qualified label selects the second provider's entry.
    const info = await setModel('w1:p1', 'Alpha (prov-b)')
    expect(info.id).toBe('alpha-2')
    expect(info.effort).toBe('min')
  })

  it('a blocked pane is refused before any catalog read', async () => {
    calls.pane.status = 'blocked'
    await expect(setModel('w1:p1', 'Solo')).rejects.toMatchObject({ code: 'busy' })
    expect(calls.sent).toEqual([])
  })

  it('a verification that returns another provider is stale', async () => {
    const { transcripts } = await import('../server/utils/state')
    const spy = vi.spyOn(transcripts, 'opencodePatchModel').mockResolvedValueOnce({ model: { id: 'solo', providerID: 'other-prov', variant: 'max' } } as never)
    await expect(setModel('w1:p1', 'Solo')).rejects.toMatchObject({ code: 'stale' })
    spy.mockRestore()
  })
})
