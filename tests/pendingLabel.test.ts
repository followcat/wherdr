// A message sent while Claude works is held in Claude's own queue until it
// takes it (next step or end of turn): it must not read "read by the agent".
import { describe, expect, it } from 'vitest'
import { pendingLabel, pendingQueue } from '../app/utils/pendingQueue'
import type { ClaudeScreen } from '../shared/types'

const ONE = 'first queued note, please answer with ONE'
const TWO = 'second queued note, please answer with TWO'
const mine = [
  { id: 'a', text: ONE, at: 1000, settledAt: 1100 },
  { id: 'b', text: TWO, at: 2000, settledAt: 2100 },
]
const queue = [{ text: ONE, ts: '2026-01-01T00:00:01Z' }, { text: TWO, ts: '2026-01-01T00:00:02Z' }]
// A screen that misreads the last queued message as the one sent.
const misread: ClaudeScreen = { shell: null, sent: TWO, queued: [] }

describe('waiting message: in the agent\'s queue or taken', () => {
  it('in Claude\'s transcript queue: held there, never "sent", whatever the screen says', () => {
    const list = pendingQueue({ mine, claude: queue, items: [], screen: misread })
    expect(list.map(q => [q.id, q.phase, q.inAgentQueue])).toEqual([['a', 'queued', true], ['b', 'queued', true]])
    expect(list.map(q => pendingLabel(q, 'working', 'claude'))).toEqual([
      { kind: 'agent-queue', agent: 'claude' }, { kind: 'agent-queue', agent: 'claude' }])
  })

  it('taken (gone from the queue, not in the transcript yet): read by the agent', () => {
    const list = pendingQueue({ mine, claude: [], items: [], screen: misread })
    expect(list.map(q => q.phase)).toEqual(['sent', 'sent'])
    expect(pendingLabel(list[1]!, 'working', 'claude')).toEqual({ kind: 'read' })
  })

  it('in the transcript as a user turn: no longer waiting', () => {
    const items = [{ role: 'user' as const, text: ONE, ts: '2026-01-01T00:00:03Z' }, { role: 'user' as const, text: TWO, ts: '2026-01-01T00:00:03Z' }]
    expect(pendingQueue({ mine, claude: [], items, screen: null })).toEqual([])
  })

  it('Claude\'s own entries (typed on the computer) are in its queue too', () => {
    const [q] = pendingQueue({ mine: [], claude: [queue[0]!], items: [], screen: null })
    expect(q).toMatchObject({ id: expect.stringMatching(/^cc-/), phase: 'queued', inAgentQueue: true })
  })

  it('not delivered yet, or agent idle: not in its queue', () => {
    const sending = pendingQueue({ mine: [{ id: 'c', text: ONE, at: 1000, state: 'sending' as const }], claude: queue, items: [], screen: null })
    expect(sending[0]).toMatchObject({ phase: 'queued', state: 'sending' })
    expect(sending[0]!.inAgentQueue).toBeUndefined()
    // Idle: Claude has emptied its queue; the message typed at once is being read.
    const idle = pendingQueue({ mine, claude: queue, items: [], screen: null, idle: true })
    expect(idle.map(q => [q.phase, q.inAgentQueue])).toEqual([['sent', undefined], ['sent', undefined]])
  })
})

describe('label of a waiting message', () => {
  const held = { phase: 'queued' as const, state: null, inAgentQueue: true }
  const plain = { phase: 'queued' as const, state: null }
  it.each([
    [plain, 'working', { kind: 'queued' }],
    [plain, 'sending', { kind: 'sending' }],
    [{ ...plain, state: 'sending' as const }, 'working', { kind: 'sending' }],
    [held, 'working', { kind: 'agent-queue', agent: 'claude' }],
    [held, 'question', { kind: 'question' }],
    [held, 'stopped', { kind: 'stopped' }],
    [{ phase: 'sent' as const, state: null }, 'working', { kind: 'read' }],
    [{ phase: 'sent' as const, state: null, inAgentQueue: true }, 'working', { kind: 'agent-queue', agent: 'claude' }],
  ] as const)('%o while %s', (q, waitFor, label) => {
    expect(pendingLabel(q, waitFor, 'claude')).toEqual(label)
  })
})
