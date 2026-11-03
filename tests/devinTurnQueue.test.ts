// A message sent to Devin during a turn: Devin exports its ATIF transcript
// only when the turn ends, so a taken message stays out of the conversation
// for the turn's whole length. It must not be reported "not seen" after an
// hour, nor "not sent" after a minute of ready-looking screen.
import { describe, expect, it } from 'vitest'
import { DEVIN_LAND_MS, LOST_MS, QUEUED_TTL_MS, type QueueEntry, checkQueue, checkSent, publicEntry } from '../server/utils/queued'

const T0 = Date.parse('2026-11-03T09:07:19.000Z')
const sent = (x: Partial<QueueEntry> = {}): QueueEntry => ({ id: 'm1', text: 'still no image', at: T0, typedAt: T0, ...x })

describe('Devin: a taken message inside a turn is not unseen', () => {
  it('stays pending past QUEUED_TTL_MS while the turn the agent took it into runs', () => {
    const list = [sent({ turnSeen: true })]
    expect(checkSent(list, { agent: 'devin', claude: null, now: T0 + QUEUED_TTL_MS + 1 })).toBe(false)
    expect(list[0]!.failed).toBeUndefined()
    expect(publicEntry(list[0]!)).not.toMatchObject({ state: 'failed' })
  })

  it('is still reported when the agent never worked after it was typed', () => {
    const list = [sent()]
    expect(checkSent(list, { agent: 'devin', claude: null, now: T0 + QUEUED_TTL_MS + 1 })).toBe(true)
    expect(publicEntry(list[0]!)).toMatchObject({ state: 'failed', reason: 'unseen' })
  })

  it('also covers Codex, whose queued message lands only when the next turn takes it', () => {
    const list = [sent({ turnSeen: true })]
    expect(checkSent(list, { agent: 'codex', claude: null, now: T0 + QUEUED_TTL_MS + 1 })).toBe(false)
    expect(list[0]!.failed).toBeUndefined()
  })
})

describe('Devin: ready-looking polls inside a turn', () => {
  it('a taken message survives a ready pause longer than a plain read lag', () => {
    const list = [sent({ turnSeen: true })]
    checkQueue(list, 'done', T0 + 1000, false, 'devin')
    expect(checkQueue(list, 'done', T0 + 1000 + LOST_MS + 1, false, 'devin')).toBe(false)
    expect(list[0]!.failed).toBeUndefined()
  })

  it('still reports it once the agent has rested past the landing grace', () => {
    const list = [sent({ turnSeen: true })]
    checkQueue(list, 'done', T0 + 1000, false, 'devin')
    expect(checkQueue(list, 'done', T0 + 1000 + DEVIN_LAND_MS + 1, false, 'devin')).toBe(true)
    expect(publicEntry(list[0]!)).toMatchObject({ state: 'failed' })
    expect(list[0]!.unseen).toBeUndefined()
  })

  it('a message never taken keeps the plain read lag', () => {
    const list = [sent()]
    checkQueue(list, 'done', T0 + 1000, false, 'devin')
    expect(checkQueue(list, 'done', T0 + 1000 + LOST_MS + 1, false, 'devin')).toBe(true)
    expect(list[0]!.failed).toBe(true)
  })

  it('the grace restarts when the agent goes back to work', () => {
    const list = [sent({ turnSeen: true })]
    checkQueue(list, 'done', T0 + 1000, false, 'devin')
    checkQueue(list, 'working', T0 + 2000, false, 'devin')
    checkQueue(list, 'done', T0 + 3000, false, 'devin')
    expect(checkQueue(list, 'done', T0 + 3000 + LOST_MS + 1, false, 'devin')).toBe(false)
  })
})
