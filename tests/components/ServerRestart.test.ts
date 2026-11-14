import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { cachedAt, connectEvents, herdrState, linkShown, netDown, offlineView, reconnectEvents } from '~/composables/useHerdr'
import { startingState } from '#shared/stateReady'
import type { HerdrState, Pane } from '#shared/types'

// wherdr updates itself: its server restarts. The page keeps what it shows
// through the cut and the restarted server's first, empty state; only the
// "Reload" banner tells about the update.
const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
const live: HerdrState = { ok: true, ready: true, workspaces: [], panes: [pane], machines: [{ key: '', label: 'Local', local: true, status: 'online', error: null }] }

registerEndpoint('/api/auth/status', () => ({ enabled: false, unlocked: true }))

const sockets: FakeSocket[] = []
class FakeSocket {
  readyState = 0
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: (() => void) | null
  constructor() { sockets.push(this) }
  send() {}
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  push(s: HerdrState) { this.onmessage?.({ data: JSON.stringify(s) }) }
}

describe('server restart for an update', () => {
  beforeEach(() => {
    sockets.length = 0
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    connectEvents()
    sockets[0]!.open()
    sockets[0]!.push(live)
  })
  afterEach(() => {
    for (const s of sockets) { s.onclose = null; s.readyState = 3 }
    reconnectEvents()
    for (const s of sockets) { s.onclose = null; s.readyState = 3 }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    herdrState.value = { ok: false, workspaces: [], panes: [] }
    cachedAt.value = null
  })

  it('keeps the state and the live views through the cut and the empty first state', async () => {
    sockets[0]!.onclose!()
    await flushPromises()
    // A short cut: no offline placeholder, the composer stays usable.
    expect(linkShown.value).toBe(true)
    expect(offlineView.value).toBe(false)

    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    sockets[1]!.push(startingState())
    expect(herdrState.value.panes.map(p => p.id)).toEqual(['w1:p1'])

    sockets[1]!.push({ ...live, panes: [{ ...pane, status: 'working' }] })
    expect(herdrState.value.panes[0]!.status).toBe('working')
    vi.advanceTimersByTime(5000)
    expect(netDown.value).toBe(false)
    expect(offlineView.value).toBe(false)
  })

  // Stopped for 10 s, then the starting state for 3 s. Each attempt meanwhile is refused.
  it.each([true, false])('a restart longer than the grace keeps the live look (announced=%s)', async (announced) => {
    const steady = () => {
      expect(linkShown.value).toBe(true)
      expect(offlineView.value).toBe(false)
      expect(netDown.value).toBe(false)
      expect(herdrState.value.panes.map(p => p.id)).toEqual(['w1:p1'])
    }
    if (announced) sockets[0]!.push({ type: 'restarting' } as unknown as HerdrState)
    sockets[0]!.onclose!()
    await flushPromises()
    if (!announced) {
      // Unannounced (a crash): back within the grace, with only the starting state.
      vi.advanceTimersByTime(600)
      sockets.at(-1)!.open()
      sockets.at(-1)!.push(startingState())
      sockets.at(-1)!.onclose!()
      await flushPromises()
    }
    for (let t = 0; t < 10; t++) {
      vi.advanceTimersByTime(1000)
      const s = sockets.at(-1)!
      if (s.readyState === 0) { s.readyState = 3; s.onclose!(); await flushPromises() }
      steady()
    }
    vi.advanceTimersByTime(1000)
    sockets.at(-1)!.open()
    sockets.at(-1)!.push(startingState())
    vi.advanceTimersByTime(3000)
    steady()
    sockets.at(-1)!.push(live)
    vi.advanceTimersByTime(5000)
    steady()
  })

  it('a longer cut shows the last known state, offline', async () => {
    sockets[0]!.onclose!()
    await flushPromises()
    vi.advanceTimersByTime(2600)
    expect(netDown.value).toBe(true)
    expect(linkShown.value).toBe(false)
    expect(offlineView.value).toBe(true)
    expect(herdrState.value.panes.map(p => p.id)).toEqual(['w1:p1'])
  })
})
