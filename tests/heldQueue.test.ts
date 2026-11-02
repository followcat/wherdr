// Message sent while an interactive menu hides the input field: held, then
// delivered in order once the input is back; failed (not "sending…" forever)
// when it really can't go.
import { describe, expect, it } from 'vitest'
import { HOLD_TTL_MS, LOST_MS, type QueueEntry, checkQueue, giveBackHeld, leftForGood, loadQueued, nextHeld, publicEntry, shouldHold } from '../server/utils/queued'

const entry = (id: string, at: number, more: Partial<QueueEntry> = {}): QueueEntry => ({ id, text: `message ${id}`, at, ...more })

describe('shouldHold', () => {
  it('holds when the agent rests with its input hidden by a menu', () => {
    expect(shouldHold('claude', 'idle', false, false)).toBe(true)
    expect(shouldHold('codex', 'done', false, false)).toBe(true)
  })
  it('sends directly when the input is visible', () => {
    expect(shouldHold('claude', 'idle', true, false)).toBe(false)
  })
  it('keeps Claude’s own queue while it works', () => {
    expect(shouldHold('claude', 'working', false, false)).toBe(false)
  })
  it('queues behind an earlier held message, whatever the screen', () => {
    expect(shouldHold('claude', 'idle', true, true)).toBe(true)
    expect(shouldHold('claude', 'working', true, true)).toBe(true)
  })
  it('leaves other agents alone (no known input line)', () => {
    expect(shouldHold('gemini', 'idle', false, false)).toBe(false)
    expect(shouldHold(null, 'idle', false, false)).toBe(false)
  })

  // OpenCode reports "blocked" by event while its permission/question dialog
  // owns the keys — typed text and its Enter would answer it.
  it('holds an OpenCode message while its pane is blocked', () => {
    expect(shouldHold('opencode', 'blocked', true, false)).toBe(true)
    expect(shouldHold('opencode', 'blocked', false, false)).toBe(true)
    // Not blocked: the input-visible result still holds it when its composer
    // is off screen, and releases when the field is confirmed.
    expect(shouldHold('opencode', 'idle', false, false)).toBe(true)
    expect(shouldHold('opencode', 'idle', true, false)).toBe(false)
    expect(shouldHold('opencode', 'working', false, false)).toBe(false)
    expect(shouldHold('opencode', 'working', true, true)).toBe(true)
  })
})

describe('nextHeld', () => {
  it('delivers the oldest held message first, exactly once', () => {
    const a = entry('a', 1, { held: true })
    const b = entry('b', 2, { held: true })
    const list = [entry('s', 0), a, b]
    expect(nextHeld(list)).toBe(a)
    a.held = false
    expect(nextHeld(list)).toBe(b)
    b.held = false
    expect(nextHeld(list)).toBeNull()
  })
  it('skips a failed one (waits for Retry or Cancel)', () => {
    const list = [entry('a', 1, { held: true, failed: true }), entry('b', 2, { held: true })]
    expect(nextHeld(list)!.id).toBe('b')
  })
})

describe('checkQueue', () => {
  it('fails a held message after the hold timeout', () => {
    const q = entry('a', 0, { held: true })
    expect(checkQueue([q], 'idle', HOLD_TTL_MS - 1)).toBe(false)
    expect(checkQueue([q], 'idle', HOLD_TTL_MS + 1)).toBe(true)
    expect(publicEntry(q).state).toBe('failed')
  })
  it('fails a delivered message never taken while the agent stays ready', () => {
    const q = entry('a', 0)
    checkQueue([q], 'idle', 1000)
    expect(q.failed).toBeFalsy()
    expect(checkQueue([q], 'idle', 1000 + LOST_MS + 1)).toBe(true)
  })
  it('restarts the timer whenever the agent works (Claude’s own queue)', () => {
    const q = entry('a', 0)
    checkQueue([q], 'idle', 1000)
    checkQueue([q], 'working', 30000)
    checkQueue([q], 'idle', 40000)
    expect(checkQueue([q], 'idle', 40000 + LOST_MS - 1)).toBe(false)
    expect(q.failed).toBeFalsy()
  })
  it('exposes the state to the app', () => {
    expect(publicEntry(entry('a', 5, { held: true }))).toEqual({ id: 'a', text: 'message a', at: 5, state: 'held' })
    expect(publicEntry(entry('b', 5))).toEqual({ id: 'b', text: 'message b', at: 5 })
  })
})

describe('messages held for an agent that will not come back', () => {
  it('gives the held ones back, leaving the others alone', () => {
    const list: QueueEntry[] = [{ id: 'a', text: 'Confirm: tested', at: 1000, held: true }, { id: 'b', text: 'typed earlier', at: 900 }]
    giveBackHeld(list)
    // Marked for the app: their text returns to the message field.
    expect(list.map(publicEntry)).toEqual([
      { id: 'a', text: 'Confirm: tested', at: 1000, state: 'failed', back: true },
      { id: 'b', text: 'typed earlier', at: 900 },
    ])
    // Never delivered meanwhile.
    expect(nextHeld(list)).toBeNull()
    expect(() => giveBackHeld(undefined)).not.toThrow()
  })

  it('still gives them back after a restart of the service', () => {
    const list: QueueEntry[] = [{ id: 'a', text: 'Confirm: tested', at: 1000, held: true }]
    giveBackHeld(list)
    const [[pane, read]] = loadQueued(JSON.parse(JSON.stringify({ 'w1:p1': list })), 2000) as [[string, QueueEntry[]]]
    expect(pane).toBe('w1:p1')
    expect(read.map(publicEntry)).toEqual([{ id: 'a', text: 'Confirm: tested', at: 1000, state: 'failed', back: true }])
  })

  // The polls of a Codex that simply left (no update): its pane is flagged
  // while its screen is checked, then it is a plain shell.
  it('gives back what was held while a Codex that simply left was checked', () => {
    const list: QueueEntry[] = []
    const polls = [
      { agent: 'codex' as string | null },
      { agent: null, leaving: true },
      { agent: null, leaving: true },
      { agent: null },
      { agent: null },
    ]
    const given: boolean[] = []
    let before: typeof polls[number] | undefined
    for (const [i, p] of polls.entries()) {
      // Sent from the Project panel during the check: held.
      if (i === 2) list.push({ id: 'a', text: 'Confirm: tested', at: 1000, held: true })
      const left = leftForGood(p, before)
      if (left) giveBackHeld(list)
      given.push(left)
      before = p
    }
    // Once, on the poll that ends the check.
    expect(given).toEqual([false, false, false, true, false])
    expect(list.map(publicEntry)).toEqual([{ id: 'a', text: 'Confirm: tested', at: 1000, state: 'failed', back: true }])
  })

  it('keeps them held when the check ends on the update card, or on a new agent', () => {
    // The card of a stopped Codex is served as an agent (see agentSelfUpdate.ts).
    expect(leftForGood({ agent: 'codex' }, { leaving: true })).toBe(false)
    expect(leftForGood({ agent: 'claude' }, { leaving: true })).toBe(false)
    // Still being checked, and a shell that never held an agent.
    expect(leftForGood({ agent: null, leaving: true }, { leaving: true })).toBe(false)
    expect(leftForGood({ agent: null }, {})).toBe(false)
    expect(leftForGood({ agent: null }, undefined)).toBe(false)
  })
})
