// The bounded reads every transcript reader shares (server/utils/boundedRead.ts):
// a range always aligned to a line start, a backwards walk within its caps,
// and a bottom read incrementally between polls that holds the same lines as
// a whole re-read — on the claude and codex fixtures.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoundedReads, type BottomState, type WindowReader } from '../server/utils/boundedRead'
import { type MachineFs, localFs } from '../server/utils/fsx'

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

// A file holding `text`, and a file system that records the reads taken from it.
function setup(text: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-bounded-'))
  homes.push(home)
  const file = path.join(home, 'transcript.jsonl')
  writeFileSync(file, text)
  const reads: { start: number, len: number }[] = []
  const fs: MachineFs = { ...localFs, read: async (p, start, len) => {
    const b = await localFs.read(p, start, len)
    if (p === file) reads.push({ start, len: b.length })
    return b
  } }
  return { file, fs, reads, write: (t: string) => writeFileSync(file, t), append: (t: string) => appendFileSync(file, t) }
}

// A reader of plain lines (one test transcript line per line).
const plainReader = (count: (lines: string[]) => number = lines => lines.length): WindowReader<string[]> => ({
  label: 'plain',
  parse: text => text.split('\n').filter(Boolean),
  join: windows => windows.flat(),
  count: w => count(w),
})

// A reader of JSONL transcripts: a line summarizes to its "type" (and role);
// a line being written, not JSON yet, is skipped — as the parsers would. A
// bottom keeps the lines fed since, summarized the same way, so an
// incremental poll must equal a whole re-read.
const summarize = (line: string): string | null => {
  let d: { type?: string, message?: { role?: string }, payload?: { role?: string } }
  try { d = JSON.parse(line) } catch { return null }
  const role = d.message?.role || d.payload?.role
  return `${d.type ?? '?'}${role ? `:${role}` : ''}`
}
const summarizeAll = (text: string) => text.split('\n').filter(Boolean).map(summarize).filter(x => x !== null)
const jsonReader = (label = 'jsonl'): WindowReader<string[]> => ({
  label,
  parse: summarizeAll,
  join: windows => windows.flat(),
})

// A bottom state keeping every complete line fed, and the factory wiring it
// into a reader (a rebuilt bottom opens a fresh state: `current` follows it).
const keptLines = (): BottomState<string[]> => {
  const lines: string[] = []
  return {
    feed: text => { lines.push(...text.split('\n').filter(Boolean)) },
    result: () => summarizeAll(lines.join('\n')),
    kept: () => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0),
  }
}
const withBottom = () => {
  const current: { state: BottomState<string[]> | null } = { state: null }
  const w: WindowReader<string[]> = { ...jsonReader(), bottom: () => (current.state = keptLines()) }
  return { w, current }
}

describe('readRange', () => {
  it('aligns a start in the middle of a line to the next line start, and keeps a line start', async () => {
    const { file, fs } = setup('alpha\nbeta\ngamma\n')
    const R = createBoundedReads(fs)
    expect(await R.readRange(file, 0, 99)).toEqual({ start: 0, text: 'alpha\nbeta\ngamma\n' })
    expect(await R.readRange(file, 3, 99)).toEqual({ start: 6, text: 'beta\ngamma\n' })
    expect(await R.readRange(file, 6, 99)).toEqual({ start: 6, text: 'beta\ngamma\n' })
    expect(await R.readRange(file, 12, 99)).toEqual({ start: 17, text: '' })
  })

  it('reads no more than the window asked', async () => {
    const { file, fs, reads } = setup(`${'x'.repeat(5000)}\nbeta\n`)
    const R = createBoundedReads(fs)
    await R.readRange(file, 4000, 4100)
    expect(reads[0]!.len).toBeLessThanOrEqual(101)
    expect(reads[0]!.len).toBeGreaterThan(0)
  })
})

describe('anchorAt', () => {
  it('is stable while the bytes above are, and moves when they change', async () => {
    const { file, fs, append } = setup('alpha\nbeta\n')
    const R = createBoundedReads(fs)
    const a = await R.anchorAt(file, 6)
    expect(a).toBe(await R.anchorAt(file, 6))
    append('gamma\n')
    expect(await R.anchorAt(file, 6)).toBe(a)
    const atStart = await R.anchorAt(file, 0)
    expect(atStart).toBe(await R.anchorAt(file, 0))
    expect(atStart).not.toBe(a)
  })
})

describe('readBackwards', () => {
  it('walks the file backwards by windows and joins them in file order', async () => {
    const { file, fs, reads } = setup(Array.from({ length: 10 }, (_, i) => `m${i} ${'x'.repeat(10)}\n`).join(''))
    const R = createBoundedReads(fs, { windowBytes: 32, maxBytes: 1024 })
    const r = await R.readBackwards(file, (await fs.stat(file)).size, plainReader())
    expect(r.start).toBe(0)
    expect(r.parsed).toHaveLength(10) // every line, in file order
    expect(r.parsed[0]).toBe('m0 xxxxxxxxxx')
    expect(r.parsed.at(-1)).toBe('m9 xxxxxxxxxx')
    expect(Math.max(...reads.map(x => x.len))).toBeLessThanOrEqual(33)
  })

  it('stops once the page holds enough items', async () => {
    const { file, fs } = setup(Array.from({ length: 10 }, (_, i) => `m${i}\n`).join(''))
    const R = createBoundedReads(fs, { windowBytes: 16, maxBytes: 1024, pageItems: 4 })
    const r = await R.readBackwards(file, (await fs.stat(file)).size, plainReader())
    expect(r.parsed).toEqual(['m5', 'm6', 'm7', 'm8', 'm9'])
    expect(r.start).toBe(15)
  })

  it('a giant first line beyond the cap ends the walk, without reading past the cap', async () => {
    const giant = 'g'.repeat(300)
    const { file, fs, reads } = setup(`${giant}\nend\n`)
    const R = createBoundedReads(fs, { windowBytes: 32, maxBytes: 64, pageItems: 100 })
    const r = await R.readBackwards(file, (await fs.stat(file)).size, plainReader())
    expect(r.parsed).toEqual(['end'])
    expect(r.start).toBe(giant.length + 1)
    expect(Math.max(...reads.map(x => x.len))).toBeLessThanOrEqual(2 * 64 + 1)
  })
})

describe('readSlice', () => {
  it('gives the anchor above an aligned cursor, none for a cursor in the middle of a line', async () => {
    const { file, fs } = setup('alpha\nbeta\ngamma\n')
    const R = createBoundedReads(fs)
    const size = (await fs.stat(file)).size
    const atLine = await R.readSlice(file, size, 6, plainReader())
    expect(atLine.start).toBe(6)
    expect(atLine.parsed).toEqual(['beta', 'gamma'])
    expect(atLine.anchor).toBe(await R.anchorAt(file, 6))
    const midLine = await R.readSlice(file, size, 8, plainReader())
    expect(midLine.start).toBe(8) // kept even though the parse skips ahead
    expect(midLine.parsed).toEqual(['gamma'])
    expect(midLine.anchor).toBe('')
  })
})

describe('readBelow, fed in uneven chunks like a transcript growing', () => {
  const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name))
  const claude = Buffer.concat([fixture('claude-session.jsonl'), fixture('claude-queue.jsonl')])
  const codex = fixture('codex-rollout.jsonl')

  // Appends `data` in uneven chunks, polling after each: the bottom must hold
  // the same lines as a whole read of the span below the cursor, every time.
  async function feed(data: Buffer, from: number) {
    const { file, fs } = setup('')
    const R = createBoundedReads<string[]>(fs)
    const { w, current } = withBottom()
    let at = 0
    for (let k = 0; at < data.length; k++) {
      const n = Math.min(data.length - at, [37, 211, 5, 640, 90][k % 5]!)
      appendFileSync(file, data.subarray(at, at + n))
      at += n
      const size = (await fs.stat(file)).size
      const r = await R.readBelow(file, size, from, undefined, w)
      const whole = await R.readSlice(file, size, from, jsonReader())
      expect(r.parsed).toEqual(whole.parsed)
      expect(r.start).toBe(from)
    }
    expect(current.state!.result().length).toBeGreaterThan(0)
  }

  it('claude fixture: same lines as a whole read, from the start and from a mid-line cursor', async () => {
    await feed(claude, 0)
    const mid = claude.indexOf(0x0a, 3000) + 1
    await feed(claude.subarray(mid), mid)
  })

  it('codex fixture: same lines as a whole read', async () => {
    await feed(codex, 0)
  })

  it('a last line not ended yet is left for the next poll, and a whole one is parsed at once', async () => {
    const { file, fs, append } = setup('')
    const R = createBoundedReads(fs)
    const { w, current } = withBottom()
    append(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`)
    await R.readBelow(file, (await fs.stat(file)).size, 0, undefined, w)
    expect(current.state!.result()).toEqual(['user:user'])
    // Written whole, its newline still to come: this poll reads the whole
    // bottom (the state catches up when the newline lands).
    append(JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }))
    const r = await R.readBelow(file, (await fs.stat(file)).size, 0, undefined, w)
    expect(r.parsed).toContain('assistant:assistant')
    expect(current.state!.result()).toEqual(['user:user'])
    append('\n')
    await R.readBelow(file, (await fs.stat(file)).size, 0, undefined, w)
    expect(current.state!.result()).toEqual(['user:user', 'assistant:assistant'])
  })

  it('a rewrite above the cursor is dropped and read again whole', async () => {
    const { file, fs, write } = setup('')
    const R = createBoundedReads(fs)
    const { w, current } = withBottom()
    const first = `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`
    appendFileSync(file, first)
    await R.readBelow(file, (await fs.stat(file)).size, 0, undefined, w)
    // Same length, other bytes: the bytes below the cursor no longer match.
    write(first.replace('"user"', '"agent"'))
    const r = await R.readBelow(file, (await fs.stat(file)).size, 0, undefined, w)
    expect(r.parsed).toEqual(['agent:user'])
    expect(current.state!.result()).toEqual(['agent:user'])
  })

  it('without a bottom state, the span below the cursor is parsed again', async () => {
    const { file, fs, append } = setup('')
    const R = createBoundedReads(fs)
    const w = jsonReader()
    append(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`)
    let size = (await fs.stat(file)).size
    expect((await R.readBelow(file, size, 0, undefined, w)).parsed).toEqual(['user:user'])
    append(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant' } })}\n`)
    size = (await fs.stat(file)).size
    expect((await R.readBelow(file, size, 0, undefined, w)).parsed).toEqual(['user:user', 'assistant:assistant'])
  })
})

describe('tail', () => {
  const line = (type: string, role?: string) => JSON.stringify({ type, ...(role ? { message: { role } } : {}) }) + '\n'
  const gen = async (fs: MachineFs, file: string) => `${(await fs.stat(file)).size}`

  it('requests on the same state read the file once, a new state is read again', async () => {
    const { file, fs, reads, append } = setup(line('user', 'user') + line('assistant', 'assistant'))
    const R = createBoundedReads(fs)
    const w = jsonReader()
    const size = (await fs.stat(file)).size
    const first = await Promise.all([R.tail(file, w, size, await gen(fs, file), null), R.tail(file, w, size, await gen(fs, file), null)])
    expect(first[0]).toEqual(first[1])
    expect(first[0].parsed).toEqual(['user:user', 'assistant:assistant'])
    expect(reads.length).toBe(1)
    append(line('assistant', 'assistant'))
    const second = await R.tail(file, w, (await fs.stat(file)).size, await gen(fs, file), null)
    expect(second.parsed).toHaveLength(3)
    expect(reads.length).toBe(2)
  })

  it('a cursor within the cap reads the bottom incrementally, and only what was appended', async () => {
    const { file, fs, reads, append } = setup(line('user', 'user') + line('assistant', 'assistant'))
    const R = createBoundedReads(fs)
    const { w, current } = withBottom()
    await R.tail(file, w, (await fs.stat(file)).size, await gen(fs, file), 0)
    expect(current.state!.result()).toEqual(['user:user', 'assistant:assistant'])
    append(line('assistant', 'assistant'))
    const next = await R.tail(file, w, (await fs.stat(file)).size, await gen(fs, file), 0)
    expect(next.parsed).toEqual(['user:user', 'assistant:assistant', 'assistant:assistant'])
    // The bottom was kept: the second poll read the appended bytes and the
    // few checked around them, not the whole span again.
    expect(reads.every(x => x.len <= 4096 + line('user', 'user').length + line('assistant', 'assistant').length)).toBe(true)
  })
})
