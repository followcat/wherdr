// A message shows in the conversation from the tap on Send: one bubble, from
// "sending" to the server's record to the transcript, never two, never lost.
import { describe, expect, it } from 'vitest'
import { GONE_MAX_MS, type OutboxItem, REPEAT_MS, SETTLED_MS, SendTimeout, addSending, chainSend, failLocal, isRepeat, newOutboxId, prune, recentSends, resend, settle, withOutbox } from '../app/utils/outbox'
import { pendingQueue } from '../app/utils/pendingQueue'
import type { ChatItem, QueuedMessage } from '../shared/types'

const T0 = Date.parse('2026-01-01T10:00:00Z')
const shown = (server: QueuedMessage[], local: OutboxItem[], items: ChatItem[] = []) =>
  pendingQueue({ mine: withOutbox(server, local), claude: [], items, screen: null })

describe('outbox: one bubble from the tap to the transcript', () => {
  it('shows the message at once, as queued and sending', () => {
    const box = addSending([], 'w-a', 'hello there', T0)
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', raw: 'hello there', phase: 'queued', state: 'sending', mine: true })])
  })

  it('keeps a single bubble while the server lists the same message', () => {
    let box = addSending([], 'w-a', 'hello there', T0)
    const server: QueuedMessage = { id: 'w-a', text: 'hello there', at: T0 + 2500 }
    // The server state arrives before its answer to the request.
    expect(shown([server], box)).toHaveLength(1)
    expect(shown([server], box)[0]!.state).toBe(null)
    box = settle(box, 'w-a', server, T0 + 2600)
    expect(shown([server], box)).toHaveLength(1)
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', state: null })])
  })

  it('takes the held state of the server, under the same id', () => {
    const box = settle(addSending([], 'w-a', 'hi', T0), 'w-a', { id: 'w-a', text: 'hi', at: T0 + 900, state: 'held', reason: 'busy' }, T0 + 900)
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', state: 'held' })])
  })

  it('drops the bubble once the transcript has the message', () => {
    const box = settle(addSending([], 'w-a', 'Fix the build', T0), 'w-a', { id: 'w-a', text: 'Fix the build', at: T0 + 1000 }, T0 + 1000)
    const items: ChatItem[] = [{ role: 'user', text: 'Fix the build', ts: new Date(T0 + 1500).toISOString() } as ChatItem]
    expect(shown([], box, items)).toEqual([])
  })

  // herdr-core answers {ok, started}, never a record: the message was typed
  // into the agent. The bubble stayed "sending" a moment, then vanished.
  it('keeps the bubble as a sent message when the server keeps no record', () => {
    const box = settle(addSending([], 'w-a', 'Fix the build', T0), 'w-a', null, T0 + 300)
    expect(box).toEqual([{ id: 'w-a', text: 'Fix the build', at: T0, settledAt: T0 + 300 }])
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', state: null })])
    // Typed into an idle agent: shown as sent, not as still sending.
    expect(pendingQueue({ mine: box, claude: [], items: [], screen: null, idle: true })).toEqual([expect.objectContaining({ id: 'w-a', phase: 'sent' })])
    // Until a read made long enough after the send (see prune).
    const gone = prune(box, [], T0 + 1000, T0 + 900)
    expect(gone).toHaveLength(1)
    expect(prune(gone, [], T0 + 12_000, T0 + 11_000)).toEqual([])
  })

  it('keeps messages typed in a row in the order of the taps', () => {
    let box = addSending([], 'w-a', 'first', T0)
    box = addSending(box, 'w-b', 'second', T0 + 200)
    // The first one's server record is later than the second tap.
    box = settle(box, 'w-a', { id: 'w-a', text: 'first', at: T0 + 3000 }, T0 + 3000)
    expect(shown([], box).map(q => q.raw)).toEqual(['first', 'second'])
  })
})

describe('outbox: a send that fails', () => {
  it('turns the bubble into "Not sent" with the text and photos kept', () => {
    const text = 'look\n/home/user/.cache/herdr-web/uploads/2026-01-01T10-00-00-000Z-a.jpg'
    const box = failLocal(addSending([], 'w-a', text, T0), 'w-a')
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', raw: text, state: 'failed', local: true, photos: ['2026-01-01T10-00-00-000Z-a.jpg'] })])
  })

  it('sends again under the same bubble on Retry, its photo still a photo', () => {
    const text = 'hi\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    const box = resend(failLocal(addSending([], 'w-a', text, T0), 'w-a'), 'w-a')
    expect(box).toEqual([{ id: 'w-a', text, at: T0, state: 'sending' }])
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', state: 'sending', photos: ['2026-01-01T10-00-00-000Z-a1b2c3.png'] })])
  })
})

describe('outbox: prune on a new server state', () => {
  const settled = settle(addSending([], 'w-a', 'hi', T0), 'w-a', { id: 'w-a', text: 'hi', at: T0 + 8000 }, T0 + 8000)

  it('lets the server record win once listed', () => {
    expect(prune(settled, [{ id: 'w-a', text: 'hi' }], T0 + 8100)).toEqual([])
  })

  it('keeps a taken record until a read made well after it left, then forgets it', () => {
    const gone = prune(settled, [], T0 + 9000)
    expect(gone).toEqual([expect.objectContaining({ id: 'w-a', goneAt: T0 + 9000 })])
    // A read that started too soon may predate the message in the transcript.
    expect(prune(gone, [], T0 + 9000 + SETTLED_MS, T0 + 9500)).toHaveLength(1)
    expect(prune(gone, [], T0 + 9000 + SETTLED_MS, T0 + 9000 + SETTLED_MS)).toEqual([])
  })

  // The agent took the message, then every read of the transcript failed
  // (reconnecting): the bubble stayed 10 s, then vanished.
  it('keeps a sent message shown while the transcript cannot be read', () => {
    expect(GONE_MAX_MS).toBe(5 * 60_000)
    let box = prune(settled, [], T0 + 9000, T0 + 7000)
    for (let t = T0 + 10_000; t < T0 + 9000 + GONE_MAX_MS; t += 1500) box = prune(box, [], t, T0 + 7000)
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', raw: 'hi' })])
    // Never read again for that long: it goes anyway.
    expect(prune(box, [], T0 + 9000 + GONE_MAX_MS, T0 + 7000)).toEqual([])
  })

  it('counts the wait from when the agent took a message held for a long time', () => {
    // Listed (held) for minutes after the send's answer, then taken just now.
    const taken = T0 + 300_000
    expect(prune(settled, [], taken, taken - 500)).toHaveLength(1)
  })

  it('never forgets a bubble still sending or never delivered', () => {
    const box = failLocal(addSending(addSending([], 'w-a', 'a', T0), 'w-b', 'b', T0), 'w-b')
    expect(prune(box, [], T0 + 10 * SETTLED_MS)).toHaveLength(2)
  })
})

it('makes ids the server accepts, all different', () => {
  const ids = Array.from({ length: 500 }, newOutboxId)
  expect(new Set(ids).size).toBe(500)
  for (const id of ids) expect(id).toMatch(/^w-[a-z0-9]{1,32}$/)
})

// A dictation app can press Enter again while the page lags: the same text,
// sent again a moment later, is that echo and not a new message.
describe('outbox: an echo of the message just sent', () => {
  const sent = [{ text: 'Fix the cache', at: T0 }]

  it('is the exact same text within REPEAT_MS', () => {
    expect(isRepeat(sent, 'Fix the cache', T0)).toBe(true)
    expect(isRepeat(sent, 'Fix the cache', T0 + REPEAT_MS - 1)).toBe(true)
  })

  it('any change in the text is a new message', () => {
    expect(isRepeat(sent, 'Fix the cache.', T0 + 10)).toBe(false)
    expect(isRepeat(sent, 'fix the cache', T0 + 10)).toBe(false)
    expect(isRepeat(sent, 'Fix the cache ', T0 + 10)).toBe(false)
  })

  it('a deliberate resend later goes', () => {
    expect(isRepeat(sent, 'Fix the cache', T0 + REPEAT_MS)).toBe(false)
  })

  it('forgets old sends and keeps recent ones', () => {
    const list = [{ text: 'old', at: T0 - REPEAT_MS }, { text: 'new', at: T0 - 1 }]
    expect(recentSends(list, T0)).toEqual([{ text: 'new', at: T0 - 1 }])
    expect(isRepeat(list, 'old', T0)).toBe(false)
  })
})

describe('outbox: sends of a conversation, one after the other', () => {
  it('a message queued behind a failed one is still sent', async () => {
    const sent: string[] = []
    const first = chainSend(undefined, async () => { sent.push('! cd /x\nls'); throw new Error('refused') })
    const second = chainSend(first, async () => { sent.push('!'); return 'ok' })
    await expect(first).rejects.toThrow('refused')
    await expect(second).resolves.toBe('ok')
    expect(sent).toEqual(['! cd /x\nls', '!'])
  })

  it('a send with no answer fails at its deadline and frees the ones behind it', async () => {
    let aborted = false
    // Never answers, and ignores the signal (the deadline still fires).
    const hung = chainSend(undefined, (signal) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise<string>(() => {}) }, 20)
    const next = chainSend(hung, async () => 'sent', 20)
    await expect(hung).rejects.toBeInstanceOf(SendTimeout)
    expect(aborted).toBe(true)
    await expect(next).resolves.toBe('sent')
  })

  it('waits for the earlier send before starting the next', async () => {
    const order: string[] = []
    let release!: () => void
    const first = chainSend(undefined, () => new Promise<void>((r) => { release = () => { order.push('first'); r() } }))
    const second = chainSend(first, async () => { order.push('second') })
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual([])
    release()
    await second
    expect(order).toEqual(['first', 'second'])
  })
})
