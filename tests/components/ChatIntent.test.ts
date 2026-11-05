import { expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useChatIntent } from '~/composables/useChatIntent'
import { cachedAt, eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

let reads = 0
registerEndpoint('/api/chat', () => {
  reads++
  return { available: true, file: 'fixture', token: 'v1', start: 4096, items: [] }
})
const pane = { id: 'w1:p1', machine: 'demo', agent: 'claude', agentSession: 'first' } as Pane
it('guards lock, offline and remote state; invalidation survives the card unmount', async () => {
  herdrState.value = { ok: true, session: 'test', panes: [pane], workspaces: [], machines: [{ key: 'demo', label: 'Demo', local: false, status: 'online', error: null }] }
  eventsOpen.value = true
  let intent!: ReturnType<typeof useChatIntent>
  const card = await mountSuspended(defineComponent({ setup() { intent = useChatIntent(); return () => h('div') } }))
  try {
    for (const flag of [locked, netDown, cachedAt]) {
      flag.value = (flag === cachedAt ? Date.now() : true) as never
      intent.preload(pane)
      expect(await intent.take(pane)).toBeUndefined()
      flag.value = (flag === cachedAt ? null : false) as never
    }
    expect(reads).toBe(0)
    intent.preload(pane)
    await flushPromises()
    expect(reads).toBe(1)
    card.unmount()
    locked.value = true
    locked.value = false
    expect(await intent.take(pane)).toBeUndefined()
    herdrState.value = { ...herdrState.value, machines: [{ key: 'demo', label: 'Demo', local: false, status: 'offline', error: null }] }
    intent.preload(pane)
    await flushPromises()
    expect(reads).toBe(1)
  } finally {
    card.unmount()
    locked.value = false
    netDown.value = false
    cachedAt.value = null
    eventsOpen.value = false
  }
})

it('never preloads or takes a Command Code pane', async () => {
  herdrState.value = { ok: true, session: 'test', panes: [pane], workspaces: [], machines: [{ key: 'demo', label: 'Demo', local: false, status: 'online', error: null }] }
  eventsOpen.value = true
  reads = 0
  let intent!: ReturnType<typeof useChatIntent>
  const card = await mountSuspended(defineComponent({ setup() { intent = useChatIntent(); return () => h('div') } }))
  try {
    const cmd = { ...pane, agent: 'cmd' } as Pane
    intent.preload(cmd)
    await flushPromises()
    expect(reads).toBe(0)
    expect(await intent.take(cmd)).toBeUndefined()
    intent.preload(pane)
    await flushPromises()
    expect(reads).toBe(1)
  } finally {
    card.unmount()
    eventsOpen.value = false
    herdrState.value = { ok: false, workspaces: [], panes: [] }
  }
})
