// Devin's sessions.db holds one node per message, written in real time — the
// ATIF transcript only lands when a turn ends. The store reader walks the
// session's main chain plus the chains compaction abandoned (stitched back
// through their summarized_from marks), keeps ATIF as the fallback, and
// answers quiet polls from file stats or a per-session signature instead of
// spawning python each time.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { createDevinStore } from '../server/utils/devinStore'
import { createDevinTranscripts } from '../server/utils/devinTranscripts'
import { type MachineFs, type ShellExec, localFs } from '../server/utils/fsx'
import { landed } from '../server/utils/queued'
import { devinMessage, writeDevinFixture } from './helpers/devin-fixture.mjs'
import { writeDevinStore } from './helpers/devin-store-fixture.mjs'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-devin-store-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const pane = { id: 'p1', agent: 'devin', cwd: '/projects/demo', agentSession: 'devin-test' }
const stamp = (ms: number) => new Date(ms).toISOString()

it('reads the current main chain and ignores sibling branches and other sessions', async () => {
  const { home, reader } = fixture()
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('system', 'Private instructions') },
    { id: 1, parent: 0, message: devinMessage('user', 'Review the example') },
    { id: 2, parent: 1, message: devinMessage('assistant', 'Abandoned reply') },
    { id: 3, parent: 1, message: devinMessage('assistant', '**Current reply**') },
  ], head: 3 })
  writeDevinStore(home, { session: 'another-session', rows: [{ id: 0, message: devinMessage('user', 'Other conversation') }] })
  const response = await reader.chat(pane)
  expect(response.available).toBe(true)
  expect(response.session).toBe('devin-test')
  expect(response.token).toMatch(/^devins:/)
  expect(response.items?.map(i => [i.role, i.text])).toEqual([['user', 'Review the example'], ['assistant', '**Current reply**']])
})

it('stitches compacted history back in behind a seam notice, without duplicating the shared prefix', async () => {
  const { home, reader } = fixture()
  const summary = 'You are continuing work from a previous conversation thread. Below is a summary of the previous conversation. ' + 'Long summary. '.repeat(100)
  writeDevinStore(home, { rows: [
    // Shared system prefix, on both chains (nodes 0-2).
    { id: 0, message: devinMessage('system', 'Prefix one'), meta: { is_system_prefix: true } },
    { id: 1, parent: 0, message: devinMessage('system', 'Prefix two'), meta: { is_system_prefix: true } },
    { id: 2, parent: 1, message: devinMessage('system', 'Prefix three'), meta: { is_system_prefix: true } },
    // Oldest conversation (abandoned by a first compaction).
    { id: 3, parent: 2, message: devinMessage('user', 'First question') },
    { id: 4, parent: 3, message: devinMessage('assistant', 'First answer') },
    // First compaction: node 5 is the summary graft, pointing at node 4.
    { id: 5, parent: 2, message: devinMessage('system', 'Earlier summary. ' + 'x'.repeat(30)), meta: { summarized_from: 4 } },
    // Middle conversation.
    { id: 6, parent: 5, message: devinMessage('user', 'Middle question') },
    { id: 7, parent: 6, message: devinMessage('assistant', 'Middle answer') },
    // Second compaction: node 10 grafts a new summary, pointing at node 7.
    { id: 10, parent: 2, message: devinMessage('system', summary), meta: { summarized_from: 7 } },
    { id: 11, parent: 10, message: devinMessage('user', 'Latest question') },
    { id: 12, parent: 11, message: devinMessage('assistant', 'Latest answer') },
  ], head: 12 })
  const r = await reader.chat(pane)
  expect(r.available).toBe(true)
  const flat = r.items!.map(i => [i.role, i.name || i.text.slice(0, 40)])
  expect(flat).toEqual([
    ['user', 'First question'],
    ['assistant', 'First answer'],
    ['notice', 'compaction'],
    ['user', 'Middle question'],
    ['assistant', 'Middle answer'],
    ['notice', 'compaction'],
    ['user', 'Latest question'],
    ['assistant', 'Latest answer'],
  ])
  // No system prompt ever shows, and the shared prefix is not repeated.
  expect(JSON.stringify(r.items)).not.toContain('Prefix one')
  // The seam carries the summary text (folded in the view), at the graft's ts.
  const seams = r.items!.filter(i => i.role === 'notice')
  expect(seams[0]!.text).toContain('Earlier summary')
  expect(seams[1]!.text).toContain('You are continuing work')
  expect(seams[1]!.ref).toBe('10:s')
})

it('pairs tool output to its call by tool_call_id and marks failures', async () => {
  const { home, reader } = fixture()
  const call = { id: 'call-1', name: 'exec', arguments: { command: 'npm test' }, kind: 'function' }
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', 'Run the tests') },
    { id: 1, parent: 0, message: devinMessage('assistant', '', { tool_calls: [call] }) },
    { id: 2, parent: 1, message: devinMessage('tool', '1 failed, 3 passed', { tool_call_id: call.id, metadata: { extensions: { 'chisel/tool_result_meta': { success: false, exit_code: 1 } } } }) },
    { id: 3, parent: 2, message: devinMessage('assistant', 'One test is red') },
    // A result on a sibling branch must not complete the current call.
    { id: 4, parent: 1, message: devinMessage('tool', 'Sibling output', { tool_call_id: 'other-call' }) },
  ], head: 3 })
  const r = await reader.chat(pane)
  const tool = r.items!.find(i => i.role === 'tool')
  expect(tool).toMatchObject({ role: 'tool', name: 'exec', text: 'npm test', out: '1 failed, 3 passed', error: true })
  expect(JSON.stringify(r.items)).not.toContain('Sibling output')
})

it('shows thinking and prefers the newest generation_model over the session model', async () => {
  const { home, reader } = fixture()
  writeDevinStore(home, { model: 'old-model', rows: [
    { id: 0, message: devinMessage('user', 'Question') },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Answer', { thinking: { thinking: 'Reasoning summary', signature: 'INTERNAL_SIGNATURE' }, metadata: { generation_model: 'swe-2-max', created_at: '2026-01-01T12:00:00Z' } }) },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.map(i => [i.role, i.text])).toEqual([['user', 'Question'], ['thinking', 'Reasoning summary'], ['assistant', 'Answer']])
  expect(JSON.stringify(r)).not.toContain('INTERNAL_SIGNATURE')
  expect(await reader.model(pane)).toEqual({ id: 'swe-2-max', label: 'Swe 2 max' })
})

function countingSpawn() {
  let calls = 0
  const counter: typeof spawn = ((...args: Parameters<typeof spawn>) => { calls++; return spawn(...args) }) as typeof spawn
  return { counter, calls: () => calls }
}

it('answers an unchanged poll from the db and wal stats without spawning python', async () => {
  const { home } = fixture()
  writeDevinStore(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Stable reply') }] })
  const { counter, calls } = countingSpawn()
  const store = createDevinStore({ home, spawnProcess: counter })
  const first = await store.chat(pane)
  expect(first.items?.[0]?.text).toBe('Stable reply')
  // A read-only open creates the -wal/-shm files once — the second poll sees
  // the moved file set, confirms the session signature and re-sends nothing.
  const again = await store.chat(pane, { from: first.start as number, since: first.token })
  expect(again).toMatchObject({ unchanged: true })
  const settled = calls()
  const third = await store.chat(pane, { from: first.start as number, since: first.token })
  expect(third).toMatchObject({ unchanged: true })
  expect(calls()).toBe(settled)
})

it('answers a moved db file with the session signature only, then goes quiet again', async () => {
  const { home } = fixture()
  const db = writeDevinStore(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Still stable') }] })
  const { counter, calls } = countingSpawn()
  const store = createDevinStore({ home, spawnProcess: counter })
  const first = await store.chat(pane)
  // The file moved (a WAL checkpoint, another writer): the session itself did
  // not. The query confirms the signature and re-sends nothing.
  utimesSync(db, new Date(Date.now() + 3000), new Date(Date.now() + 3000))
  const again = await store.chat(pane, { from: first.start as number, since: first.token })
  expect(again).toMatchObject({ unchanged: true })
  expect(calls()).toBe(2)
  // The verified signature is remembered: the next quiet poll is free again.
  const third = await store.chat(pane, { from: first.start as number, since: first.token })
  expect(third).toMatchObject({ unchanged: true })
  expect(calls()).toBe(2)
})

it('pages a long stitched chain with from/before and reports a rewrite above the cursor', async () => {
  const { home, reader } = fixture()
  const rows = Array.from({ length: 300 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage(id % 2 ? 'assistant' : 'user', `Message ${id}`) }))
  writeDevinStore(home, { rows })
  const tail = await reader.chat(pane)
  expect(tail.items).toHaveLength(120)
  const middle = await reader.chat(pane, { before: tail.start as number, anchor: tail.token })
  const first = await reader.chat(pane, { before: middle.start as number, anchor: tail.token })
  expect(first.start).toBe(0)
  expect([...first.items!, ...middle.items!, ...tail.items!].map(i => i.text)).toEqual(rows.map(r => r.message.content))
  // Rewind the head to another branch: history above the cursor changed.
  writeDevinStore(home, { rows: [{ id: 400, parent: 0, message: devinMessage('assistant', 'Replacement branch') }], head: 400 })
  const next = await reader.chat(pane, { from: tail.start as number, anchor: tail.token })
  expect(next.rewritten).toBe(true)
  expect(next.items?.map(i => i.text)).toEqual(['Message 0', 'Replacement branch'])
})

it('delivers a compaction landing between polls as a tail re-read, not a rewrite', async () => {
  const { home, reader } = fixture()
  const rows = Array.from({ length: 150 }, (_, id) => ({
    id, parent: id ? id - 1 : null, message: devinMessage(id % 2 ? 'assistant' : 'user', `Message ${id}`),
  }))
  writeDevinStore(home, { rows })
  const tail = await reader.chat(pane)
  expect(tail.start).toBeGreaterThan(0)
  writeDevinStore(home, { rows: [
    { id: 500, parent: 0, message: devinMessage('system', 'New thread preamble') },
    { id: 501, parent: 500, message: devinMessage('system', 'You are continuing work from a previous conversation thread.'), meta: { summarized_from: 149 } },
    { id: 502, parent: 501, message: devinMessage('user', 'New question') },
  ], head: 502 })
  // Node cursors do not move when a compaction grafts new content in front of
  // the head: the tail re-read simply carries the seam and the new message.
  const next = await reader.chat(pane, { from: tail.start as number, anchor: tail.token, since: tail.token })
  expect(next.rewritten).toBeFalsy()
  expect(next.start).toBe(tail.start)
  expect(next.items?.at(-2)).toMatchObject({ role: 'notice', name: 'compaction' })
  expect(next.items?.at(-2)?.text).toContain('previous conversation thread')
  expect(next.items?.at(-1)).toMatchObject({ role: 'user', text: 'New question' })
})

it('stitches every chain through 30 compactions, one notice each, no summarizer branch', async () => {
  const { home, reader } = fixture()
  const rows: { id: number, parent?: number | null, message: ReturnType<typeof devinMessage>, meta?: Record<string, number> }[] = [
    { id: 0, message: devinMessage('system', 'Prefix') },
  ]
  let head = 0, nid = 1
  const expected: (string | [string, string])[] = []
  for (let round = 1; round <= 30; round++) {
    // Four exchanges per round keep the conversation longer than one page.
    for (let q = 1; q <= 4; q++) {
      const u = nid++
      rows.push({ id: u, parent: head, message: devinMessage('user', `Question ${round}.${q}`) })
      const a = nid++
      rows.push({ id: a, parent: u, message: devinMessage('assistant', `Answer ${round}.${q}`) })
      expected.push(`Question ${round}.${q}`, `Answer ${round}.${q}`)
      head = a
    }
    if (round === 30) break
    // What a real compaction writes: the summary system node on the new
    // chain's path (its parent is a prefix node), and the summarizer's
    // assistant off-path, branching off the round's last user node. Both
    // carry the same summarized_from mark.
    const graft = nid++
    rows.push({ id: graft, parent: 0, message: devinMessage('system', `Summary ${round}`), meta: { summarized_from: head } })
    const summarizer = nid++
    rows.push({ id: summarizer, parent: head - 1, message: devinMessage('assistant', `Summarizer notes ${round}`), meta: { summarized_from: head } })
    head = graft
    expected.push(['notice', 'compaction'] as [string, string])
  }
  // A retry sibling stays hidden too.
  rows.push({ id: nid++, parent: 1, message: devinMessage('assistant', 'Discarded retry') })
  writeDevinStore(home, { rows, head })
  const tail = await reader.chat(pane)
  expect(tail.available).toBe(true)
  const all = [...tail.items!]
  let before = tail.start as number
  while (before) {
    const older = await reader.chat(pane, { before, anchor: tail.token })
    if (!older.items?.length) break
    all.unshift(...older.items)
    if (older.start === before) break
    before = older.start as number
  }
  expect(all.map(i => (i.role === 'notice' ? [i.role, i.name] : i.text))).toEqual(expected)
  const text = JSON.stringify(all)
  expect(text).not.toContain('Summarizer')
  expect(text).not.toContain('Discarded retry')
})

it('reads a 20,000-node session a bounded walk at a time', async () => {
  const { home, reader } = fixture()
  const total = 20000
  const rows = Array.from({ length: total }, (_, id) => ({
    id, parent: id ? id - 1 : null, message: devinMessage(id % 2 ? 'assistant' : 'user', `Message ${id}`),
  }))
  writeDevinStore(home, { rows })
  const tail = await reader.chat(pane)
  expect(tail.items).toHaveLength(120)
  expect(tail.items?.at(-1)?.text).toBe(`Message ${total - 1}`)
  // A bottom page only walks back what it needs.
  expect(tail.visited).toBeLessThanOrEqual(300)
  const older = await reader.chat(pane, { before: tail.start as number, anchor: tail.token })
  expect(older.items?.map(i => i.text)).toEqual(rows.slice(total - 240, total - 120).map(r => r.message.content))
  expect(older.visited).toBeLessThanOrEqual(300)
}, 30_000)

it('falls back to the ATIF transcript when the store schema version is unknown', async () => {
  const { home, reader } = fixture()
  writeDevinStore(home, { schemaVersion: 99, rows: [{ id: 0, message: devinMessage('assistant', 'From the store') }] })
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'From ATIF') }] })
  const r = await reader.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['From ATIF'])
})

it('falls back to the ATIF transcript when the database is missing or the session is absent', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'ATIF only') }] })
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('ATIF only')
  // The store exists but does not know this session: still ATIF.
  writeDevinStore(home, { session: 'someone-else', rows: [{ id: 0, message: devinMessage('assistant', 'Not ours') }] })
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('ATIF only')
})

it('a source switch resets the view instead of mixing cursors', async () => {
  const { home, reader } = fixture()
  const db = writeDevinStore(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Store history') }] })
  const first = await reader.chat(pane)
  expect(first.token).toMatch(/^devins:/)
  rmSync(db)
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'ATIF history') }] })
  const next = await reader.chat(pane, { from: first.start as number, since: first.token, anchor: first.token })
  expect(next.rewritten).toBe(true)
  expect(next.items?.map(i => i.text)).toEqual(['ATIF history'])
})

it('reads the store over a shell channel (SSH) with the same script', async () => {
  const { home } = fixture()
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', 'Remote question') },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Remote answer') },
  ] })
  // The remote channel: the script and its arguments run on the machine
  // owning the store. Here the "remote" shell is the same python3.
  const execs: string[] = []
  const exec: ShellExec = async (script, args = []) => {
    execs.push(script)
    const r = await new Promise<{ code: number | null, stdout: Buffer, stderr: string }>((resolve) => {
      const child = spawn('python3', ['-X', 'utf8', '-c', args[0]!, args[1]!, args[2]!])
      const out: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', b => out.push(b))
      child.stderr.on('data', b => { stderr += b })
      child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr }))
    })
    return r
  }
  const fs: MachineFs = { ...localFs }
  const remote = createDevinStore({ home, fs, exec })
  const r = await remote.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['Remote question', 'Remote answer'])
  expect(execs[0]).toBe('python3 -X utf8 -c "$1" "$2" "$3"')
})

it('confirms a queued message as soon as its user node lands', async () => {
  const { home, reader } = fixture()
  const at = Date.now()
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', 'Ship the fix please', { metadata: { created_at: stamp(at), is_user_input: true } }) },
    { id: 1, parent: 0, message: devinMessage('assistant', 'On it', { metadata: { created_at: stamp(at + 2000) } }) },
  ] })
  const r = await reader.chat(pane)
  expect(landed({ text: 'Ship the fix please', at, typedAt: at }, r.items!, at + 5000, 'devin')).toBe(true)
})

it('keeps an empty store session available instead of reporting not_found', async () => {
  const { home, reader } = fixture()
  writeDevinStore(home, { rows: [], head: null })
  const r = await reader.chat(pane)
  expect(r).toMatchObject({ available: true, items: [], start: 0 })
})

it('answers a poll from ATIF while the store read fails, then returns to a healed store', async () => {
  const { home } = fixture()
  let now = 1_000_000
  const reader = createDevinTranscripts({ home, now: () => now })
  // A graft whose summarized_from names a chain (5 → 4) with a missing
  // ancestor: every store read raises 'Invalid Devin conversation chain'.
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('system', 'Prefix') },
    { id: 5, parent: 4, message: devinMessage('user', 'Orphaned prompt') },
    { id: 6, parent: 0, message: devinMessage('system', 'Summary graft'), meta: { summarized_from: 5 } },
    { id: 7, parent: 6, message: devinMessage('assistant', 'Broken store answer') },
  ], head: 7 })
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'ATIF keeps the session readable') }] })
  // The first poll already falls back: the wrapper marks the pick not-store.
  const first = await reader.chat(pane)
  expect(first.available).toBe(true)
  expect(first.items?.map(i => i.text)).toEqual(['ATIF keeps the session readable'])
  // While the pick retry window runs, ATIF keeps answering without a store retry.
  now += 30 * 1000
  const mid = await reader.chat(pane, { since: first.token })
  expect(mid).toMatchObject({ available: true, unchanged: true })
  // Heal the store by adding the missing ancestor; past the retry window the
  // store is used again, and the source switch is a rewritten reset.
  writeDevinStore(home, { rows: [{ id: 4, message: devinMessage('user', 'Earlier prompt') }], head: 7 })
  now += 40 * 1000
  const healed = await reader.chat(pane, { from: first.start as number, since: first.token, anchor: first.token })
  expect(healed.token).toMatch(/^devins:/)
  expect(healed.rewritten).toBe(true)
  expect(healed.items?.map(i => [i.role, i.name || i.text])).toEqual([
    ['user', 'Earlier prompt'],
    ['user', 'Orphaned prompt'],
    ['notice', 'compaction'],
    ['assistant', 'Broken store answer'],
  ])
})

it('serves the remembered page once on a broken read, then ATIF answers instead of stale', async () => {
  const { home } = fixture()
  let now = 1_000_000
  const reader = createDevinTranscripts({ home, now: () => now })
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', 'Question') },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Store answer') },
  ], head: 1 })
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'ATIF answer') }] })
  const good = await reader.chat(pane)
  expect(good.items?.map(i => i.text)).toEqual(['Question', 'Store answer'])
  // Rewind the head to a chain whose ancestor does not exist.
  writeDevinStore(home, { rows: [{ id: 9, parent: 8, message: devinMessage('assistant', 'Broken') }], head: 9 })
  // One failed attempt may still answer from the remembered page (a blip
  // stays invisible); the ATIF fallback must not be hidden behind it.
  const stale = await reader.chat(pane, { from: good.start as number, since: good.token, anchor: good.token })
  expect(stale).toMatchObject({ available: true, unchanged: true })
  now += 2000
  const fallback = await reader.chat(pane, { from: good.start as number, since: good.token, anchor: good.token })
  expect(fallback.available).toBe(true)
  expect(fallback.rewritten).toBe(true)
  expect(fallback.items?.map(i => i.text)).toEqual(['ATIF answer'])
})

it('marks tool errors from the result meta alone, never the output text', async () => {
  const { home, reader } = fixture()
  const calls = [
    { id: 'call-ok', name: 'exec', arguments: { command: 'make check' } },
    { id: 'call-fail', name: 'exec', arguments: { command: 'make lint' } },
    { id: 'call-plain', name: 'exec', arguments: { command: 'make build' } },
  ]
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', 'Run the checks') },
    { id: 1, parent: 0, message: devinMessage('assistant', '', { tool_calls: calls }) },
    // The output text screams but the meta says success: not an error.
    { id: 2, parent: 1, message: devinMessage('tool', 'Error: 0 problems found\nall clean', { tool_call_id: 'call-ok', metadata: { extensions: { 'chisel/tool_result_meta': { success: true, exit_code: 0 } } } }) },
    { id: 3, parent: 2, message: devinMessage('tool', 'nothing unusual', { tool_call_id: 'call-fail', metadata: { extensions: { 'chisel/tool_result_meta': { success: false } } } }) },
    // No meta at all: the text alone still is not an error.
    { id: 4, parent: 3, message: devinMessage('tool', 'Traceback (most recent call last)', { tool_call_id: 'call-plain' }) },
    { id: 5, parent: 4, message: devinMessage('assistant', 'Done') },
  ], head: 5 })
  const r = await reader.chat(pane)
  const tools = r.items!.filter(i => i.role === 'tool')
  expect(tools.find(i => i.text === 'make check')).toMatchObject({ out: 'Error: 0 problems found\nall clean' })
  expect(tools.find(i => i.text === 'make check')!.error).toBeFalsy()
  expect(tools.find(i => i.text === 'make lint')!.error).toBe(true)
  expect(tools.find(i => i.text === 'make build')!.error).toBeFalsy()
})

it('reads user text when the message content is a list of blocks', async () => {
  const { home, reader } = fixture()
  writeDevinStore(home, { rows: [
    { id: 0, message: devinMessage('user', [{ type: 'text', text: 'First part' }, { type: 'text', text: 'Second part' }]) },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Understood') },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.[0]).toMatchObject({ role: 'user', text: 'First part\n\nSecond part' })
})
