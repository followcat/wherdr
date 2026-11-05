// Stop pressed before any reply: Claude Code puts the prompt back into its
// field. wherdr takes it back (out of the conversation, into its own field) and
// empties Claude's field so that sending it again does not type it twice.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/types'
import { boxHolds, takeBackInterrupted, unansweredLast, withoutTakenBack } from '../server/utils/interruptRestore'
import { inputBox } from '../server/utils/unqueue'
import { parseClaude } from '../server/utils/transcripts'
import { restoreDraft } from '../app/utils/queuedCancel'
import type { DraftAtt } from '../app/composables/useDraft'

const fixture = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')
const RESTORED = fixture('claude-interrupt-restored.ansi')
const MSG = 'fictional early stop two: think carefully then write a long poem about tides'
// Claude's screen with this text in its field (as read in ANSI: "❯" + non-breaking space).
const screenWith = (box: string) => [
  '✻ Cogitated for 1s',
  '─'.repeat(40),
  box ? `❯ ${box.split('\n').join('\n  ')}` : '❯ ',
  '─'.repeat(40),
  '',
  '  ⏸ manual mode on',
].join('\n')

describe('boxHolds', () => {
  it('reads the prompt Claude put back (real screen, Claude Code 2.1.287)', () => {
    expect(inputBox(RESTORED)).toBe(MSG)
    expect(boxHolds(inputBox(RESTORED), MSG)).toBe(true)
  })
  it('matches a field wrapped over several lines, even mid-word', () => {
    expect(boxHolds('fictional early stop two: think care\nfully then write a long poem about tides', MSG)).toBe(true)
  })
  it('matches a long paste shown as a placeholder', () => {
    const long = `intro line\n${'a fictional line\n'.repeat(30)}end`
    expect(boxHolds('[Pasted text #1 +31 lines]', long)).toBe(true)
    expect(boxHolds('intro line[Pasted text #1 +30 lines]', long)).toBe(true)
    expect(boxHolds('[Pasted text #1 +3 lines]', 'short one')).toBe(false)
  })
  it('refuses anything else: other text, our text plus more, empty', () => {
    expect(boxHolds('something the user typed', MSG)).toBe(false)
    expect(boxHolds(`${MSG} and more`, MSG)).toBe(false)
    expect(boxHolds('', MSG)).toBe(false)
  })
})

describe('unansweredLast', () => {
  it('is the last user message when no reply follows it', () => {
    const u: ChatItem = { role: 'user', text: 'b', ts: '2' }
    expect(unansweredLast([{ role: 'assistant', text: 'a' }, u, { role: 'system', text: 'Interrupted' }])).toBe(u)
  })
  it('is null once the agent replied or used a tool', () => {
    expect(unansweredLast([{ role: 'user', text: 'b' }, { role: 'assistant', text: 'ok' }])).toBeNull()
    expect(unansweredLast([{ role: 'user', text: 'b' }, { role: 'tool', text: 'Read x' }])).toBeNull()
  })
})

// Fake pane: the screen shows `box` until the keys erase it.
function pane(box: string, items: ChatItem[]) {
  const keys: string[][] = []
  let field = box
  return {
    keys,
    deps: {
      screen: async () => screenWith(field),
      keys: async (k: string[]) => { keys.push(k); if (k.includes('ctrl+u')) field = '' },
      chat: async () => items,
      sleep: async () => {},
    },
  }
}

describe('takeBackInterrupted', () => {
  const said: ChatItem = { role: 'user', text: MSG, ts: '2026-01-01T00:00:01.000Z' }
  it('prompt back in Claude’s field: emptied once, message returned', async () => {
    const p = pane(MSG, [{ role: 'assistant', text: 'earlier' }, said])
    expect(await takeBackInterrupted(p.deps)).toBe(said)
    expect(p.keys).toHaveLength(1)
    expect(p.keys[0]!.slice(0, 2)).toEqual(['ctrl+u', 'backspace'])
  })
  it('field already empty (Stop during the reply): nothing pressed', async () => {
    const p = pane('', [said])
    expect(await takeBackInterrupted(p.deps)).toBeNull()
    expect(p.keys).toEqual([])
  })
  it('field holding other text: left alone', async () => {
    const p = pane('the user is typing here', [said])
    expect(await takeBackInterrupted(p.deps)).toBeNull()
    expect(p.keys).toEqual([])
  })
  it('message already answered: left alone', async () => {
    const p = pane(MSG, [said, { role: 'assistant', text: 'partial reply' }])
    expect(await takeBackInterrupted(p.deps)).toBeNull()
    expect(p.keys).toEqual([])
  })
  it('field that will not empty: nothing returned (no double message)', async () => {
    const p = pane(MSG, [said])
    p.deps.keys = async (k: string[]) => { p.keys.push(k) }
    expect(await takeBackInterrupted(p.deps)).toBeNull()
    expect(p.keys).toHaveLength(2)
  })
  it('"!" command put back in bash mode (real screen, Claude Code 2.1.294): found among wherdr’s pending messages', async () => {
    const keys: string[][] = []
    let screen = fixture('claude-bash-restored.ansi')
    expect(inputBox(screen)).toBe('! sleep 30')
    const deps = {
      // Ctrl+U leaves bash mode empty: the field reads "!".
      screen: async () => screen,
      keys: async (k: string[]) => { keys.push(k); screen = screen.replace(' sleep 30', '') },
      // Claude Code writes no user message for a "!" command.
      chat: async () => [] as ChatItem[],
      sleep: async () => {},
      pending: () => ['an earlier fictional message', '! sleep 30'],
    }
    expect(await takeBackInterrupted(deps)).toEqual({ role: 'user', text: '! sleep 30', ts: null })
    expect(keys).toHaveLength(1)
  })
  it('field holding a pending message only in part: left alone', async () => {
    const p = pane('! sleep 30 && echo done', [])
    expect(await takeBackInterrupted({ ...p.deps, pending: () => ['! sleep 30'] })).toBeNull()
    expect(p.keys).toEqual([])
  })
})

// Transcript as written by Claude Code 2.1.287 (fictional text): the cancelled
// message stays, the next one is written as its sibling.
const line = (o: Record<string, unknown>) => JSON.stringify(o)
const user = (uuid: string, parent: string | null, text: string, ts: string) => line({ type: 'user', uuid, parentUuid: parent, timestamp: ts, message: { role: 'user', content: text } })
const reply = (uuid: string, parent: string, text: string, ts: string) => line({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const attach = (uuid: string, parent: string) => line({ type: 'attachment', uuid, parentUuid: parent, attachment: { type: 'total_tokens_reminder' } })
const base = [
  user('u1', null, 'first fictional question', '2026-01-01T00:00:00.000Z'),
  reply('a1', 'u1', 'first answer', '2026-01-01T00:00:01.000Z'),
  user('x', 'a1', 'cancelled fictional prompt', '2026-01-01T00:00:02.000Z'),
  attach('x1', 'x'),
]
const texts = (lines: string[]) => parseClaude(lines).map(i => `${i.role}:${i.text}`)

describe('parseClaude: prompt cancelled by Stop', () => {
  it('drops it once the next message is written as its sibling', () => {
    expect(texts([...base, user('y', 'a1', 'fictional resend', '2026-01-01T00:00:09.000Z'), reply('a2', 'y', 'ok', '2026-01-01T00:00:10.000Z')]))
      .toEqual(['user:first fictional question', 'assistant:first answer', 'user:fictional resend', 'assistant:ok'])
  })
  it('keeps it while it is the last message (wherdr hides it itself, see takeBack)', () => {
    expect(texts(base)).toContain('user:cancelled fictional prompt')
  })
  it('keeps a message that was answered, and an ordinary follow-up', () => {
    expect(texts([...base, reply('a2', 'x1', 'answer', '2026-01-01T00:00:03.000Z'), user('y', 'a2', 'next', '2026-01-01T00:00:04.000Z')]))
      .toEqual(['user:first fictional question', 'assistant:first answer', 'user:cancelled fictional prompt', 'assistant:answer', 'user:next'])
  })
})

describe('withoutTakenBack', () => {
  it('hides only the message taken back (same text, same time)', () => {
    const items: ChatItem[] = [
      { role: 'user', text: 'same', ts: '1' },
      { role: 'user', text: 'same', ts: '2' },
      { role: 'assistant', text: 'same', ts: '2' },
    ]
    expect(withoutTakenBack(items, [{ text: 'same', ts: '2' }])).toEqual([items[0], items[2]])
    expect(withoutTakenBack(items, [])).toBe(items)
  })
})

describe('taken back with an attached file', () => {
  const FILE = '/home/user/.cache/herdr-web/files/2026-01-01T00-00-00-000Z-abc123-notes.md'
  const msg = `fictional question about the notes\n@${FILE}`
  it('matches Claude’s field holding the text and the file line, then restores the file chip', async () => {
    const p = pane(msg, [{ role: 'user', text: msg, ts: '1' }])
    const item = await takeBackInterrupted(p.deps)
    expect(item?.text).toBe(msg)
    const draft = { text: '', atts: [] as DraftAtt[], reply: null }
    restoreDraft(draft, item!.text)
    expect(draft.text).toBe('fictional question about the notes')
    expect(draft.atts).toHaveLength(1)
    expect(draft.atts[0]).toMatchObject({ path: FILE, name: '2026-01-01T00-00-00-000Z-abc123-notes.md', ref: `@${FILE}` })
  })
})

// Claude Code 2.1.317, Esc while a tool runs with a message queued (real shape):
// the queued prompt is written first, then the result of the cancelled tool call,
// both children of the same assistant line.
describe('parseClaude: queued message run after an interrupt', () => {
  const asked = [
    user('u1', null, 'run a slow command', '2026-01-01T00:00:00.000Z'),
    line({ type: 'assistant', uuid: 't1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 20' } }] } }),
  ]
  const queued = line({ type: 'user', uuid: 'q', parentUuid: 't1', promptSource: 'queued', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user', content: 'fictional queued message' } })
  const cancelled = line({ type: 'user', uuid: 'r', parentUuid: 't1', timestamp: '2026-01-01T00:00:05.100Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'The user doesn\'t want to proceed', is_error: true }] } })
  const answer = reply('a2', 'r', 'queued answer', '2026-01-01T00:00:07.000Z')
  it('keeps the bubble of the queued message, before the answer', () => {
    const t = texts([...asked, queued, cancelled, answer])
    expect(t).toContain('user:fictional queued message')
    expect(t.indexOf('user:fictional queued message')).toBeLessThan(t.indexOf('assistant:queued answer'))
  })
  it('keeps it even when its sibling is a new typed prompt (queued prompts are never put back)', () => {
    expect(texts([...asked, queued, user('y', 't1', 'another', '2026-01-01T00:00:06.000Z')])).toContain('user:fictional queued message')
  })
  it('a cancelled tool result alone does not drop a typed prompt', () => {
    expect(texts([...asked, user('x', 't1', 'typed prompt', '2026-01-01T00:00:05.000Z'), cancelled, answer])).toContain('user:typed prompt')
  })
})
