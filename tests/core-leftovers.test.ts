import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('core mode: state is not rebuilt from the empty legacy machines', () => {
  vi.setConfig({ testTimeout: 30000 })
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.restoreAllMocks() })

  it('schedules no legacy rebuild at load and keeps the core state', async () => {
    const good = { ok: true, workspaces: [{ id: 'w1', label: 'w' }], tabs: [], panes: [] }
    const entry = {
      primary: true,
      endpoint: '/run/hc.sock',
      localKey: '',
      sessionName: undefined,
      session: { connected: false, start: () => {}, stop: () => {}, get: () => undefined, snapshot: () => null },
      call: async () => ({}),
      machines: () => [],
      snapshot: () => null,
      state: () => good,
      poll: async () => good,
      staleDocs: () => {},
      ownsMachine: (k: string) => k === '',
      start: () => {},
      stop: () => {},
    }
    vi.doMock('../server/utils/corePool', () => ({
      resolveConfiguredSockets: () => ({ primary: '/run/hc.sock', extra: [] }),
      createCorePool: () => ({
        entries: () => [entry],
        primary: () => entry,
        forPane: () => entry,
        forMachine: () => entry,
        findPane: () => undefined,
        state: () => good,
        poll: async () => good,
        settle: async () => good,
        staleDocs: () => {},
        reconfigure: () => {},
        start: () => {},
        stop: () => {},
      }),
      registerPoolRuntime: () => {},
      getPoolRuntime: () => null,
    }))
    vi.doMock('../server/utils/coreScreenDeps', () => ({ coreScreens: () => ({ enrich: async () => {} }) }))
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const s = await import('../server/utils/state')
    expect(timer).not.toHaveBeenCalled()
    await s.poll()
    expect(s.getState().ok).toBe(true)
    expect(s.getState().workspaces).toHaveLength(1)
  })
})

describe('core mode: pasted texts are kept', () => {
  it('coreSend keeps the pasted blocks of a message but not of a slash command', async () => {
    vi.resetModules()
    const keep = vi.fn()
    vi.doMock('../server/utils/pastes', () => ({ keepPastes: keep }))
    const { coreSend } = await import('../server/utils/coreInput')
    const d = { call: async () => ({ started: true }), pane: () => ({ id: 't1', coreAddress: 'm/t1' }), panes: () => [], refresh: () => {} } as never
    await coreSend(d, { pane_id: 't1', text: 'see this', pastes: [[4, 8]] } as never)
    await coreSend(d, { pane_id: 't1', text: '/clear', pastes: [] } as never)
    expect(keep).toHaveBeenCalledTimes(1)
    expect(keep).toHaveBeenCalledWith('see this', [[4, 8]])
  })
})
