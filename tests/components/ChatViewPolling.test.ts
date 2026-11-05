import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, getCurrentInstance, h, nextTick, shallowRef } from 'vue'
import { UApp } from '#components'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const idle: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
const items: ChatItem[] = [
  { role: 'user', text: 'Rename the helper.', ts: '2026-01-01T00:00:00Z' },
  { role: 'tool', text: 'src/helper.ts', name: 'Edit', ts: '2026-01-01T00:00:01Z' },
  { role: 'assistant', text: 'Renamed.', ts: '2026-01-01T00:00:05Z' },
]
let reads = 0
registerEndpoint('/api/chat', () => {
  reads++
  return { available: true, token: 'polling', file: '/home/user/demo/transcript.jsonl', start: 0, items }
})

// The pane as the live state hands it to the view: a new object on each push.
const current = shallowRef<Pane>(idle)
// Updates of each component kind while `counting` is on.
const updates = new Map<string, number>()
let counting = false
const countUpdates = { updated() { if (!counting) return; const type = getCurrentInstance()?.type as { name?: string, __name?: string } | undefined; const name = type?.name || type?.__name || '?'; updates.set(name, (updates.get(name) || 0) + 1) } }
async function mountIdle() {
  current.value = idle
  herdrState.value = { ok: true, workspaces: [], panes: [idle] }
  const Host = defineComponent({ render: () => h(UApp, null, () => h(ChatView, { pane: current.value, localQueued: [] })) })
  const w = await mountSuspended(Host, { global: { mixins: [countUpdates] } })
  await expect.poll(() => w.find('.chat').text()).toContain('Renamed.')
  const push = async (pane: Pane) => { current.value = pane; await nextTick() }
  return { w, push, view: () => w.findComponent(ChatView) }
}
// Lets a read in flight finish (its render waits for a frame).
const settle = async () => { await vi.advanceTimersByTimeAsync(50); await flushPromises() }

describe('conversation polling', () => {
  afterEach(() => { vi.useRealTimers(); herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('re-reads every few seconds when idle, every 1.5 s while working or blocked, and at once on a status or preview change', async () => {
    const { w, push, view } = await mountIdle()
    vi.useFakeTimers()
    try {
      // A preview change re-reads at once, then the idle period applies.
      reads = 0
      await push({ ...idle, preview: 'Renamed.' })
      await settle()
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(4000)
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(reads).toBe(2)
      await settle()

      // Working: at once, then every 1.5 s.
      reads = 0
      await push({ ...idle, status: 'working' })
      await settle()
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(1500)
      expect(reads).toBe(2)
      await vi.advanceTimersByTimeAsync(1500)
      expect(reads).toBe(3)
      await settle()

      // Blocked keeps the quick period.
      reads = 0
      await push({ ...idle, status: 'blocked' })
      await settle()
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(1500)
      expect(reads).toBe(2)
      await settle()

      // Back to idle: one read at once, then nothing before the idle period.
      reads = 0
      await push({ ...idle })
      await settle()
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(reads).toBe(1)
    } finally { w.unmount() }
  })

  it('does not re-read on a push that leaves status and preview as they were', async () => {
    const { w, push } = await mountIdle()
    vi.useFakeTimers()
    try {
      reads = 0
      // 30 pushes in 3 s: each one a new pane object (title, name…), same status and preview.
      for (let i = 0; i < 30; i++) {
        await push({ ...idle, title: `demo ${i}`, name: `run ${i}` })
        await vi.advanceTimersByTimeAsync(100)
      }
      await settle()
      expect(reads).toBe(0)
    } finally { w.unmount() }
  })

  it('stops polling once unmounted', async () => {
    const { w, push, view } = await mountIdle()
    vi.useFakeTimers()
    await push({ ...idle, status: 'working' })
    await settle()
    w.unmount()
    reads = 0
    await vi.advanceTimersByTimeAsync(10000)
    expect(reads).toBe(0)
  })
})

describe('conversation blocks', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('are not rebuilt by a live push that only changes the preview, and are when the agent starts working', async () => {
    const { w, push, view } = await mountIdle()
    const vm = view().vm as unknown as { blocks: { k: string }[] }
    try {
      const before = vm.blocks
      expect(before.some(b => b.k === 'turn')).toBe(true)
      expect(w.findAll('.turn-end')).toHaveLength(1)

      await push({ ...idle, preview: 'Renamed.', title: 'demo' })
      expect(vm.blocks).toBe(before)

      await push({ ...idle, status: 'working' })
      expect(vm.blocks).not.toBe(before)
      expect(vm.blocks.some(b => b.k === 'turn')).toBe(false)
      expect(w.findAll('.turn-end')).toHaveLength(0)
    } finally { w.unmount() }
  })

  it('are not re-rendered by pushes that change neither them nor the status line, nor by a new working verb', async () => {
    const { w, push } = await mountIdle()
    try {
      const pushes = async (make: (i: number) => Pane) => {
        updates.clear()
        counting = true
        for (let i = 0; i < 10; i++) await push(make(i))
        await nextTick()
        counting = false
        return new Map(updates)
      }
      // Before the fix, every push re-rendered every message.
      const quiet = await pushes(i => ({ ...idle, title: `demo ${i}` }))
      expect(quiet.get('UChatMessage') ?? 0).toBe(0)
      await push({ ...idle, status: 'working', activity: 'Thinking' })
      await expect.poll(() => w.find('.claude-verb').exists()).toBe(true)
      const verbs = await pushes(i => ({ ...idle, status: 'working', activity: `Step ${i}` }))
      expect(verbs.get('UChatMessage') ?? 0).toBe(0)
      expect(verbs.get('ChatStatusLine')).toBe(10)
      expect(w.find('.claude-verb').text()).toContain('Step 9')
    } finally { w.unmount() }
  })
})
