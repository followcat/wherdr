import { describe, expect, it } from 'vitest'
import { BACKDROP_CELL, nextPacketDelay, planPacket } from '../app/utils/backdrop'

// Deterministic source cycling through the given values.
function seq(...v: number[]) {
  let i = 0
  return () => v[i++ % v.length]!
}

describe('planPacket', () => {
  it('starts every packet on a grid line of a centred grid', () => {
    for (const w of [390, 1440]) {
      for (let s = 0; s < 50; s++) {
        let x = s * 7919
        const p = planPacket(w, 800, () => { x = (x * 16807 + 11) % 2147483647; return x / 2147483647 })
        const col = (p.left - (w / 2 - BACKDROP_CELL / 2)) / BACKDROP_CELL
        expect(Number.isInteger(Math.round(col * 1e6) / 1e6)).toBe(true)
        expect(p.top % BACKDROP_CELL).toBe(0)
        expect(p.dist).toBe(p.cells * BACKDROP_CELL)
        expect(p.cells).toBeGreaterThanOrEqual(4)
        expect(p.cells).toBeLessThanOrEqual(9)
      }
    }
  })
  it('runs vertically for low draws and keeps vertical packets in the upper half', () => {
    const p = planPacket(390, 844, seq(0.1, 0.99))
    expect(p.vertical).toBe(true)
    expect(p.top).toBeLessThanOrEqual(844 * 0.45 + BACKDROP_CELL)
  })
})

describe('nextPacketDelay', () => {
  it('alternates short bursts and long pauses', () => {
    expect(nextPacketDelay(seq(0.1, 0))).toBe(2600)
    expect(nextPacketDelay(seq(0.5, 1))).toBe(1800)
  })
})
