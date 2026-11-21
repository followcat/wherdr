import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createWheelPacer, takeLines, takeTouchLines, trackSgrMouse, wheelPixels, wheelPlan, wheelReports } from '../app/utils/terminalWheel'
import { writeTerminalFrame } from '../app/utils/terminalFrame' 

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

describe('wheelReports', () => {
  it('sends one SGR report per line, up (64) or down (65), at a 1-based cell', () => {
    expect(wheelReports(2, { column: 4, row: 9 }, true)).toBe('\x1b[<64;5;10M\x1b[<64;5;10M')
    expect(wheelReports(-1, { column: 0, row: 0 }, true)).toBe('\x1b[<65;1;1M')
  })
  it('falls back to X10 bytes, coordinates capped at 223, and bounds the count', () => {
    expect(wheelReports(1, { column: 4, row: 300 }, false)).toBe('\x1b[M`%\xff')
    expect(wheelReports(-500, { column: 0, row: 0 }, true, 3)).toBe('\x1b[<65;1;1M'.repeat(3))
    expect(wheelReports(0, { column: 0, row: 0 }, true)).toBe('')
  })
})

describe('trackSgrMouse', () => {
  const write = (t: Terminal, d: string) => new Promise<void>(r => t.write(d, r))
  it('follows DECSET 1006 and drops it with xterm on a full-frame reset and on RIS', async () => {
    const t = new Terminal({ allowProposedApi: true })
    const sgr = trackSgrMouse(t)
    await write(t, '\x1b[?1000;1006h')
    expect(sgr.on()).toBe(true)
    await new Promise<void>(r => writeTerminalFrame(t, { reset: true, bytes: new TextEncoder().encode('\x1b[?1000h') }, { reset: sgr.reset, written: r }))
    expect(t.modes.mouseTrackingMode).toBe('vt200')
    expect(sgr.on()).toBe(false)
    await write(t, '\x1b[?1006h')
    expect(sgr.on()).toBe(true)
    await write(t, '\x1bc\x1b[?1000h')
    expect(sgr.on()).toBe(false)
    await write(t, '\x1b[?1006l')
    expect(sgr.on()).toBe(false)
    t.dispose()
  })
})

describe('wheelPlan', () => {
  it('follows the program acceleration: one row when rested, then +0.3 per report up to 6', () => {
    expect(wheelPlan(4, 0)).toEqual({ reports: 4, rows: 4, mult: expect.closeTo(1.9) })
    expect(wheelPlan(12, 5.8)).toEqual({ reports: 2, rows: 12, mult: 6 })
  })
  it('never overshoots after the first report', () => {
    expect(wheelPlan(7, 5)).toEqual({ reports: 1, rows: 5, mult: 5.3 })
    expect(wheelPlan(2, 5)).toEqual({ reports: 1, rows: 5, mult: 5.3 })
  })
})

describe('createWheelPacer', () => {
  afterEach(() => { vi.useRealTimers() })
  const setup = (page = 50, accel = true) => {
    vi.useFakeTimers()
    const sent: number[] = []
    const pacer = createWheelPacer({ send: n => { sent.push(n); return true }, page: () => page, accel: () => accel, now: () => Date.now() })
    return { sent, pacer }
  }

  it('keeps one burst in flight and sends the net amount on the next repaint', () => {
    const { sent, pacer } = setup()
    pacer.push(3)
    pacer.push(4)
    pacer.push(2)
    expect(sent).toEqual([3])
    vi.advanceTimersByTime(10)
    pacer.frame()
    // 6 rows, accelerated from where the first burst left the program.
    expect(sent).toEqual([3, 3])
  })

  it('keeps at most a page, and a stalled program gets no more bursts until it paints', () => {
    const { sent, pacer } = setup(10)
    pacer.push(1)
    for (let t = 20; t < 1900; t += 20) { vi.advanceTimersByTime(20); pacer.push(5) }
    // The first burst never got its repaint: what came after is dropped, not queued.
    expect(sent).toEqual([1])
    pacer.frame()
    pacer.push(30)
    // 10 rows at most, from rest: 1, 1, 1, 1, 2, 2, 2.
    expect(sent).toEqual([1, 7])
  })

  it('leaves a stall or an edge on a reversal', () => {
    const { sent, pacer } = setup()
    pacer.push(3)
    vi.advanceTimersByTime(300)
    pacer.push(3)
    pacer.push(-2)
    expect(sent).toEqual([3, -3])
  })

  it('sends one report per row to a program without acceleration', () => {
    const { sent, pacer } = setup(50, false)
    pacer.push(40)
    pacer.frame()
    pacer.push(-3)
    expect(sent).toEqual([40, -3])
  })

  it('sends a remainder smaller than one accelerated report after the pause, one row each', () => {
    const { sent, pacer } = setup()
    pacer.push(40)
    // 39 rows in 15 reports.
    expect(sent).toEqual([15])
    vi.advanceTimersByTime(5)
    pacer.frame()
    // 1 left, the next report would move 5: wait for the multiplier to rest.
    expect(sent).toEqual([15])
    vi.advanceTimersByTime(40)
    expect(sent).toEqual([15, 1])
  })

  it('drops the other direction on a reversal and adds the report the program swallows', () => {
    const { sent, pacer } = setup()
    pacer.push(2)
    pacer.push(5)
    pacer.push(-3)
    vi.advanceTimersByTime(10)
    pacer.frame()
    expect(sent).toEqual([2, -4])
  })
})
