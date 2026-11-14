import { describe, expect, it } from 'vitest'
import { createCoreScreens } from '../server/utils/coreScreen'
import type { Pane } from '../shared/types'

const pane = (over: Partial<Pane> = {}) => ({
  id: 'w1:p1', agent: 'claude', status: 'idle', coreAddress: 't-1', ...over,
} as Pane)

describe('coreScreen → noted (model/effort screen caches)', () => {
  it('feeds noted on each real terminal.read, never on a cached screen', async () => {
    let t = 0
    const noted: [string, string][] = []
    const screens = createCoreScreens({
      call: async () => ({ text: 'screen' }),
      viewed: () => false,
      noted: (p, text) => { noted.push([p.id, text]) },
      now: () => t,
    })
    const p = pane()
    await screens.enrich([p])
    expect(noted).toEqual([[p.id, 'screen']])
    // An open pane is read every poll for its first 30 s (STARTUP_MS), so the
    // cache-hit path starts once that window closes.
    t = 31_000
    await screens.enrich([p])
    expect(noted).toHaveLength(2)
    // Cache hit inside the idle pace: no read, no note (same as v2 — the
    // model/effort caches only refresh when the screen itself is re-read).
    t = 31_100
    await screens.enrich([p])
    expect(noted).toHaveLength(2)
    // Past the idle pace the screen is read again — and noted again.
    t = 36_500
    await screens.enrich([p])
    expect(noted).toHaveLength(3)
    // A working pane is skipped entirely (not read, not noted).
    const w = pane({ id: 'w1:p2', status: 'working' })
    await screens.enrich([w])
    expect(noted).toHaveLength(3)
  })
})
