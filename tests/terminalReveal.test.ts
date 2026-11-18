import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRevealGate, REVEAL_MAX_MS, REVEAL_QUIET_MS } from '../app/utils/terminalReveal'

// The core attach has no end marker (server/utils/coreTerm.ts): the gate covers
// the terminal from a `full: true` frame until the write queue has drained and
// no frame arrived for a quiet period, with an upper bound so a program that
// prints nonstop is still shown.
const setup = (timing: { quietMs?: number, maxMs?: number } = {}) => {
  const cover = vi.fn()
  const reveal = vi.fn()
  const gate = createRevealGate({ onBegin: cover, onReveal: reveal }, { quietMs: 100, maxMs: 1000, ...timing })
  // A frame of the replay: handed to xterm, then written when the queue reaches it.
  const piece = () => { gate.pushed(); gate.written() }
  return { gate, cover, reveal, piece }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('reveal gate', () => {
  it('reveals only after the last write plus the quiet period', () => {
    const { gate, cover, reveal, piece } = setup()
    gate.begin()
    expect(cover).toHaveBeenCalledTimes(1)
    expect(gate.isCovering()).toBe(true)
    // Several pieces with gaps shorter than the quiet period: the hold survives.
    for (let i = 0; i < 4; i++) {
      piece()
      vi.advanceTimersByTime(90)
      expect(reveal).not.toHaveBeenCalled()
    }
    // The last write was 90 ms ago: the quiet period has not run out yet.
    vi.advanceTimersByTime(9)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(gate.isCovering()).toBe(false)
  })

  it('waits for a frame still queued in xterm, even when the stream goes quiet', () => {
    const { gate, reveal, piece } = setup()
    gate.begin()
    piece()
    gate.pushed()
    // The stream is quiet but xterm has not written the last piece: no reveal.
    vi.advanceTimersByTime(100)
    expect(reveal).not.toHaveBeenCalled()
    gate.written()
    vi.advanceTimersByTime(100)
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('reveals at the upper bound while frames keep arriving', () => {
    const { gate, reveal, piece } = setup()
    gate.begin()
    // A program printing nonstop: a piece every 20 ms, always inside the
    // 100 ms quiet period, so only the bound can end the hold.
    for (let t = 0; t < 980; t += 20) {
      piece()
      vi.advanceTimersByTime(20)
    }
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('covers the terminal again on a second full frame', () => {
    const { gate, cover, reveal, piece } = setup()
    gate.begin()
    piece()
    vi.advanceTimersByTime(100)
    expect(reveal).toHaveBeenCalledTimes(1)
    // A re-attach repaints from scratch: the gate covers again and holds the
    // new paint for its own quiet period.
    gate.begin()
    expect(cover).toHaveBeenCalledTimes(2)
    expect(gate.isCovering()).toBe(true)
    piece()
    vi.advanceTimersByTime(99)
    expect(reveal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledTimes(2)
  })

  it('restarts the upper bound on a second full frame', () => {
    const { gate, reveal, piece } = setup()
    gate.begin()
    // A steady stream through the first paint's bound.
    for (let t = 0; t < 900; t += 40) {
      piece()
      vi.advanceTimersByTime(40)
    }
    expect(reveal).not.toHaveBeenCalled()
    gate.begin()
    // The first paint's bound (100 ms from now, and long past at the end of
    // the new hold) must not end it: only the restarted bound can.
    for (let t = 0; t < 960; t += 40) {
      piece()
      vi.advanceTimersByTime(40)
    }
    vi.advanceTimersByTime(39)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('never reveals after cancel', () => {
    const { gate, reveal, piece } = setup()
    gate.begin()
    piece()
    gate.cancel()
    vi.advanceTimersByTime(5000)
    expect(reveal).not.toHaveBeenCalled()
    expect(gate.isCovering()).toBe(false)
  })

  it('ignores frames and writes while it does not hold the view', () => {
    const { gate, reveal } = setup()
    // Live output after the reveal: the gate is not armed, so nothing queues.
    gate.pushed()
    gate.written()
    vi.advanceTimersByTime(5000)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('uses the production periods by default', () => {
    const reveal = vi.fn()
    const gate = createRevealGate({ onReveal: reveal })
    gate.begin()
    gate.pushed()
    gate.written()
    vi.advanceTimersByTime(REVEAL_QUIET_MS - 1)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledTimes(1)
    // The upper bound is longer than the quiet period it bounds.
    expect(REVEAL_MAX_MS).toBeGreaterThan(REVEAL_QUIET_MS)
  })
})
