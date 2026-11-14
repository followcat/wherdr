// A prompt Claude Code injects itself (scheduled task, task notification) is
// never a message the user queued: shown where it ran as a note, no "Queued"
// bubble left under the conversation; a message the user typed stays queued.
import { describe, expect, it } from 'vitest'
import { parseLines } from '../server/utils/transcripts'
import { pendingQueue } from '../app/utils/pendingQueue'

const line = (o: object) => JSON.stringify(o)
const enqueue = (content: string, timestamp: string) => line({ type: 'queue-operation', operation: 'enqueue', content, timestamp })
const queued = (prompt: string, timestamp: string, kind: string) => line({ type: 'attachment', timestamp, attachment: { type: 'queued_command', commandMode: 'prompt', prompt, origin: { kind } } })
const reply = (text: string, timestamp: string) => line({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const user = (content: string, timestamp: string) => line({ type: 'user', timestamp, message: { role: 'user', content } })
const parse = (lines: string[]) => parseLines(lines.join('\n'), 'claude', 0, '/home/user')
const pending = (items: ReturnType<typeof parse>, idle = false) =>
  pendingQueue({ mine: [], claude: items.queue || [], items, screen: null, idle })

describe('scheduled prompts', () => {
  it('consumed long after its enqueue, with no fire line nor dequeue: no queued bubble', () => {
    const items = parse([
      user('hello', '2026-01-01T09:59:00.000Z'),
      reply('hi', '2026-01-01T09:59:01.000Z'),
      enqueue('check the deploy', '2026-01-01T10:00:00.000Z'),
      queued('check the deploy', '2026-01-01T10:01:00.000Z', 'scheduled-trigger'),
      reply('Deploy is green.', '2026-01-01T10:01:01.000Z'),
    ])
    expect(items.queue).toEqual([])
    expect(pending(items)).toEqual([])
    // At its place, after the earlier reply and before its own: a note, not a user message.
    expect(items.map(i => [i.role, i.text])).toEqual([
      ['user', 'hello'], ['assistant', 'hi'], ['notice', 'check the deploy'], ['assistant', 'Deploy is green.'],
    ])
    expect(items[2]!.name).toBe('scheduled')
  })

  it('<scheduled-task> envelope and scheduled_task_fire: a note, not a user bubble', () => {
    const items = parse([
      line({ type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task', prompt: 'water the plants', timestamp: '2026-01-01T10:00:00.000Z' }),
      user('water the plants', '2026-01-01T10:00:00.100Z'),
      reply('Done.', '2026-01-01T10:00:01.000Z'),
      user('<scheduled-task name="x">ping the team</scheduled-task>', '2026-01-01T11:00:00.000Z'),
    ])
    expect(items.filter(i => i.role === 'user')).toEqual([])
    expect(items.filter(i => i.role === 'notice').map(i => [i.name, i.text])).toEqual([['scheduled', 'water the plants'], ['scheduled', 'ping the team']])
  })

  it('a task notification leaves the queue without showing', () => {
    const n = '<task-notification>job done</task-notification>'
    const items = parse([enqueue(n, '2026-01-01T10:00:00.000Z'), queued(n, '2026-01-01T10:00:30.000Z', 'task-notification')])
    expect(items.filter(i => i.role !== 'assistant')).toEqual([])
    expect(items.queue).toEqual([])
  })

  it.each([
    ['a string', (n: string) => n],
    ['a text part', (n: string) => [{ type: 'text', text: n }]],
  ])('a task notification between turns, as %s, marks the turn Claude takes by itself', (_, form) => {
    const n = '<task-notification>\n<summary>Background command finished</summary>\n</task-notification>'
    const items = parse([
      user('hello', '2026-01-01T09:59:00.000Z'),
      reply('hi', '2026-01-01T09:59:01.000Z'),
      line({ type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: form(n) } }),
      reply('The fix is live.', '2026-01-01T10:00:01.000Z'),
    ])
    expect(items.map(i => [i.role, i.text, !!i.own])).toEqual([['user', 'hello', false], ['assistant', 'hi', false], ['assistant', 'The fix is live.', true]])
  })
})

describe('a message the user typed stays queued', () => {
  const items = parse([
    user('start', '2026-01-01T10:00:00.000Z'),
    enqueue('check the deploy', '2026-01-01T10:00:05.000Z'),
    enqueue('also look at the logs', '2026-01-01T10:00:10.000Z'),
    queued('check the deploy', '2026-01-01T10:01:00.000Z', 'scheduled-trigger'),
    reply('working on it', '2026-01-01T10:01:01.000Z'),
  ])
  it('while the agent works, next to a consumed scheduled prompt', () => {
    expect(items.queue).toEqual([{ text: 'also look at the logs', ts: '2026-01-01T10:00:10.000Z' }])
    expect(pending(items).map(q => q.raw)).toEqual(['also look at the logs'])
  })
  it('agent idle: Claude has read its queue, the stale bubble goes', () => {
    expect(pending(items, true)).toEqual([])
  })
  it('already in the conversation: no second copy', () => {
    const more = parse([
      enqueue('also look at the logs', '2026-01-01T10:00:10.000Z'),
      user('also look at the logs', '2026-01-01T10:02:00.000Z'),
    ])
    expect(pending([...more, { role: 'user' as const, text: 'also look at the logs', ts: '2026-01-01T10:02:00.000Z' }] as never)).toEqual([])
  })
})
