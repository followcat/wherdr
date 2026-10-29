import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalTouch, touchPreviewOffset } from '../app/utils/terminalTouch'
import { createTouchScrollPacer } from '../server/utils/touchScrollPacer'

function gesture(horizontal = false) {
  let time = 0, id = 0
  const frames = new Map<number, FrameRequestCallback>()
  const vertical = vi.fn(), sideways = vi.fn()
  const touch = createTerminalTouch({ vertical, horizontal: sideways, canHorizontal: () => horizontal,
    maxMomentum: () => 150, now: () => time,
    frame: fn => { frames.set(++id, fn); return id }, cancelFrame: n => { frames.delete(n) },
  })
  return { touch, vertical, sideways, frames,
    move(x: number, y: number, ms = 16) { time += ms; touch.move(x, y) },
    wait(ms: number) { time += ms },
    step() { time += 16; for (const [n, fn] of [...frames]) { frames.delete(n); fn(time) } },
  }
}

describe('terminal touch gestures', () => {
  it('distinguishes a tap from a small drag that must not click the agent', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(1, 2); expect(g.touch.end()).toBe(true)
    g.touch.start(0, 0); g.move(0, 7); expect(g.touch.end()).toBe(false)
  })
  it('preserves drag distance including the initial movement threshold', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(0, 3); g.move(0, 20); g.move(0, 60)
    expect(g.vertical.mock.calls.reduce((n, [dy]) => n + dy, 0)).toBe(60)
    expect(g.sideways).not.toHaveBeenCalled()
  })
  it('locks horizontal intent rather than flipping axes on diagonal samples', () => {
    const g = gesture(true)
    g.touch.start(0, 0); g.move(20, 1); g.move(23, 40)
    expect(g.sideways.mock.calls.map(([dx]) => dx)).toEqual([20, 3])
    expect(g.vertical).not.toHaveBeenCalled()
  })
  it('adds brief bounded inertia and stops immediately on the next touch', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(0, 80); g.move(0, 140); g.touch.end()
    const direct = g.vertical.mock.calls.length
    for (let i = 0; i < 40; i++) g.step()
    const momentum = g.vertical.mock.calls.slice(direct).reduce((n, [dy]) => n + dy, 0)
    expect(momentum).toBeGreaterThan(0); expect(momentum).toBeLessThanOrEqual(150)
    expect(g.frames.size).toBe(0)
    g.touch.start(0, 0); g.move(0, 80); g.touch.end(); expect(g.frames.size).toBe(1)
    g.touch.start(0, 0); const count = g.vertical.mock.calls.length
    g.step(); expect(g.vertical).toHaveBeenCalledTimes(count)
  })
  it('does not coast after holding the finger still or cancelling a gesture', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(0, 100); g.wait(120); g.touch.end()
    expect(g.frames.size).toBe(0)
    g.touch.start(0, 0); g.move(0, 100); g.touch.cancel()
    expect(g.touch.end()).toBe(false); expect(g.frames.size).toBe(0)
  })
  it('forgets velocity when the platform emits stationary touch samples', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(0, 80); g.move(0, 80, 184); g.touch.end()
    expect(g.frames.size).toBe(0)
  })
  it('reverses inertia with the final movement instead of replaying stale velocity', () => {
    const g = gesture()
    g.touch.start(0, 0); g.move(0, 80); g.move(0, 140); g.move(0, 120); g.touch.end()
    const before = g.vertical.mock.calls.length
    g.step()
    expect(g.vertical.mock.calls[before]![0]).toBeLessThan(0)
  })
  it('glides past the old 240ms cap on a fast flick, then settles', () => {
    let time = 0, id = 0
    const frames = new Map<number, FrameRequestCallback>()
    const vertical = vi.fn()
    const touch = createTerminalTouch({ vertical, horizontal: vi.fn(), canHorizontal: () => false,
      maxMomentum: () => 10000, now: () => time,
      frame: fn => { frames.set(++id, fn); return id }, cancelFrame: n => { frames.delete(n) } })
    touch.start(0, 0)
    time += 16; touch.move(0, -40)
    time += 16; touch.move(0, -80)
    time += 16; touch.move(0, -120)
    touch.end()
    const step = () => { time += 16; for (const [n, fn] of [...frames]) { frames.delete(n); fn(time) } }
    const calls = () => vertical.mock.calls.length
    for (let i = 0; i < 15; i++) step() // 240ms: the old cap would be done
    expect(frames.size).toBe(1)
    for (let i = 0; i < 60; i++) step() // ~1.2s total: long over
    expect(frames.size).toBe(0)
    const momentum = vertical.mock.calls.slice(3).reduce((n, [dy]) => n + dy, 0)
    expect(momentum).toBeLessThan(-350) // a real glide, not a nudge
    expect(calls()).toBeGreaterThan(3)
  })
  it('bleeds release velocity while the finger holds instead of a hard cut', () => {
    for (const hold of [0, 60]) {
      let time = 0, id = 0
      const frames = new Map<number, FrameRequestCallback>()
      const vertical = vi.fn()
      const touch = createTerminalTouch({ vertical, horizontal: vi.fn(), canHorizontal: () => false,
        maxMomentum: () => 10000, now: () => time,
        frame: fn => { frames.set(++id, fn); return id }, cancelFrame: n => { frames.delete(n) } })
      touch.start(0, 0)
      time += 16; touch.move(0, -40)
      time += 16; touch.move(0, -80)
      time += 16; touch.move(0, -120)
      time += hold; touch.end()
      for (let i = 0; i < 80; i++) { time += 16; for (const [n, fn] of [...frames]) { frames.delete(n); fn(time) } }
      const momentum = Math.abs(vertical.mock.calls.slice(3).reduce((n, [dy]) => n + dy, 0))
      if (!hold) expect(momentum).toBeGreaterThan(350)
      else expect(momentum).toBeLessThan(250) // bled to roughly a half
    }
  })
  it('follows the finger 1:1 inside the lead and rubber-bands toward the cap', () => {
    expect(touchPreviewOffset(4, 16)).toBe(4)
    expect(touchPreviewOffset(-16, 16)).toBe(-16)
    expect(touchPreviewOffset(60, 16)).toBe(27)
    expect(touchPreviewOffset(400, 16)).toBe(48)
    expect(touchPreviewOffset(-400, 16)).toBe(-48)
    expect(touchPreviewOffset(12, 0)).toBe(3)
  })
})

describe('touch scroll backpressure', () => {
  afterEach(() => { vi.useRealTimers() })
  it('limits unframed wheel reports even when no terminal frame arrives', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 100)
    vi.advanceTimersByTime(200)
    expect(send.mock.calls.length).toBeLessThanOrEqual(8)
    p.frame()
    vi.advanceTimersByTime(16)
    expect(send.mock.calls.length).toBeGreaterThan(8)
    p.dispose()
  })
  it('does not replay a paused drag after the short queue lifetime', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 60)
    vi.advanceTimersByTime(300)
    const count = send.mock.calls.length
    p.frame()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(count)
    p.dispose()
  })
  it('retains real drag rows across slow frames while expiring only momentum', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer<string>(send)
    p.push('up', 20, 'drag', 800)
    vi.advanceTimersByTime(100)
    p.push('up', 10, 'momentum', 240)
    vi.advanceTimersByTime(300)
    for (let i = 0; i < 5; i++) { p.frame(); vi.advanceTimersByTime(16) }
    expect(send.mock.calls.filter(call => call[2] === 'drag')).toHaveLength(20)
    expect(send.mock.calls.filter(call => call[2] === 'momentum')).toHaveLength(0)
    p.dispose()
  })
  it('responds immediately and keeps a bounded rate while following frames', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const times: number[] = []
    const p = createTouchScrollPacer(() => times.push(Date.now()))
    for (let i = 0; i < 125; i++) { p.push('up', 1); p.frame(); vi.advanceTimersByTime(8) }
    p.dispose()
    expect(times[0]).toBe(0); expect(times.length).toBeGreaterThanOrEqual(60)
    expect(times.length).toBeLessThanOrEqual(125)
    const batches = [...new Set(times)]
    for (let i = 1; i < batches.length; i++) expect(batches[i]! - batches[i - 1]!).toBeGreaterThanOrEqual(16)
    for (const at of batches) expect(times.filter(t => t === at).length).toBeLessThanOrEqual(4)
  })
  it('preserves a fast drag as separate wheel reports because Herdr ignores lines', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 20)
    for (let i = 0; i < 15; i++) { vi.advanceTimersByTime(16); p.frame() }
    expect(send.mock.calls.map(([direction, lines]) => [direction, lines])).toEqual(Array.from({ length: 20 }, () => ['up', 1]))
    p.dispose()
  })
  it('drops queued movement in the old direction as soon as the finger reverses', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 20)
    const alreadySent = send.mock.calls.length
    p.push('down', 2); vi.advanceTimersByTime(16); p.frame()
    expect(send.mock.calls.slice(alreadySent).map(([direction, lines]) => [direction, lines])).toEqual([['down', 1], ['down', 1]])
    p.dispose()
  })
  it('expires stale movement instead of catching up long after a flick', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 60); vi.advanceTimersByTime(1000)
    const count = send.mock.calls.length
    expect(count).toBeLessThanOrEqual(50)
    p.frame(); vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(count)
    p.dispose()
  })
  it('backs off for an unresponsive terminal instead of flooding its input', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    for (let i = 0; i < 125; i++) { p.push('up', 1); vi.advanceTimersByTime(8) }
    expect(send.mock.calls.length).toBeLessThanOrEqual(60)
    p.dispose(); const count = send.mock.calls.length
    vi.advanceTimersByTime(1000); expect(send).toHaveBeenCalledTimes(count)
  })
  it('drops pending scroll when cancelled and does not resume after disposal', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const send = vi.fn(), p = createTouchScrollPacer(send)
    p.push('up', 1); p.push('up', 10); p.cancel(); vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    p.dispose(); p.push('down', 10); p.frame(); vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
