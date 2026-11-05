import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatDelta, itemSigs, splitToken } from '../server/utils/chatDelta'
import { anchorOf, createTranscripts, headOf } from '../server/utils/transcripts'
import { createTailLoader, nextTail, restartsTail, tailQuery } from '../app/utils/chatTail'
import type { ChatItem } from '../shared/types'
import { type FsStat, type MachineFs, type ShellExec, createShellFs, localFs } from '../server/utils/fsx'
import { spawn } from 'node:child_process'
import { renameSync } from 'node:fs'

const item = (text: string, role: ChatItem['role'] = 'assistant'): ChatItem => ({ role, text, ts: '2026-01-01T00:00:00Z' })

describe('chatDelta', () => {
  it('signs each item object once, and equal items alike', () => {
    const a = [item('one', 'user'), item('two')]
    const first = itemSigs(a)
    const json = vi.spyOn(JSON, 'stringify')
    try {
      expect(itemSigs(a)).toEqual(first)
      expect(json).not.toHaveBeenCalled()
      expect(itemSigs([a[0]!, item('two'), item('three')]).subarray(0, 4)).toEqual(first)
      expect(json).toHaveBeenCalledTimes(2)
    } finally { json.mockRestore() }
  })

  it('sends the whole list to a client it does not know, then only what changed', () => {
    const d = createChatDelta()
    const a = [item('one', 'user'), item('two'), item('three')]
    const first = d.reply('p', 'f:100:0', a, '', 0, true)
    expect(first.keep).toBeUndefined()
    expect(first.items).toBe(a)
    expect(splitToken(first.token)).toEqual({ base: 'f:100:0', fp: expect.stringMatching(/^[0-9a-f]{16}$/) })

    // One reply added, and the last one rewritten (the agent kept writing).
    const b = [a[0]!, a[1]!, item('three, longer'), item('four')]
    const next = d.reply('p', 'f:180:0', b, first.token, 3, true)
    expect(next.keep).toBe(2)
    expect(next.items).toEqual([item('three, longer'), item('four')])
    expect(nextTail(a, next)).toEqual(b)
  })

  it('falls back to the whole list when the client list is not the one it remembers', () => {
    const d = createChatDelta()
    const a = [item('one'), item('two')]
    const first = d.reply('p', 'f:10:0', a, '', 0, true)
    const b = [...a, item('three')]
    expect(d.reply('p', 'f:20:0', b, first.token, 5, true).keep).toBeUndefined() // other count
    expect(d.reply('p', 'f:20:0', b, first.token, 2, false).keep).toBeUndefined() // other start
    expect(d.reply('p2', 'f:20:0', b, first.token, 2, true).keep).toBeUndefined() // other pane
    expect(d.reply('p', 'f:20:0', b, 'f:10:0', 2, true).keep).toBeUndefined() // token without fingerprint
    expect(d.reply('p', 'f:20:0', b, 'f:10:0#0123456789abcdef', 2, true).keep).toBeUndefined() // unknown list
    d.forget('p')
    expect(d.reply('p', 'f:20:0', b, first.token, 2, true).keep).toBeUndefined() // forgotten
  })

  it('tells apart two lists sent under the same transcript token', () => {
    // Same file and size, different content (a pasted text recognised later).
    const d = createChatDelta()
    const x = d.reply('p', 'f:10:0', [item('a', 'user')], '', 0, true)
    const y = d.reply('p', 'f:10:0', [{ ...item('a', 'user'), pasted: ['a'] }], '', 0, true)
    expect(x.token).not.toBe(y.token)
    const z = d.reply('p', 'f:20:0', [{ ...item('a', 'user'), pasted: ['a'] }, item('b')], x.token, 1, true)
    expect(z.keep).toBe(0) // the client holding x gets its first item again
  })

  it('gives readers that do not splice (no n) the plain token, and remembers nothing for them', () => {
    const d = createChatDelta()
    const items = [item('a')]
    const x = d.reply('p', 'f:10:0', items, '', null, true)
    expect(x).toEqual({ token: 'f:10:0', items })
    expect(d.size()).toBe(0)
    expect(d.sinceOf('p', x.token, null)).toBe('f:10:0') // "unchanged" stays possible
  })

  it('expires lists not used for a while, and polling keeps them alive', () => {
    let t = 0
    const d = createChatDelta({ now: () => t, ttl: 1000 })
    const x = d.reply('p', 'f:10:0', [item('a')], '', 0, true)
    t = 900
    expect(d.knows('p', x.token, 1)).toBe(true) // a poll touches it
    t = 1800
    expect(d.knows('p', x.token, 1)).toBe(true)
    t = 2900
    expect(d.knows('p', x.token, 1)).toBe(false)
    expect(d.size()).toBe(0)
  })

  it('keeps all panes together under a global budget, dropping the least recently used', () => {
    let t = 0
    const d = createChatDelta({ now: () => t, maxSigs: 5 })
    const two = (k: string) => [item(`${k}1`), item(`${k}2`)]
    const a = d.reply('a', 'f:1:0', two('a'), '', 0, true); t++
    const b = d.reply('b', 'f:1:0', two('b'), '', 0, true); t++
    expect(d.knows('a', a.token, 2)).toBe(true); t++ // a used again: b is now the oldest
    d.reply('c', 'f:1:0', two('c'), '', 0, true)
    expect(d.size()).toBeLessThanOrEqual(5)
    expect(d.knows('b', b.token, 2)).toBe(false)
    expect(d.knows('a', a.token, 2)).toBe(true)
    // A list longer than the whole budget is not remembered: full lists.
    const big = d.reply('d', 'f:1:0', Array.from({ length: 6 }, (_, k) => item(String(k))), '', 0, true)
    expect(d.knows('d', big.token, 6)).toBe(false)
  })

  it('forgets a closed pane', () => {
    const d = createChatDelta()
    const x = d.reply('p', 'f:10:0', [item('a')], '', 0, true)
    d.reply('q', 'f:10:0', [item('b')], '', 0, true)
    expect(d.ids().sort()).toEqual(['p', 'q'])
    d.forget('p')
    expect(d.ids()).toEqual(['q'])
    expect(d.knows('p', x.token, 1)).toBe(false)
    expect(d.size()).toBe(1)
  })

  it('gives the transcript token only for a list it remembers with that count', () => {
    const d = createChatDelta()
    const x = d.reply('p', 'f:10:0', [item('a'), item('b')], '', 0, true)
    expect(d.sinceOf('p', x.token, 2)).toBe('f:10:0') // known: "unchanged" is allowed
    expect(d.sinceOf('p', x.token, 99999)).toBe('') // wrong count: full list
    expect(d.sinceOf('p', x.token, null)).toBe('')
    expect(d.sinceOf('p', 'f:10:0#0123456789abcdef', 2)).toBe('') // unknown fingerprint
    expect(d.sinceOf('p2', x.token, 2)).toBe('') // other pane
    expect(d.sinceOf('p', 'f:10:0', null)).toBe('f:10:0') // old token, without fingerprint
    expect(d.sinceOf('p', '', 0)).toBe('')
  })

  it('keeps a bounded number of lists per pane', () => {
    const d = createChatDelta()
    const tokens = Array.from({ length: 6 }, (_, k) => d.reply('p', `f:${k}:0`, [item(String(k))], '', 0, true).token)
    expect(d.reply('p', 'f:9:0', [item('0'), item('x')], tokens[0]!, 1, true).keep).toBeUndefined()
    expect(d.reply('p', 'f:9:0', [item('5'), item('x')], tokens[5]!, 1, true).keep).toBe(1)
  })
})

describe('nextTail and tailQuery', () => {
  it('splices an incremental reply and refuses one that does not fit', () => {
    const tail = [item('a'), item('b')]
    expect(nextTail(tail, { items: [item('c')] })).toEqual([item('c')])
    expect(nextTail(tail, { keep: 1, items: [item('c')] })).toEqual([item('a'), item('c')])
    expect(nextTail(tail, { keep: 1, items: [item('c')] })![0]).toBe(tail[0])
    expect(nextTail(tail, { keep: 2, items: [] })).toBe(tail)
    expect(nextTail(tail, { keep: 3, items: [] })).toBeNull()
    expect(nextTail(tail, { keep: -1, items: [] })).toBeNull()
  })

  it('sends the item count of the list held (0 without a token)', () => {
    expect(Object.fromEntries(tailQuery('w1:p1', { token: '', tailStart: null, tail: [] }))).toEqual({ pane: 'w1:p1', since: '', n: '0' })
    expect(Object.fromEntries(tailQuery('w1:p1', { token: '', tailStart: 0, tail: [item('a')] }))).toEqual({ pane: 'w1:p1', since: '', from: '0', n: '0' })
    expect(Object.fromEntries(tailQuery('w1:p1', { token: 't#x', tailStart: 40, tail: [item('a')] }))).toEqual({ pane: 'w1:p1', since: 't#x', from: '40', n: '1' })
  })
})

// End to end on a real transcript file: what the client rebuilds from the
// incremental replies is exactly the list a full re-read gives.
describe('incremental re-read of a Claude transcript', () => {
  const homes: string[] = []
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })
  const noHerdr = async () => { throw new Error('no Herdr') }
  let n = 0
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString()
  const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: at() })
  const said = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content }, timestamp: at() })
  const reply = (k: number) => said([{ type: 'text', text: `Reply ${k}:\n\n- a point\n- another point\n\n\`\`\`js\nconst x = ${k}\n\`\`\`\n\nShall I go on?` }])
  const result = (id: string, text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, timestamp: at() })

  function setup(messages: number, pad = '', opts: { fs?: MachineFs, now?: () => number } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-delta-'))
    homes.push(home)
    const dir = path.join(home, '.claude/projects/-x')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'abc-123.jsonl')
    const lines: string[] = []
    for (let k = 0; k < messages / 2; k++) lines.push(user(`Question ${k}${pad}`), reply(k))
    writeFileSync(file, lines.join('\n') + '\n')
    const t = createTranscripts({ home, herdr: noHerdr, ...opts })
    const pane = { id: 'w1:p1', agent: 'claude', cwd: '/x', agentSession: 'abc-123' }
    const d = createChatDelta()
    // What /api/chat does with the transcript's reply (server/api/chat.get.ts).
    const call = async (since: string, from: number | null, count: number | null) => {
      const r = await t.chat(pane, { since: d.sinceOf(pane.id, since, count), from, anchor: since })
      if (r.unchanged || !r.items) return { ...r, token: since }
      return { ...r, ...d.reply(pane.id, r.token!, r.items, since, count, from !== null && r.start === from && !r.rewritten) }
    }
    return { file, t, pane, call, d }
  }

  it('sends one new message instead of the whole conversation, and rebuilds the same list', async () => {
    const { file, call } = setup(2000)
    const first = await call('', null, 0)
    expect(first.items!.length).toBe(2000)
    let tail = first.items!
    let token = first.token!
    const start = first.start!
    const sizes: number[] = []

    // A tool call, its result (which changes the call already sent), then replies.
    const steps = [
      said([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
      result('toolu_1', 'a\nb'),
      reply(1000),
      user('Thanks'),
    ]
    for (const line of steps) {
      appendFileSync(file, line + '\n')
      const r = await call(token, start, tail.length)
      expect(r.keep).toBeDefined()
      sizes.push(JSON.stringify(r).length)
      tail = nextTail(tail, r)!
      token = r.token!
      const full = await call('', start, null)
      expect(tail).toEqual([...full.items!])
    }
    const fullSize = JSON.stringify(await call('', start, null)).length
    // Whole conversation each time before; a few hundred bytes now.
    expect(fullSize).toBeGreaterThan(150_000)
    for (const s of sizes) expect(s).toBeLessThan(2_000)
    // The tool call sent at step 1 comes again once its result is in.
    expect(tail.find(i => i.role === 'tool' && i.name === 'Bash')).toBeTruthy()
  })

  it('falls back to a full reply when the file became shorter than the start', async () => {
    const { file, call } = setup(20)
    const first = await call('', null, 0)
    // A first load that started mid-file (as after paging): pretend start was further down.
    writeFileSync(file, user('Fresh start') + '\n')
    const r = await call(first.token!, 5000, first.items!.length)
    expect(r.keep).toBeUndefined()
    expect(r.start).not.toBe(5000) // the client sees another start and reloads from the bottom
  })

  it('keeps the first message when the bottom starts past the first window (cursor > 0)', async () => {
    // About 3 MB: the first load reads back one 2 MB window and starts mid-file.
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`)
    const first = await call('', null, 0)
    const start = first.start!
    expect(start).toBeGreaterThan(0)
    const again = await call('', start, null)
    expect(again.start).toBe(start)
    expect([...again.items!]).toEqual([...first.items!]) // the first message is not lost
    appendFileSync(file, user('One more') + '\n')
    const r = await call(first.token!, start, first.items!.length)
    expect(r.keep).toBe(first.items!.length)
    expect(nextTail(first.items!, r)).toEqual([...(await call('', start, null)).items!])
  })

  // Documented limit: past the 24 MB read cap the server reads back from the
  // end, and the client starts again from the bottom (older pages dropped).
  it('restarts from the bottom when the file grew more than 24 MB past the start', async () => {
    const { file, call } = setup(20)
    const load = await call('', null, 0)
    const start = load.start!
    const first = await call(load.token!, start, load.items!.length)
    const chunk = Array.from({ length: 50 }, (_, k) => user(`Big ${k} ${'y'.repeat(100_000)}`)).join('\n') + '\n'
    for (let k = 0; k < 6; k++) appendFileSync(file, chunk) // about 30 MB
    const r = await call(first.token!, start, load.items!.length)
    expect(r.start).toBeGreaterThan(start)
    expect(r.keep).toBeUndefined() // other start: never a delta
    expect(restartsTail({ file: first.file!, tailStart: start }, r)).toBe(true)
    expect(restartsTail({ file: first.file!, tailStart: start }, first)).toBe(false)
    expect(restartsTail({ file: first.file!, tailStart: start }, { file: 'other.jsonl', start })).toBe(true)
    expect(restartsTail({ file: null, tailStart: null }, r)).toBe(false)
  }, 30_000)

  it('answers an unknown token or a wrong count with the full list, never "unchanged"', async () => {
    const { call } = setup(20)
    const load = await call('', null, 0)
    const start = load.start!
    const first = await call(load.token!, start, load.items!.length) // first poll, from the start
    expect(first.keep).toBe(load.items!.length)
    const held = load.items!.length
    expect((await call(first.token!, start, held)).unchanged).toBe(true)
    const base = splitToken(first.token!).base
    // (A fingerprinted token without n: not something an old client holds, still full.)
    for (const [since, count] of [[`${base}#0123456789abcdef`, held], [first.token!, 99999], [first.token!, null]] as const) {
      const r = await call(since, start, count)
      expect(r.unchanged).toBeFalsy()
      expect(r.keep).toBeUndefined()
      expect(r.items!.length).toBe(load.items!.length)
    }
  })
  it('re-reads a transcript rewritten at the same size', async () => {
    const { file, call } = setup(20)
    const load = await call('', null, 0)
    const first = await call(load.token!, load.start!, load.items!.length)
    const before = readFileSync(file, 'utf8')
    const after = before.replace('Question 3', 'Answered 3')
    expect(after.length).toBe(before.length)
    writeFileSync(file, after)
    utimesSync(file, new Date(), new Date(Date.now() + 5000)) // another modification time
    const r = await call(first.token!, load.start!, load.items!.length)
    expect(r.unchanged).toBeFalsy()
    const tail = nextTail(load.items!, r)!
    expect(tail.some(i => i.text === 'Answered 3')).toBe(true)
    expect(tail.some(i => i.text === 'Question 3')).toBe(false)
  })

  // A file shortened above the cursor, whose old cursor byte now happens to be
  // a line start: without the join check the client kept its older pages.
  function rewriteAbove(file: string, start: number) {
    const old = readFileSync(file)
    // One line ending exactly at `start`, then a shorter bottom.
    const msg = (pad: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'Rewritten' }, timestamp: '2026-01-02T00:00:00.000Z', pad })
    const filler = msg('z'.repeat(start - 1 - Buffer.byteLength(msg(''))))
    const bottom = user('After the rewrite') + '\n'
    writeFileSync(file, `${filler}\n${bottom}`)
    expect(statSync(file).size).toBeLessThan(old.length)
    expect(readFileSync(file)[start - 1]).toBe(0x0a)
  }

  it('starts again from the bottom when the file was shortened above the cursor', async () => {
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`)
    const load = await call('', null, 0)
    const start = load.start!
    expect(start).toBeGreaterThan(5000)
    const first = await call(load.token!, start, load.items!.length)
    expect(first.keep).toBe(load.items!.length)
    rewriteAbove(file, start)
    const r = await call(first.token!, start, load.items!.length)
    expect(r.rewritten).toBe(true)
    expect(r.keep).toBeUndefined()
    expect(restartsTail({ file: first.file!, tailStart: start }, r)).toBe(true)
    // A fresh bottom, read back from the end.
    expect(r.items!.at(-1)!.text).toBe('After the rewrite')
    // From that new start, re-reads are incremental again.
    const again = await call(r.token!, r.start!, r.items!.length)
    expect(again.rewritten).toBeUndefined()
    expect(again.unchanged || again.keep === r.items!.length).toBe(true)
  })

  it('checks the join point even for a list the server forgot (restart)', async () => {
    const { file, call, t, pane } = setup(6000, ` ${'x'.repeat(400)}`)
    const load = await call('', null, 0)
    const start = load.start!
    rewriteAbove(file, start)
    // A server that forgot the list gets no `since`, only the token as sent.
    const r = await t.chat(pane, { since: '', from: start, anchor: `${load.token!}#0123456789abcdef` })
    expect(r.rewritten).toBe(true)
    expect(r.items!.at(-1)!.text).toBe('After the rewrite')
  })

  it('starts again when the file is replaced by another one (inode), join bytes unchanged', async () => {
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`)
    const load = await call('', null, 0)
    const start = load.start!
    const first = await call(load.token!, start, load.items!.length)
    // Same length, change far above the cursor (outside the anchor), renamed over.
    const before = readFileSync(file, 'utf8')
    const after = before.replace('Question 0 ', 'Answered 0 ')
    expect(after.length).toBe(before.length)
    const ino = statSync(file).ino
    writeFileSync(`${file}.tmp`, after)
    renameSync(`${file}.tmp`, file)
    expect(statSync(file).ino).not.toBe(ino)
    const r = await call(first.token!, start, load.items!.length)
    expect(r.rewritten).toBe(true)
    expect(restartsTail({ file: first.file!, tailStart: start }, r)).toBe(true)
  })

  it('starts again when the file is rewritten in place at the same size', async () => {
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`)
    const load = await call('', null, 0)
    const start = load.start!
    const first = await call(load.token!, start, load.items!.length)
    const ino = statSync(file).ino
    writeFileSync(file, readFileSync(file, 'utf8').replace('Question 0 ', 'Answered 0 '))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(statSync(file).ino).toBe(ino)
    const r = await call(first.token!, start, load.items!.length)
    expect(r.rewritten).toBe(true)
  })

  // Remote machine: the real stat script and checksum, local reads. With
  // `whole`, the stat has whole seconds only (no fractions on that machine).
  const sh: ShellExec = (script, args = []) => new Promise((resolve) => {
    const child = spawn('sh', ['-c', script, 'sh', ...args])
    const out: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: '' }))
  })
  function remoteFs(whole: boolean): MachineFs {
    const remote = createShellFs(sh, { statTtlMs: 0 })
    const floor = (st: FsStat) => (whole ? { ...st, mtimeMs: Math.floor(st.mtimeMs / 1000) * 1000 } : st)
    return {
      ...localFs,
      stat: async p => floor(await remote.stat(p)),
      statMany: async ps => (await remote.statMany(ps)).map(st => st && floor(st)),
      digest: remote.digest,
    }
  }

  it('reads fractions of a second from the remote stat when it has them', async () => {
    const { file } = setup(2)
    utimesSync(file, 1767225600.8, 1767225600.8)
    // Filesystems may truncate utimes to microseconds (799.999 ms instead of 800).
    // Keep the subsecond check without requiring an exact floating-point timestamp.
    expect((await remoteFs(false).stat(file)).mtimeMs).toBeCloseTo(1767225600800, 1)
  })

  for (const whole of [false, true]) {
    it(`starts again after a same-second remote rewrite far above the cursor (${whole ? 'whole seconds' : 'fractions'})`, async () => {
      let clock = 1_000_000
      const { file, call, t, pane } = setup(6000, ` ${'x'.repeat(400)}`, { fs: remoteFs(whole), now: () => clock })
      const second = 1767225600
      utimesSync(file, second + 0.1, second + 0.1)
      const load = await call('', null, 0)
      const start = load.start!
      const older = await t.chat(pane, { before: start })
      expect(older.items!.some(i => i.text?.startsWith('Question 1 '))).toBe(true)
      clock += 200
      const first = await call(load.token!, start, load.items!.length)
      // A loaded older message rewritten, same size and inode, same second.
      const ino = statSync(file).ino
      writeFileSync(file, readFileSync(file, 'utf8').replace('Question 1 ', 'Answered 1 '))
      utimesSync(file, second + 0.8, second + 0.8)
      expect(statSync(file).ino).toBe(ino)
      clock += 300
      const r = await call(first.token!, start, load.items!.length)
      expect(r.rewritten).toBe(true)
      expect(restartsTail({ file: first.file!, tailStart: start }, r)).toBe(true)
      // And once settled, a client that did not restart is still told to.
      clock += 2000
      const late = await call(first.token!, start, load.items!.length)
      expect(late.unchanged).toBeFalsy()
      expect(late.rewritten).toBe(true)
    })
  }

  it('never says "unchanged" for a remote state read within its mtime second', async () => {
    let clock = 1_000_000
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`, { fs: remoteFs(true), now: () => clock })
    const second = 1767225600
    utimesSync(file, second + 0.1, second + 0.1)
    const load = await call('', null, 0)
    const start = load.start!
    clock += 200
    let token = (await call(load.token!, start, load.items!.length)).token!
    // Rewritten at the same size and inode, within the same second.
    const ino = statSync(file).ino
    writeFileSync(file, readFileSync(file, 'utf8').replace('Question 2999 ', 'Answered 2999 '))
    utimesSync(file, second + 0.8, second + 0.8)
    expect(statSync(file).ino).toBe(ino)
    clock += 300
    const r = await call(token, start, load.items!.length)
    expect(r.unchanged).toBeFalsy()
    const tail = nextTail(load.items!, r)!
    expect(tail.some(i => i.text?.startsWith('Answered 2999'))).toBe(true)
    // Once the second is over, polls are "unchanged" again.
    token = r.token!
    clock += 2000
    token = (await call(token, start, tail.length)).token!
    expect((await call(token, start, tail.length)).unchanged).toBe(true)
  })

  it('keeps plain growth incremental and "unchanged" when nothing moved', async () => {
    const { file, call } = setup(6000, ` ${'x'.repeat(400)}`)
    const load = await call('', null, 0)
    const start = load.start!
    const first = await call(load.token!, start, load.items!.length)
    expect((await call(first.token!, start, load.items!.length)).unchanged).toBe(true)
    appendFileSync(file, user('More') + '\n')
    const r = await call(first.token!, start, load.items!.length)
    expect(r.rewritten).toBeUndefined()
    expect(r.keep).toBe(load.items!.length)
  })
})

describe('anchorOf', () => {
  it('reads the anchor of a token as the client sends it', () => {
    expect(anchorOf('a.jsonl:900:120:77-1700:42/120.0123456789ab')).toEqual({ start: 120, hash: '0123456789ab' })
    expect(anchorOf('a.jsonl:900:120:77-1700:42/120.0123456789ab~3#0123456789abcdef')).toEqual({ start: 120, hash: '0123456789ab' })
    expect(anchorOf('a.jsonl:900:120')).toBeNull() // token of an older server
    expect(anchorOf('')).toBeNull()
  })

  it('reads the state a token was read from', () => {
    expect(headOf('a.jsonl:900:120:77-1700!/120.0123456789ab~3#0123456789abcdef')).toEqual({ file: 'a.jsonl', size: 900, from: 120, ino: 77, gen: '77-1700', unsettled: true })
    expect(headOf('a.jsonl:900:null:1700')).toEqual({ file: 'a.jsonl', size: 900, from: null, ino: null, gen: '1700', unsettled: false })
    expect(headOf('a.jsonl:900:120')).toBeNull() // token of an older server
  })
})

describe('/api/chat for a client without n (older app, plugins)', () => {
  it('reads in full once, then gets "unchanged" with the token it received', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-delta-old-'))
    try {
      const dir = path.join(home, '.claude/projects/-x')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'abc-123.jsonl')
      const line = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z' })
      writeFileSync(file, `${line('Hello')}\n`)
      const t = createTranscripts({ home, herdr: async () => { throw new Error('no Herdr') } })
      const pane = { id: 'w1:p1', agent: 'claude', cwd: '/x', agentSession: 'abc-123' }
      const d = createChatDelta()
      // What server/api/chat.get.ts does, for a request without n.
      const call = async (since: string, from: number | null) => {
        const r = await t.chat(pane, { since: d.sinceOf(pane.id, since, null), from })
        if (r.unchanged || !r.items) return { ...r, token: since }
        return { ...r, ...d.reply(pane.id, r.token!, r.items, since, null, from !== null && r.start === from) }
      }
      const load = await call('', null)
      expect(load.items!.length).toBe(1)
      expect(splitToken(load.token!).fp).toBeNull()
      const poll = await call(load.token!, load.start!) // the old app then re-reads from its start
      expect(poll.items!.length).toBe(1)
      expect((await call(poll.token!, load.start!)).unchanged).toBe(true)
      expect((await call(poll.token!, load.start!)).unchanged).toBe(true)
      appendFileSync(file, `${line('Again')}\n`)
      const grown = await call(poll.token!, load.start!)
      expect(grown.keep).toBeUndefined()
      expect(grown.items!.length).toBe(2)
      expect(d.size()).toBe(0)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('createTailLoader', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
  }

  it('keeps the lock through re-runs: a polling tick starts no second request', async () => {
    const requests: { done: ReturnType<typeof deferred<string>> }[] = []
    let shown = ''
    const loader = createTailLoader(async (current) => {
      const done = deferred<string>()
      requests.push({ done })
      const reply = await done.promise
      if (!current()) return false
      if (reply === 'reset') return true // run again at once, lock held
      shown = reply
      return false
    })
    const first = loader.load()
    expect(requests.length).toBe(1)
    requests[0]!.done.resolve('reset')
    await new Promise(r => setTimeout(r, 0))
    expect(requests.length).toBe(2) // the re-run
    void loader.load() // polling ticks during the re-run
    void loader.load()
    expect(requests.length).toBe(2)
    requests[1]!.done.resolve('NEWER')
    await first
    expect(shown).toBe('NEWER')
    void loader.load() // free again afterwards
    expect(requests.length).toBe(3)
    requests[2]!.done.resolve('LATEST')
    await new Promise(r => setTimeout(r, 0))
    expect(shown).toBe('LATEST')
  })

  it('drops a reply that comes back after a newer one (resolved in reverse order)', async () => {
    const requests: ReturnType<typeof deferred<string>>[] = []
    let shown = ''
    const loader = createTailLoader(async (current) => {
      const done = deferred<string>()
      requests.push(done)
      const reply = await done.promise
      if (current()) shown = reply
      return false
    })
    const older = loader.load()
    loader.invalidate() // another pane: a new load may start at once
    const newer = loader.load()
    expect(requests.length).toBe(2)
    requests[1]!.resolve('NEWER')
    await newer
    requests[0]!.resolve('OLDER')
    await older
    expect(shown).toBe('NEWER')
    // The old load ending did not release the new generation's lock early.
    const again = loader.load()
    expect(requests.length).toBe(3)
    void loader.load()
    expect(requests.length).toBe(3)
    requests[2]!.resolve('LATEST')
    await again
    expect(shown).toBe('LATEST')
  })

  it('stops re-running after a few steps', async () => {
    let steps = 0
    const loader = createTailLoader(async () => { steps++; return true }, 3)
    await loader.load()
    expect(steps).toBe(3)
  })
})
