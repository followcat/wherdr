import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ChatRunningTime from '~/components/ChatRunningTime.vue'

describe('running time', () => {
  afterEach(() => { vi.useRealTimers() })

  it('ticks once a second on its own', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const w = await mountSuspended(ChatRunningTime, { props: { since: 100_000 - 5000 } })
    expect(w.text()).toBe('Running · 5 s')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.text()).toBe('Running · 1 min 05 s')
    w.unmount()
  })
})
