// A message shows in the conversation from the tap on Send: one bubble, from
// "sending" to the server's record to the transcript, never two, never lost.
import { describe, expect, it } from 'vitest'
import { type OutboxItem, SETTLED_MS, addSending, failLocal, newOutboxId, prune, resend, settle, withOutbox } from '../app/utils/outbox'
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
    expect(shown([], box)).toEqual([expect.objectContaining({ id: 'w-a', state: 'held', reason: 'busy' })])
  })

  it('drops the bubble once the transcript has the message', () => {
    const box = settle(addSending([], 'w-a', 'Fix the build', T0), 'w-a', { id: 'w-a', text: 'Fix the build', at: T0 + 1000 }, T0 + 1000)
    const items: ChatItem[] = [{ role: 'user', text: 'Fix the build', ts: new Date(T0 + 1500).toISOString() } as ChatItem]
    expect(shown([], box, items)).toEqual([])
  })

  it('removes the bubble when the server keeps no record (typed as an answer)', () => {
    expect(settle(addSending([], 'w-a', 'yes', T0), 'w-a', null, T0 + 300)).toEqual([])
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

  it('sends again under the same bubble on Retry', () => {
    const box = resend(failLocal(addSending([], 'w-a', 'hi', T0), 'w-a'), 'w-a')
    expect(box).toEqual([{ id: 'w-a', text: 'hi', at: T0, state: 'sending' }])
  })

  it('keeps the terminator through failure and Retry: not sent back as a plain Enter', () => {
    let box = addSending([], 'w-a', 'Summarize the diff', T0, 'tab')
    box = failLocal(box, 'w-a')
    expect(box[0]).toMatchObject({ state: 'failed', local: true, submitKey: 'tab' })
    box = resend(box, 'w-a')
    expect(box).toEqual([{ id: 'w-a', text: 'Summarize the diff', at: T0, state: 'sending', submitKey: 'tab' }])
  })
})

describe('outbox: prune on a new server state', () => {
  const settled = settle(addSending([], 'w-a', 'hi', T0), 'w-a', { id: 'w-a', text: 'hi', at: T0 + 8000 }, T0 + 8000)

  it('lets the server record win once listed', () => {
    expect(prune(settled, [{ id: 'w-a', text: 'hi' }], T0 + 8100)).toEqual([])
  })

  it('keeps an answered record a while after a slow send, then forgets it', () => {
    expect(prune(settled, [], T0 + 9000)).toHaveLength(1)
    expect(prune(settled, [], T0 + 8000 + SETTLED_MS)).toEqual([])
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
