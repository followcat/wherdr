// Fewer transcript reads (server/utils/transcripts.ts): several devices on one
// pane share a read in progress, and card previews read the end of a long
// transcript first.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { type MachineFs, localFs } from '../server/utils/fsx'

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })
const noHerdr = async () => { throw new Error('no Herdr') }
let n = 0
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString()
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: at() })
const reply = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, timestamp: at() })
const pane = { id: 'w1:p1', agent: 'claude', cwd: '/x', agentSession: 'abc-123' }

// A transcript, and a file system that counts the bytes read from it.
function setup(lines: string[], now?: () => number) {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-reads-'))
  homes.push(home)
  const dir = path.join(home, '.claude/projects/-x')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'abc-123.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  const reads: number[] = []
  const fs: MachineFs = { ...localFs, read: async (p, start, len) => {
    const b = await localFs.read(p, start, len)
    if (p === file) reads.push(b.length)
    return b
  } }
  const t = createTranscripts({ home, herdr: noHerdr, fs, ...(now ? { now } : {}) })
  return { file, t, reads }
}

describe('shared transcript reads', () => {
  it('requests on the same pane and state read the file once', async () => {
    const { t, reads } = setup([user('Hello'), reply('Hi there')])
    const replies = await Promise.all([t.chat(pane), t.chat(pane), t.chat(pane)])
    for (const r of replies) expect(r.items!.map(i => i.text)).toEqual(['Hello', 'Hi there'])
    expect(reads.length).toBe(1)
  })

  it('a new state is read again', async () => {
    const { file, t, reads } = setup([user('Hello'), reply('Hi there')])
    await Promise.all([t.chat(pane), t.chat(pane)])
    appendFileSync(file, `${reply('More')}\n`)
    const [a, b] = await Promise.all([t.chat(pane), t.chat(pane)])
    expect(a.items!.at(-1)!.text).toBe('More')
    expect(b.items!.at(-1)!.text).toBe('More')
    expect(reads.length).toBe(2)
  })
})

describe('card preview of a long transcript', () => {
  const pad = 'x'.repeat(2000)
  const long = (k: number) => Array.from({ length: k }, (_, i) => user(`Question ${i} ${pad}`))

  it('reads only the last 256 KB when the reply is there', async () => {
    const { t, reads } = setup([...long(1000), reply('**Done**, all tests pass.')])
    expect((await t.latestReply(pane))?.text).toBe('Done, all tests pass.')
    expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024 + 1)
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(256 * 1024 + 1)
  })

  it('same reply and identity as the whole bottom gives', async () => {
    const { t } = setup([...long(1000), reply('Final answer'), user('Thanks')])
    const short = await t.latestReply(pane)
    const r = await t.chat(pane)
    const last = r.items!.filter(i => i.role === 'assistant').at(-1)!
    expect(last.text).toBe('Final answer')
    expect(short?.text).toBe('Final answer')
    expect(short?.key).toMatch(/:\d+:/)
  })

  it('widens to the bottom of the conversation when the tail holds no reply', async () => {
    // 100 long questions (400 KB) after the reply: within the bottom page.
    const { t, reads } = setup([reply('Older reply'), ...Array.from({ length: 100 }, (_, i) => user(`Question ${i} ${pad}${pad}`))])
    expect((await t.latestReply(pane))?.text).toBe('Older reply')
    expect(Math.max(...reads)).toBeGreaterThan(256 * 1024 + 1)
  })

  it('an unchanged settled transcript is not read again', async () => {
    let clock = Date.now()
    const { t, reads } = setup([...long(1000), reply('Done')], () => clock)
    // Whole-second mtimes count as settled after SETTLE_MS, sub-second ones at once.
    await t.latestReply(pane)
    clock += 60_000
    await t.latestReply(pane)
    const before = reads.length
    expect((await t.latestReply(pane))?.text).toBe('Done')
    expect((await t.latestReply(pane))?.text).toBe('Done')
    expect(reads.length).toBe(before)
  })
})

// While an agent writes, a poll from a cursor reads only the bytes appended
// since the last one (readBelow): same reply as a whole new read, every time.
describe('bottom read from a cursor while the transcript grows', () => {
  const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name))
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
  const image = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }, timestamp: at() })
  const claude = Buffer.concat([fixture('claude-session.jsonl'), fixture('claude-queue.jsonl'), Buffer.from(`${image('A photo')}\n`), fixture('claude-bash.jsonl')])
  const codexId = '00000000-0000-4000-8000-00000000c0de'
  const codexPane = { id: 'w1:p2', agent: 'codex', cwd: '/home/user/dev/sandbox', agentSession: codexId }

  // An empty transcript of `kind`, a cached reader counting its bytes, and a
  // reader without any cache to compare with.
  function grow(kind: 'claude' | 'codex' | 'omp') {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-grow-'))
    homes.push(home)
    const dir = path.join(home, { claude: '.claude/projects/-x', codex: '.codex/sessions/2026/09/25', omp: '.omp/agent/sessions/-x' }[kind])
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, { claude: 'abc-123.jsonl', codex: `rollout-2026-09-25T11-29-56-${codexId}.jsonl`, omp: '2026-01-01T00-00-00-000Z_s1.jsonl' }[kind])
    writeFileSync(file, '')
    let bytes = 0
    const fs: MachineFs = { ...localFs, read: async (p, start, len) => {
      const b = await localFs.read(p, start, len)
      if (p === file) bytes += b.length
      return b
    } }
    const t = createTranscripts({ home, herdr: noHerdr, fs })
    const p = kind === 'claude' ? pane : kind === 'codex' ? codexPane : { id: 'w1:p3', agent: 'omp', cwd: '/x', agentSession: file }
    const poll = async (from: number) => {
      bytes = 0
      const r = await t.chat(p, { from })
      return { r, bytes }
    }
    const fresh = (from: number) => createTranscripts({ home, herdr: noHerdr }).chat(p, { from })
    return { file, poll, fresh }
  }
  // Appends `data` in uneven chunks (lines split across polls), polling after each.
  async function feed(g: ReturnType<typeof grow>, data: Buffer, from: number, check?: (appended: number, bytes: number) => void) {
    let at = 0
    for (let k = 0; at < data.length; k++) {
      const n = Math.min(data.length - at, [37, 211, 5, 640, 90][k % 5]!)
      appendFileSync(g.file, data.subarray(at, at + n))
      at += n
      const { r, bytes } = await g.poll(from)
      expect(r).toEqual(await g.fresh(from))
      check?.(n, bytes)
    }
  }

  it('Claude: same items, queue and token as a whole read, reading only what was appended', async () => {
    const g = grow('claude')
    // What was appended, the 4 KB checked above it (up to 4 KB more when one
    // read also takes the cursor's anchor), and a line not ended yet read again.
    const longest = Math.max(...claude.toString('utf8').split('\n').map(l => Buffer.byteLength(l) + 1))
    await feed(g, claude, 0, (appended, bytes) => expect(bytes).toBeLessThanOrEqual(appended + 2 * 4096 + longest))
    const { r } = await g.poll(0)
    expect(r.items!.some(i => i.role === 'tool' && i.error)).toBe(true) // a result marking its earlier call
    expect(r.items!.find(i => i.text === 'A photo')!.hashes).toHaveLength(1)
  })

  it('Claude: from a cursor at a line start and in the middle of a line', async () => {
    for (const from of [claude.indexOf(0x0a, 3000) + 1, 3000]) {
      const g = grow('claude')
      appendFileSync(g.file, claude.subarray(0, from + 50))
      await feed(g, claude.subarray(from + 50), from)
    }
  })

  it('Codex: same reply as a whole read', async () => {
    const g = grow('codex')
    await feed(g, fixture('codex-rollout.jsonl'), 0)
    expect((await g.poll(0)).r.items!.length).toBeGreaterThan(0)
  })

  // omp: turns with tool calls, results and a failed attempt it marks later.
  const om = (message: object) => JSON.stringify({ type: 'message', id: at(), timestamp: at(), message })
  const ompTurn = (k: number) => [om({ role: 'user', content: [{ type: 'text', text: `Question ${k}` }], attribution: 'user' }),
    om({ role: 'assistant', content: [{ type: 'text', text: `Answer ${k} ${'x'.repeat(3000)}` }, { type: 'toolCall', id: `t${k}`, name: 'bash', arguments: { command: 'ls' } }] }),
    om({ role: 'toolResult', toolCallId: `t${k}`, isError: k % 2 === 1, content: [{ type: 'text', text: 'ok' }] })].join('\n') + '\n'
  const omp = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: at(), cwd: '/x' }) + '\n' + Array.from({ length: 6 }, (_, k) => ompTurn(k)).join(''))

  it('omp: same reply as a whole read, and a line rewritten far above the end is seen', async () => {
    const g = grow('omp')
    await feed(g, omp, 0)
    const r = (await g.poll(0)).r
    expect(r.items!.filter(i => i.role === 'tool' && i.error)).toHaveLength(3) // results marking their calls
    // omp marks an early failed attempt as retried: same size class, rewritten in the middle.
    const text = omp.toString('utf8').replace('"Question 1"', '"Question!1"')
    writeFileSync(g.file, text)
    const again = (await g.poll(0)).r
    expect(again).toEqual(await g.fresh(0))
    expect(again.items!.some(i => i.text === 'Question!1')).toBe(true)
  })

  it('Codex and omp: the turns before the last one are not parsed again, Claude reuses unchanged items', async () => {
    for (const [kind, data] of [['omp', omp], ['codex', fixture('codex-rollout.jsonl')], ['claude', claude]] as const) {
      const g = grow(kind)
      appendFileSync(g.file, data)
      const first = (await g.poll(0)).r.items!
      appendFileSync(g.file, kind === 'omp' ? ompTurn(9) : kind === 'codex'
        ? `${JSON.stringify({ timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next' }] } })}\n`
        : `${user('Next')}\n`)
      const next = (await g.poll(0)).r.items!
      expect(next.length).toBeGreaterThan(first.length)
      // Same objects for every item of the earlier turns (all but the last turn).
      const lastStart = first.findLastIndex(i => i.role === 'user')
      for (let k = 0; k < (kind === 'claude' ? first.length : lastStart); k++) expect(next[k]).toBe(first[k])
    }
  })

  it('a transcript cut, replaced or rewritten is read again', async () => {
    const g = grow('claude')
    await feed(g, claude, 0)
    // Cut, then longer than before with other lines.
    writeFileSync(g.file, claude.subarray(0, claude.indexOf(0x0a, 2000) + 1))
    expect((await g.poll(0)).r).toEqual(await g.fresh(0))
    appendFileSync(g.file, `${user('Another question')}\n${claude.toString('utf8')}`)
    expect((await g.poll(0)).r).toEqual(await g.fresh(0))
    // Replaced by another file (another inode), then rewritten just above its end.
    const other = `${g.file}.new`
    writeFileSync(other, `${user('New file')}\n${reply('Fresh')}\n`)
    renameSync(other, g.file)
    expect((await g.poll(0)).r).toEqual(await g.fresh(0))
    writeFileSync(g.file, `${user('New file')}\n${reply('Fresh!')}\n${reply('More')}\n`)
    const r = (await g.poll(0)).r
    expect(r).toEqual(await g.fresh(0))
    expect(r.items!.map(i => i.text)).toEqual(['New file', 'Fresh!', 'More'])
  })
})
