import { describe, expect, it } from 'vitest'
import { liveRunSpot } from '../app/utils/liveRunPlace'

type B = { k: string, key: string, ms?: number }
const timeOf = (b: B) => b.ms

describe('liveRunSpot', () => {
  const t0 = 1_000_000
  it('goes before a message sent after the run started', () => {
    const blocks: B[] = [{ k: 'user', key: 'u0', ms: t0 - 5000 }, { k: 'assistant', key: 'a0', ms: t0 - 1000 }, { k: 'user', key: 'u1', ms: t0 + 2000 }]
    expect(liveRunSpot(blocks, t0, timeOf)).toBe('u1')
  })
  it('stays last when nothing came after it', () => {
    expect(liveRunSpot([{ k: 'user', key: 'u0', ms: t0 - 5000 }, { k: 'turn', key: 'e' }], t0, timeOf)).toBeNull()
  })
  it('keeps the agent-name and day lines with the reply that follows', () => {
    const blocks: B[] = [{ k: 'user', key: 'u0', ms: t0 - 5000 }, { k: 'day', key: 'd' }, { k: 'who', key: 'w' }, { k: 'assistant', key: 'a1', ms: t0 + 1 }]
    expect(liveRunSpot(blocks, t0, timeOf)).toBe('d')
  })
})
