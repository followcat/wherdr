import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { computed, defineComponent, h } from 'vue'
import { UApp } from '#components'
import ChatView from '~/components/ChatView.vue'
import Composer from '~/components/Composer.vue'
import { connectEvents, herdrState, recoverEvents, reconnectEvents } from '~/composables/useHerdr'
import type { HerdrState, Pane } from '#shared/types'

// A tab asleep (computer locked, phone in a pocket) misses the push where the
// agent went idle. On waking, the working row and Stop must come from the
// state the server sends on the new socket, not stay from the last push
// before the sleep.
const ID = 'w1:p9'
const pane = (status: Pane['status']): Pane => ({ id: ID, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status, title: null, cwd: '/home/user/demo', agentSession: null })
const state = (status: Pane['status']): HerdrState => ({ ok: true, workspaces: [], panes: [pane(status)] })

registerEndpoint('/api/chat', () => ({ available: true, token: 'wake', file: '/home/user/demo/transcript.jsonl', start: 0, items: [{ role: 'user', text: 'Rename the helper.', ts: '2026-01-01T00:00:00Z' }] }))
registerEndpoint('/api/auth/status', () => ({ enabled: false, unlocked: true }))

const sockets: FakeSocket[] = []
class FakeSocket {
  readyState = 0
  sent: string[] = []
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: (() => void) | null
  constructor() { sockets.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
  open(s: HerdrState) { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify(s) }) }
}

async function mountLive() {
  const Host = defineComponent({
    setup() {
      const live = computed(() => herdrState.value.panes.find(p => p.id === ID))
      return () => h(UApp, null, () => live.value
        ? [h(ChatView, { pane: live.value, localQueued: [] }), h(Composer, { pane: live.value, paneId: ID, sendKeys: async () => {} })]
        : [])
    },
  })
  const w = await mountSuspended(Host)
  const working = () => /is working…|travaille…/.test(w.text())
  const stop = () => w.find('button.prompt-send').attributes('aria-label') || ''
  return { w, working, stop }
}

describe('working state after a sleep or a reconnect', () => {
  beforeEach(() => { sockets.length = 0; vi.stubGlobal('WebSocket', FakeSocket) })
  afterEach(() => {
    // Leave no live socket behind: the next test's connectEvents opens its own.
    for (const s of sockets) s.readyState = 3
    vi.useRealTimers()
    vi.unstubAllGlobals()
    herdrState.value = { ok: false, workspaces: [], panes: [] }
  })

  it('a dropped socket: the state sent on reconnect clears the working row and Stop', async () => {
    connectEvents()
    sockets[0]!.open(state('working'))
    const { w, working, stop } = await mountLive()
    await vi.waitFor(() => expect(working()).toBe(true))
    expect(stop()).toMatch(/stop/i)

    // Asleep: the socket drops, the turn ends meanwhile. No push reaches the page.
    sockets[0]!.onclose!()
    await flushPromises()
    reconnectEvents()
    expect(sockets).toHaveLength(2)
    sockets[1]!.open(state('idle'))

    await vi.waitFor(() => expect(working()).toBe(false))
    expect(stop()).not.toMatch(/stop/i)
    w.unmount()
  })

  it('a zombie socket found on wake (no pong): replaced, and its fresh state clears Stop', async () => {
    connectEvents()
    sockets[0]!.open(state('working'))
    const { w, working, stop } = await mountLive()
    await vi.waitFor(() => expect(working()).toBe(true))

    // Woken up: the socket still reads as open but the server is gone. The
    // probe gets no pong, so the socket is replaced.
    vi.useFakeTimers()
    const woke = recoverEvents()
    expect(sockets[0]!.sent.some(d => JSON.parse(d).type === 'ping')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    await woke
    vi.useRealTimers()
    expect(sockets).toHaveLength(2)
    sockets[1]!.open(state('idle'))

    await vi.waitFor(() => expect(working()).toBe(false))
    expect(stop()).not.toMatch(/stop/i)
    w.unmount()
  })
})
