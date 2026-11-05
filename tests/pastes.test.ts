// Pasted texts sent from wherdr's field, kept by the server for every device:
// what a request may add, the bounds of the list, and the conversation and
// queued records served with their pasted texts listed.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PASTES_MAX, PASTES_MAX_CHARS, PASTES_TTL_MS, type KeptPaste, addPastes, loadPastes, pastedIn, pastesAt, withPasted, withQueuedPasted } from '../server/utils/pastes'
import { messageBody, pasteRanges, splitPasted } from '../shared/pastedText'
import type { ChatItem } from '../shared/types'

const log = (name: string, n = 40) => Array.from({ length: n }, (_, i) => `==> Pouring ${name}-${i}--1.0.arm64_sonoma.bottle.tar.gz`).join('\n')
const LOG = log('pkg')
const OTHER = log('lib')
const TYPED = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}: check the service and write down what you see.`).join('\n')
const DAY = 86400000
const NOW = Date.UTC(2026, 9, 11)
const texts = (list: KeptPaste[]) => list.map(p => p.text)
const user = (text: string, pasted?: string[]): ChatItem => ({ role: 'user', text, ts: null, ...(pasted ? { pasted } : {}) })

describe('pasted texts of a request', () => {
  it('reads the blocks at the ranges the app gives', () => {
    const body = messageBody('fix this', [LOG, OTHER], ['@/tmp/a.txt'])
    const ranges = pasteRanges(body, [LOG, OTHER])
    expect(ranges).toEqual([[10, LOG.length], [12 + LOG.length, OTHER.length]])
    expect(pastesAt(body, ranges)).toEqual([LOG, OTHER])
    // After the JSON round trip of the request.
    expect(pastesAt(body, JSON.parse(JSON.stringify(ranges)))).toEqual([LOG, OTHER])
  })

  it('ignores a block the message does not hold, and anything malformed', () => {
    expect(pasteRanges('fix this', [LOG])).toEqual([])
    const body = `fix this\n\n${LOG}`
    for (const bad of [undefined, null, 'x', {}, [[0]], [['0', 5]], [[-1, 20]], [[0, 0]], [[1.5, 20]], [[10, LOG.length + 1]], [null], [[0, 8]]]) {
      expect(pastesAt(body, bad)).toEqual([])
    }
    // The same block twice: once.
    expect(pastesAt(body, [[10, LOG.length], [10, LOG.length]])).toEqual([LOG])
  })
})

describe('kept pasted texts', () => {
  it('keeps the most recent first, each block once, with when it was last sent', () => {
    let list = addPastes([], [LOG], NOW)
    list = addPastes(list, [OTHER], NOW + 1000)
    expect(list).toEqual([{ text: OTHER, at: NOW + 1000 }, { text: LOG, at: NOW }])
    expect(addPastes(list, [LOG], NOW + 2000)).toEqual([{ text: LOG, at: NOW + 2000 }, { text: OTHER, at: NOW + 1000 }])
  })

  it('is the same list for a message without a paste: nothing to write', () => {
    const list = addPastes([], [LOG, OTHER], NOW)
    expect(addPastes(list, [], NOW + DAY)).toBe(list)
    expect(addPastes(list, pastesAt('a short message', undefined), NOW + DAY)).toBe(list)
  })

  it('is bounded in number and in size: the oldest go', () => {
    let list: KeptPaste[] = []
    for (let i = 0; i < PASTES_MAX + 5; i++) list = addPastes(list, [log(`n${i}`)], NOW + i)
    expect(list).toHaveLength(PASTES_MAX)
    expect(list[0]!.text).toBe(log(`n${PASTES_MAX + 4}`))
    expect(texts(list)).not.toContain(log('n0'))
    const big = (c: string) => c.repeat(PASTES_MAX_CHARS / 2 - 10)
    list = addPastes(addPastes(addPastes([], [big('a')], NOW), [big('b')], NOW), [big('c')], NOW)
    expect(texts(list)).toEqual([big('c'), big('b')])
  })

  it('drops a block 30 days after it was last sent, when the next one is kept', () => {
    expect(PASTES_TTL_MS).toBe(30 * DAY)
    let list = addPastes([], [LOG], NOW)
    list = addPastes(list, [OTHER], NOW + 10 * DAY)
    // Day 30: the first block is gone, the second has 10 days left.
    expect(texts(addPastes(list, [log('new')], NOW + 30 * DAY - 1))).toEqual([log('new'), OTHER, LOG])
    expect(texts(addPastes(list, [log('new')], NOW + 30 * DAY))).toEqual([log('new'), OTHER])
    // Sent again in time: 30 more days.
    list = addPastes(list, [LOG], NOW + 29 * DAY)
    expect(texts(addPastes(list, [log('new')], NOW + 45 * DAY))).toEqual([log('new'), LOG])
  })

  it('reads back well-formed blocks that have not expired', () => {
    const raw = [{ text: LOG, at: NOW - DAY }, 3, null, { text: 'short', at: NOW }, { text: OTHER, at: NOW - 30 * DAY }, { text: log('x') }, { text: LOG, at: NOW }, { text: log('y'), at: NOW - 29 * DAY }]
    expect(loadPastes(raw, NOW)).toEqual([{ text: LOG, at: NOW - DAY }, { text: log('y'), at: NOW - 29 * DAY }])
    expect(loadPastes({ a: LOG }, NOW)).toEqual([])
    expect(loadPastes(null, NOW)).toEqual([])
    // A clock set back: a block never lives longer than 30 days from now.
    expect(loadPastes([{ text: LOG, at: NOW + 90 * DAY }], NOW)).toEqual([{ text: LOG, at: NOW }])
  })

  it('reads the first format (texts alone): their 30 days start then', () => {
    expect(loadPastes([LOG, 'short', OTHER], NOW)).toEqual([{ text: LOG, at: NOW }, { text: OTHER, at: NOW }])
  })
})

describe('conversation served to every device', () => {
  it('lists the pasted text of a message sent from another device', () => {
    const items = [user('hello'), { role: 'assistant', text: LOG, ts: null } as ChatItem, user(`fix this\n\n${LOG}`), user(TYPED)]
    const out = withPasted(items, [OTHER, LOG])
    expect(out.map(i => i.pasted)).toEqual([undefined, undefined, [LOG], undefined])
    // Untouched items are the same objects.
    expect(out[0]).toBe(items[0])
    expect(out[3]).toBe(items[3])
    // A device that never sent it shows the words and the card.
    expect(splitPasted(out[2]!.text, out[2]!.pasted, [])).toEqual({ text: 'fix this', pastes: [LOG] })
    // And so does the one that sent it.
    expect(splitPasted(out[2]!.text, out[2]!.pasted, [LOG])).toEqual({ text: 'fix this', pastes: [LOG] })
  })

  it('changes nothing without kept pasted texts', () => {
    const items = [user(`fix this\n\n${LOG}`)]
    expect(withPasted(items, [])).toBe(items)
  })

  it('keeps long typed words a message, next to the paste', () => {
    const [item] = withPasted([user(messageBody(TYPED, [LOG], []))], [LOG])
    expect(splitPasted(item!.text, item!.pasted, [])).toEqual({ text: TYPED, pastes: [LOG] })
  })

  it('lists several pasted texts in the order of the message', () => {
    expect(pastedIn([LOG, OTHER], `see\n\n${OTHER}\n\n${LOG}`)).toEqual([OTHER, LOG])
  })

  it('takes the whole block when a kept one sits inside another', () => {
    const inner = LOG.split('\n').slice(5, 25).join('\n')
    // The inner block was sent last: still the whole paste as one card.
    expect(pastedIn([inner, LOG], `fix this\n\n${LOG}`)).toEqual([LOG])
  })

  it('keeps the blocks Claude lists (a paste into its terminal)', () => {
    const text = `Why?\n\n${OTHER}`
    const [same] = withPasted([user(text, [OTHER])], [LOG])
    expect(same!.pasted).toEqual([OTHER])
    // Claude lists the whole wherdr send when words were typed in its terminal
    // too: the kept paste inside it wins, the words stay.
    const whole = `fix this\n\n${LOG}`
    const [cut] = withPasted([user(`also\n${whole}`, [whole])], [LOG])
    expect(cut!.pasted).toEqual([LOG])
  })

  it('finds a paste the server clipped by its start, and lists what the message holds of it', () => {
    const long = log('big', 600)
    const text = `fix this\n\n${long}`.slice(0, 20000) + '…'
    const part = long.slice(0, 20000 - 10)
    const [item] = withPasted([user(text)], [long])
    expect(item!.pasted).toEqual([part])
    expect(splitPasted(item!.text, item!.pasted, [])).toEqual({ text: 'fix this', pastes: [part] })
    // The device that sent it shows the same card.
    expect(splitPasted(item!.text, item!.pasted, [long])).toEqual({ text: 'fix this', pastes: [part] })
  })
})

// A paste sent again later, longer: both start the same way.
describe('two pasted texts that start the same way', () => {
  const FIRST = log('pkg', 31)
  const SECOND = log('pkg', 61)
  // Most recent first, as the server keeps them.
  const kept = texts(addPastes(addPastes([], [FIRST], NOW), [SECOND], NOW))

  it('never shows the later paste on the earlier message, on any agent', () => {
    expect(SECOND.startsWith(FIRST)).toBe(true)
    // One conversation per agent; the same kept list serves both.
    const claude = withPasted([user(FIRST), user(`and now\n\n${SECOND}`)], kept)
    const codex = withPasted([user(`fix this\n\n${FIRST}`), user(SECOND)], kept)
    expect(claude.map(i => i.pasted)).toEqual([[FIRST], [SECOND]])
    expect(codex.map(i => i.pasted)).toEqual([[FIRST], [SECOND]])
    // The later paste sent to one agent only: the other's message keeps its own card.
    expect(withPasted([user(FIRST)], [SECOND])[0]!.pasted).toBeUndefined()
    expect(withPasted([user(FIRST)], [SECOND, FIRST])[0]!.pasted).toEqual([FIRST])
    for (const conv of [claude, codex]) {
      for (const i of conv) for (const b of i.pasted!) expect(i.text).toContain(b)
    }
  })

  it('shows each message its own card, on the device that sent both and on another', () => {
    for (const known of [[], [SECOND, FIRST], [FIRST, SECOND], [SECOND], [FIRST]]) {
      expect(splitPasted(`fix this\n\n${FIRST}`, [FIRST], known)).toEqual({ text: 'fix this', pastes: [FIRST] })
    }
    for (const known of [[], [SECOND, FIRST], [FIRST, SECOND], [SECOND]]) {
      expect(splitPasted(SECOND, [SECOND], known)).toEqual({ text: '', pastes: [SECOND] })
    }
    // Codex and omp list nothing: the device's own memory, and never the later paste.
    expect(splitPasted(FIRST, [], [SECOND, FIRST])).toEqual({ text: '', pastes: [FIRST] })
    expect(splitPasted(FIRST, [], [SECOND])).toEqual({ text: FIRST, pastes: [] })
  })

  it('lists of a clipped message only what it holds, whatever kept paste starts like it', () => {
    const a = log('big', 600)
    const b = `${a}\n${log('more', 50)}`
    const text = `fix this\n\n${a}`.slice(0, 20000) + '…'
    const part = a.slice(0, 20000 - 10)
    expect(withPasted([user(text)], [b, a])[0]!.pasted).toEqual([part])
    expect(splitPasted(text, [part], [b, a])).toEqual({ text: 'fix this', pastes: [part] })
    // A message that only ends like the start of a paste holds no paste.
    const typed = `${TYPED}\n${a.slice(0, 300)}`
    expect(withPasted([user(typed)], [a])[0]!.pasted).toBeUndefined()
    expect(withPasted([user(`${typed}…`)], [a])[0]!.pasted).toBeUndefined()
  })
})

describe('queued record', () => {
  it('lists its pasted texts: what its text, cut short, holds of them', () => {
    const long = log('big', 600)
    const q = { id: 'w-1', text: `fix this\n\n${long}`.slice(0, 4000), at: 1 }
    const part = long.slice(0, 4000 - 10)
    const out = withQueuedPasted(q, [long])
    expect(out.pasted).toEqual([part])
    // Every device shows the words and a card of what the record holds.
    expect(splitPasted(out.text, out.pasted, [])).toEqual({ text: 'fix this', pastes: [part] })
    expect(splitPasted(out.text, out.pasted, [long])).toEqual({ text: 'fix this', pastes: [part] })
    // Cancelled on the device that sent it: the whole paste goes back into
    // the field, unless two of its pastes start that way.
    expect(splitPasted(out.text, out.pasted, [long], true)).toEqual({ text: 'fix this', pastes: [long] })
    expect(splitPasted(out.text, out.pasted, [`${long}\nmore`, long], true)).toEqual({ text: 'fix this', pastes: [part] })
  })

  it('lists a second paste the record stops in, after a whole one', () => {
    const long = log('big', 600)
    const q = { id: 'w-1', text: `fix this\n\n${LOG}\n\n${long}`.slice(0, 4000), at: 1 }
    const part = long.slice(0, 4000 - 12 - LOG.length)
    const out = withQueuedPasted(q, [long, LOG])
    expect(out.pasted).toEqual([LOG, part])
    expect(splitPasted(out.text, out.pasted, [])).toEqual({ text: 'fix this', pastes: [LOG, part] })
  })

  it('is unchanged without a paste', () => {
    const q = { id: 'w-1', text: TYPED, at: 1 }
    expect(withQueuedPasted(q, [LOG])).toBe(q)
  })

  it('never lists the later, longer paste for a short record', () => {
    const first = log('pkg', 31)
    const out = withQueuedPasted({ id: 'w-1', text: first, at: 1 }, [log('pkg', 61), first])
    expect(out.pasted).toEqual([first])
  })
})

describe('data/pastes.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-pastes-'))
  const file = path.join(dir, 'pastes.json')
  const body = `fix this\n\n${LOG}`
  const ranges = pasteRanges(body, [LOG])
  // A fresh module: the server just started with this data folder.
  const start = () => { vi.resetModules(); return import('../server/utils/pastes') }
  const onDisk = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as KeptPaste[]).map(p => p.text)
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is written when a paste is sent, read back at startup, and left alone otherwise', async () => {
    vi.stubEnv('DATA_DIR', dir)
    const server = await start()
    // No paste: no file.
    server.keepPastes('a short message', undefined)
    server.keepPastes(TYPED, [])
    await new Promise(r => setTimeout(r, 50))
    expect(fs.existsSync(file)).toBe(false)

    server.keepPastes(body, ranges)
    await vi.waitFor(() => expect(onDisk()).toEqual([LOG]))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(server.chatPasted([user(body)])[0]!.pasted).toEqual([LOG])

    // After a restart the conversation still lists it; a message without a
    // paste and a purge with nothing expired write nothing.
    const restarted = await start()
    expect(restarted.chatPasted([user(body)])[0]!.pasted).toEqual([LOG])
    fs.rmSync(file)
    restarted.keepPastes(TYPED, [])
    restarted.purgePastes()
    await new Promise(r => setTimeout(r, 50))
    expect(fs.existsSync(file)).toBe(false)
  })

  it('drops the blocks older than 30 days at startup, from the file too', async () => {
    vi.stubEnv('DATA_DIR', dir)
    const now = Date.now()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify([{ text: OTHER, at: now - 5 * DAY }, { text: LOG, at: now - 31 * DAY }]) + '\n', { mode: 0o600 })
    const server = await start()
    // Never served again, even before the file is written.
    expect(server.chatPasted([user(body)])[0]!.pasted).toBeUndefined()
    expect(server.chatPasted([user(`see\n\n${OTHER}`)])[0]!.pasted).toEqual([OTHER])
    server.purgePastes()
    await vi.waitFor(() => expect(fs.readFileSync(file, 'utf8')).not.toContain('Pouring pkg-0-'))
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([{ text: OTHER, at: now - 5 * DAY }])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['pastes.json'])
  })

  it('drops a block that expires while the server runs, at the next purge or write', async () => {
    vi.stubEnv('DATA_DIR', dir)
    const server = await start()
    const t0 = Date.now()
    server.keepPastes(body, ranges)
    await vi.waitFor(() => expect(onDisk()).toEqual([LOG]))
    // 29 days later: still there. Day 30: gone from the conversation and the file.
    server.purgePastes(t0 + 29 * DAY)
    expect(server.chatPasted([user(body)])[0]!.pasted).toEqual([LOG])
    server.purgePastes(t0 + 30 * DAY + 1000)
    expect(server.chatPasted([user(body)])[0]!.pasted).toBeUndefined()
    await vi.waitFor(() => expect(onDisk()).toEqual([]))
  })

  it('gives the blocks of the first format a date, written at startup', async () => {
    vi.stubEnv('DATA_DIR', dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify([LOG]) + '\n', { mode: 0o600 })
    const before = Date.now()
    const server = await start()
    expect(server.chatPasted([user(body)])[0]!.pasted).toEqual([LOG])
    server.purgePastes()
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).toMatchObject({ text: LOG }))
    const at = JSON.parse(fs.readFileSync(file, 'utf8'))[0].at
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('is written to a temporary file then renamed, one write after the other', async () => {
    vi.stubEnv('DATA_DIR', dir)
    const server = await start()
    // What touches the disk, in order: a write is slow, a second send comes in meanwhile.
    const events: string[] = []
    const slow = Promise.withResolvers<void>()
    const name = (f: unknown) => (path.basename(String(f)) === 'pastes.json' ? 'pastes.json' : 'temp')
    const write = fsp.writeFile.bind(fsp)
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (f, data, o) => {
      events.push(`write ${name(f)}`)
      await slow.promise
      await write(f, data, o)
      events.push('written')
    })
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // The reader of the file always finds a whole list.
      if (fs.existsSync(file)) expect(onDisk()).toEqual([LOG])
      await rename(from, to)
      events.push(`rename ${name(from)} -> ${name(to)}`)
    })
    server.keepPastes(body, ranges)
    await vi.waitFor(() => expect(events).toEqual(['write temp']))
    const second = `and this\n\n${OTHER}`
    server.keepPastes(second, pasteRanges(second, [OTHER]))
    await new Promise(r => setTimeout(r, 30))
    expect(events).toEqual(['write temp'])
    slow.resolve()
    await vi.waitFor(() => expect(events.filter(e => e.startsWith('rename'))).toHaveLength(2))
    const one = ['write temp', 'written', 'rename temp -> pastes.json']
    expect(events).toEqual([...one, ...one])
    expect(onDisk()).toEqual([OTHER, LOG])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    // No temporary file left behind.
    expect(fs.readdirSync(dir)).toEqual(['pastes.json'])
  })

  it('leaves the file as it was, and no temporary file, when a write fails', async () => {
    vi.stubEnv('DATA_DIR', dir)
    const server = await start()
    server.keepPastes(body, ranges)
    await vi.waitFor(() => expect(onDisk()).toEqual([LOG]))
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk full'))
    const second = `and this\n\n${OTHER}`
    server.keepPastes(second, pasteRanges(second, [OTHER]))
    await new Promise(r => setTimeout(r, 80))
    expect(onDisk()).toEqual([LOG])
    expect(fs.readdirSync(dir)).toEqual(['pastes.json'])
    // Still served from memory, and written with the next send.
    expect(server.chatPasted([user(second)])[0]!.pasted).toEqual([OTHER])
    const third = `last\n\n${log('third')}`
    server.keepPastes(third, pasteRanges(third, [log('third')]))
    await vi.waitFor(() => expect(onDisk()).toEqual([log('third'), OTHER, LOG]))
  })
})
