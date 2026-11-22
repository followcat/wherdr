// DEC Mode 2026 gate: complete synchronized frames reach the writer atomically,
// split markers bridge chunk boundaries, a trailing clear waits for its frame,
// and the two safety bounds release a broken stream.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_HOLD_MS, SYNC_OUTPUT_MAX_BYTES, SYNC_OUTPUT_TIMEOUT_MS, createSyncOutput, type SyncOutputMeta } from '../app/utils/terminalSyncOutput'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const PREFIX = '\x1b[?2026'
const OPEN = `${PREFIX}h`
const CLOSE = `${PREFIX}l`
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
const CLEAR_ALT = '\x1b[H\x1b[2J\x1b[3J'
const meta: SyncOutputMeta = { width: 48, height: 26 }

function harness(options: Parameters<typeof createSyncOutput>[1] = {}) {
  const writes: { bytes: Uint8Array, meta: SyncOutputMeta }[] = []
  const out = createSyncOutput({
    write: (bytes, m, done) => { writes.push({ bytes, meta: m }); done() },
  }, options)
  return {
    out,
    writes,
    text: () => writes.map(w => dec(w.bytes)),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('createSyncOutput', () => {
  it('holds a synchronized frame across chunks and releases it atomically at the close marker', () => {
    const h = harness()
    h.out.push(enc(`${OPEN}first line`), meta)
    expect(h.writes).toHaveLength(0)
    expect(h.out.pending()).toBe(enc(`${OPEN}first line`).length)
    h.out.push(enc(' second line\n'), meta)
    expect(h.writes).toHaveLength(0)
    uniform(h)
    h.out.push(enc(`${CLOSE}tail`), meta)
    expect(h.text()).toEqual([`${OPEN}first line second line\n${CLOSE}`, 'tail'])
    expect(h.out.pending()).toBe(0)
  })

  it('keeps the bytes after a close in stream order', () => {
    const h = harness()
    h.out.push(enc(`before ${OPEN}one${CLOSE} between ${OPEN}two${CLOSE} after`), meta)
    expect(h.text()).toEqual([
      'before ',
      `${OPEN}one${CLOSE}`,
      ' between ',
      `${OPEN}two${CLOSE}`,
      ' after',
    ])
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('bridges a split marker at prefix length %i, completed by h', (n) => {
    const h = harness()
    h.out.push(enc(PREFIX.slice(0, n)), meta)
    expect(h.writes).toHaveLength(0)
    expect(h.out.pending()).toBe(n)
    h.out.push(enc(`${PREFIX.slice(n)}hbody${CLOSE}`), meta)
    expect(h.text()).toEqual([`${PREFIX}hbody${CLOSE}`])
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('bridges a split marker at prefix length %i, completed by l', (n) => {
    const h = harness()
    h.out.push(enc(PREFIX.slice(0, n)), meta)
    expect(h.writes).toHaveLength(0)
    h.out.push(enc(`${PREFIX.slice(n)}l`), meta)
    expect(h.text()).toEqual([`${PREFIX}l`])
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('bridges a split marker at prefix length %i, resolved to another sequence', (n) => {
    const h = harness()
    h.out.push(enc(PREFIX.slice(0, n)), meta)
    expect(h.writes).toHaveLength(0)
    h.out.push(enc(`${PREFIX.slice(n)}04h`), meta)
    expect(h.text()).toEqual([`${PREFIX}04h`])
  })

  it.each([CLEAR, CLEAR_ALT, `\r${CLEAR}`, `\r${CLEAR_ALT}`])('coalesces a trailing clear %j with the frame that follows it', (clear) => {
    const h = harness()
    h.out.push(enc(`old line${clear}`), meta)
    expect(h.text()).toEqual(['old line'])
    // The clear is held for the frame the next chunk may open.
    h.out.push(enc(`${OPEN}new line${CLOSE}`), meta)
    expect(h.text()).toEqual(['old line', `${clear}${OPEN}new line${CLOSE}`])
  })

  it('flushes a held clear at once when no frame follows', () => {
    const h = harness()
    h.out.push(enc(`old${CLEAR}`), meta)
    expect(h.text()).toEqual(['old'])
    h.out.push(enc('next'), meta)
    expect(h.text()).toEqual(['old', CLEAR, 'next'])
  })

  it('coalesces a clear that ends right before an open marker in the same chunk', () => {
    const h = harness()
    h.out.push(enc(`old${CLEAR}${OPEN}new${CLOSE}`), meta)
    expect(h.text()).toEqual(['old', `${CLEAR}${OPEN}new${CLOSE}`])
  })

  it('releases a held clear after CLEAR_HOLD_MS when no frame follows', () => {
    vi.useFakeTimers()
    const h = harness()
    h.out.push(enc(`old${CLEAR}`), meta)
    expect(h.text()).toEqual(['old'])
    vi.advanceTimersByTime(CLEAR_HOLD_MS - 1)
    expect(h.text()).toEqual(['old'])
    vi.advanceTimersByTime(1)
    expect(h.text()).toEqual(['old', CLEAR])
  })

  it('flushes an unclosed frame after SYNC_OUTPUT_TIMEOUT_MS', () => {
    vi.useFakeTimers()
    const h = harness()
    h.out.push(enc(`${OPEN}never closed`), meta)
    expect(h.writes).toHaveLength(0)
    vi.advanceTimersByTime(SYNC_OUTPUT_TIMEOUT_MS - 1)
    expect(h.writes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(h.text()).toEqual([`${OPEN}never closed`])
    expect(h.out.isHolding()).toBe(false)
  })

  it('flushes at once past SYNC_OUTPUT_MAX_BYTES so a huge frame cannot freeze the terminal', () => {
    const h = harness({ maxBytes: 32 })
    h.out.push(enc(OPEN), meta)
    h.out.push(new Uint8Array(64).fill(0x41), meta)
    expect(h.text()).toEqual([`${OPEN}${'A'.repeat(64)}`])
    expect(h.out.isHolding()).toBe(false)
    // The default bound is the full agy repaint size.
    expect(SYNC_OUTPUT_MAX_BYTES).toBeGreaterThanOrEqual(500 * 1024)
  })

  it('credits a held chunk immediately, and a released one when its write completes', () => {
    const credited: string[] = []
    const writes: string[] = []
    const out = createSyncOutput({
      write: (bytes, _m, done) => { writes.push(dec(bytes)); done() },
    })
    out.push(enc(`${OPEN}hold`), meta, () => credited.push('held'))
    expect(credited).toEqual(['held'])
    out.push(enc(CLOSE), meta, () => credited.push('closed'))
    expect(writes).toEqual([`${OPEN}hold${CLOSE}`])
    expect(credited).toEqual(['held', 'closed'])
    // A chunk written without any hold is credited right away, too.
    out.push(enc('plain'), meta, () => credited.push('plain'))
    expect(credited).toEqual(['held', 'closed', 'plain'])
  })

  it('flush() hands held bytes to the writer; reset() drops them', () => {
    const flushed = harness()
    flushed.out.push(enc(`${OPEN}half`), meta)
    flushed.out.flush()
    expect(flushed.text()).toEqual([`${OPEN}half`])

    const dropped = harness()
    dropped.out.push(enc(`${OPEN}half`), meta)
    dropped.out.reset()
    expect(dropped.writes).toHaveLength(0)
    expect(dropped.out.pending()).toBe(0)
    // The next stream starts clean.
    dropped.out.push(enc('fresh'), meta)
    expect(dropped.text()).toEqual(['fresh'])
  })

  it('reports holds and drains so the caller can keep its cover accounting', () => {
    const holds: string[] = []
    const out = createSyncOutput({
      write: (_b, _m, done) => done(),
      onHold: () => holds.push('hold'),
      onDrain: () => holds.push('drain'),
    })
    out.push(enc(`${OPEN}x`), meta)
    expect(holds).toEqual(['hold'])
    out.push(enc(CLOSE), meta)
    expect(holds).toEqual(['hold', 'drain'])
    out.reset()
    expect(holds).toEqual(['hold', 'drain'])
  })
})

function uniform(h: ReturnType<typeof harness>) {
  // Every write carries one complete, self-contained frame or plain run.
  for (const t of h.text()) expect(t.length).toBeGreaterThan(0)
}
