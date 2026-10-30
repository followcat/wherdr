import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalWriter } from '../server/utils/terminalWriter'

// A tiny buffer makes write() return false on demand.
const pipe = () => new PassThrough({ highWaterMark: 4 })

describe('terminal writer', () => {
  it('never resends the chunk that reported false; later chunks queue FIFO', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s)
    w.write('aaa\n')
    w.write('bbb\n') // buffer full here or next
    w.write('ccc\n')
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toBe('aaa\nbbb\nccc\n') })
  })
  it('keeps per-write callbacks honest under backpressure', async () => {
    const s = pipe()
    const seen: string[] = []
    const flushed = vi.fn()
    const w = createTerminalWriter(s)
    // Fill the buffer so the second write queues internally.
    w.write('12345678\n', () => seen.push('one'))
    w.write('90\n', () => seen.push('two'))
    w.write('ab\n', flushed)
    s.resume()
    await vi.waitFor(() => { expect(flushed).toHaveBeenCalled() })
    expect(seen).toEqual(['one', 'two'])
  })
  it('dispose drops queued chunks; already-written bytes still arrive', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s)
    w.write('aaaaaaaa\n') // fills the 4-byte buffer
    w.write('tail\n')
    w.dispose()
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toBe('aaaaaaaa\n') })
    w.write('never\n')
    await new Promise(r => setTimeout(r, 10))
    expect(received.join('')).toBe('aaaaaaaa\n')
  })
  it('write after drain resumes without a drain event having been missed', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s)
    w.write('xxxx\n')
    w.write('yyyy\n')
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toBe('xxxx\nyyyy\n') })
    w.write('zzzz\n')
    await vi.waitFor(() => { expect(received.join('')).toBe('xxxx\nyyyy\nzzzz\n') })
  })
  it('a full queue sheds expendable scroll chunks, never protected input', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s, { maxPending: 3 })
    w.write('aaaaaaaa\n') // stalls the 4-byte buffer
    // Queue: input, then scrolls — the bound must drop scrolls, not typing.
    w.write('key-a\n')
    w.write('scroll-1\n', { expendable: true })
    w.write('scroll-2\n', { expendable: true })
    w.write('key-b\n') // pushes past the bound: a scroll goes, not a key
    w.write('key-c\n')
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toContain('key-c\n') })
    const got = received.join('')
    expect(got).toContain('key-a\n')
    expect(got).toContain('key-b\n')
    expect(got).not.toContain('scroll-1\n')
    expect(got).not.toContain('scroll-2\n')
  })
  it('an incoming scroll is dropped rather than evicting protected input', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s, { maxPending: 2 })
    w.write('aaaaaaaa\n')
    w.write('key-a\n')
    w.write('key-b\n') // queue full of protected input
    w.write('scroll\n', { expendable: true }) // incoming expendable: dropped
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toBe('aaaaaaaa\nkey-a\nkey-b\n') })
  })
  it('a queue of only protected input still bounds: oldest is dropped', async () => {
    const s = pipe()
    const received: string[] = []
    const w = createTerminalWriter(s, { maxPending: 1 })
    w.write('aaaaaaaa\n')
    w.write('one\n')
    w.write('two\n')
    s.on('data', c => received.push(c.toString()))
    await vi.waitFor(() => { expect(received.join('')).toBe('aaaaaaaa\ntwo\n') })
  })
})
