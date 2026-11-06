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

describe('takeTouchLines', () => {
  it('leads by half a row so a small drag answers early', () => {
    expect(takeTouchLines(9, 16)).toEqual({ lines: 1, rest: -7 })
    expect(takeTouchLines(-9, 16)).toEqual({ lines: -1, rest: 7 })
    expect(takeTouchLines(7, 16)).toEqual({ lines: 0, rest: 7 })
  })
  it('keeps the signed remainder in following samples', () => {
    const first = takeTouchLines(9, 16)
    // The negative lead carries over: -7 + 20 still rounds only one row.
    expect(takeTouchLines(first.rest + 20, 16, Math.sign(first.lines))).toEqual({ lines: 1, rest: -3 })
    expect(takeTouchLines(first.rest + 9, 16, Math.sign(first.lines))).toEqual({ lines: 0, rest: 2 })
  })
  it('requires a whole residual row before reversing direction', () => {
    // A half-row lead must not turn one pixel of backtracking into an
    // opposite wheel event.
    expect(takeTouchLines(-3, 16, 1)).toEqual({ lines: 0, rest: -3 })
    expect(takeTouchLines(-17, 16, 1)).toEqual({ lines: -1, rest: -1 })
    // A fresh gesture (no direction yet) still leads by half a row.
    expect(takeTouchLines(-9, 16, 0)).toEqual({ lines: -1, rest: 7 })
  })
})
