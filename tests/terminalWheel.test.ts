import { describe, expect, it } from 'vitest'
import { takeLines, takeTouchLines, wheelPixels } from '../app/utils/terminalWheel'

describe('wheelPixels', () => {
  it('garde les pixels tels quels', () => {
    expect(wheelPixels(-100, 0, 16, 40)).toBe(-100)
  })
  it('converts lines (Firefox) and pages', () => {
    expect(wheelPixels(3, 1, 16, 40)).toBe(48)
    expect(wheelPixels(-1, 2, 16, 40)).toBe(-640)
  })
})

describe('takeLines', () => {
  it('returns whole lines and keeps the remainder', () => {
    expect(takeLines(50, 16)).toEqual({ lines: 3, rest: 2 })
    expect(takeLines(-50, 16)).toEqual({ lines: -3, rest: -2 })
  })
  it('does nothing below one line', () => {
    expect(takeLines(10, 16)).toEqual({ lines: 0, rest: 10 })
  })
  it('guards against a zero line height', () => {
    expect(takeLines(32, 0)).toEqual({ lines: 2, rest: 0 })
  })
})


describe('touch row quantization', () => {
  it('does not reverse a wheel tick for a tiny movement around the rounding boundary', () => {
    expect(takeTouchLines(-9, 16, 1)).toEqual({ lines: 0, rest: -9 })
    expect(takeTouchLines(-16, 16, 1)).toEqual({ lines: -1, rest: 0 })
    expect(takeTouchLines(9, 16, -1)).toEqual({ lines: 0, rest: 9 })
  })
  it('responds to a sub-row drag while keeping the total rounding error bounded', () => {
    let rest = 0, lines = 0
    for (let i = 0; i < 100; i++) {
      const next = takeTouchLines(rest + 1, 16)
      rest = next.rest; lines += next.lines
      expect(Math.abs(rest)).toBeLessThanOrEqual(8)
    }
    expect(lines).toBe(6)
    expect(rest).toBe(4)
    expect(takeTouchLines(10, 16)).toEqual({ lines: 1, rest: -6 })
    expect(takeTouchLines(-10, 16)).toEqual({ lines: -1, rest: 6 })
  })
})
