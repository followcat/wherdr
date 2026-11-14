import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WAKE, ackWakes, addSkip, enqueue, inWake, readQueue, sinceYesterday, tickWakes, wakeKindOf, wakeText, type Wake } from '../shared/pm/wakes'
import { HEALTH_REPEAT_MS, healthRepeats } from '../shared/pm/health'
import { createPmStore } from '../server/utils/pmStore'

const MIN = 60_000
// Applies a tick's changes to the queue, as the store does.
const apply = (q: Wake[], changed: Wake[]) => [...q.filter(w => !changed.some(c => c.id === w.id)), ...changed]
const tick = (q: Wake[], status: 'idle' | 'working' | 'gone', now: number, lastUserAt?: number) => {
  const r = tickWakes(q, 'CO', { status, now, lastUserAt })
  return { ...r, q: apply(q, r.changed) }
}
const queued = (reasons: string[], now = 0, id = 'w1') => [enqueue([], 'CO', reasons, now, id)]

describe('the timeline window', () => {
  it('starts at yesterday\'s local midnight, a 25 h day included', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const now = new Date(2026, 10, 1, 23, 50).getTime()
      expect(sinceYesterday(now)).toBe(new Date(2026, 9, 31, 0, 0).getTime())
      // Handled 31 October at 00:05, 48 h 45 min before: still read.
      const handled = new Date(2026, 9, 31, 0, 5).getTime()
      const w = JSON.stringify({ id: 'y', coordinator: 'CO', reasons: [], createdAt: handled, tries: 1, endedAt: handled, ended: 'ack' })
      expect(readQueue([w], now, now - sinceYesterday(now))).toHaveLength(1)
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz }
  })
})

describe('wakes not sent', () => {
  it('a health check repeating the last one\'s lines is skipped, for 12 h at most', () => {
    const sent = { lines: ['Waiting for the user: CO-1 (Fix)', 'ack'], at: 0 }
    expect(healthRepeats(['Waiting for the user: CO-1 (Fix)', 'ack'], sent, 3 * 3_600_000)).toBe(true)
    expect(healthRepeats(['Waiting for the user: CO-1 (Fix); CO-2 (New)', 'ack'], sent, 3 * 3_600_000)).toBe(false)
    expect(healthRepeats(sent.lines, sent, HEALTH_REPEAT_MS)).toBe(false)
    expect(healthRepeats(sent.lines, undefined, 0)).toBe(false)
  })
  it('notes each engine skip once in 12 h, each scheduled one, three days kept', () => {
    const s = { at: 0, what: 'engine' as const, why: 'CO-1: offline' }
    const one = addSkip(undefined, s)!
    expect(addSkip(one, { ...s, at: 3_600_000 })).toBeUndefined()
    expect(addSkip(one, { ...s, at: HEALTH_REPEAT_MS })).toHaveLength(2)
    // Every 30 min for two days: all kept; older than three days: dropped.
    const slots = Array.from({ length: 96 }, (_, i) => i).reduce<ReturnType<typeof addSkip>>((l, i) => addSkip(l, { at: i * 1_800_000, what: 'autopilot', why: 'Scheduled wake: nothing to do' }), undefined)!
    expect(slots).toHaveLength(96)
    expect(addSkip(slots, { ...s, at: 3 * 86_400_000 + 1 })).toHaveLength(96)
    // A scheduled wake is skipped once per slot: each one noted.
    const slot = { at: 0, what: 'autopilot' as const, why: 'Scheduled wake: nothing to do' }
    expect(addSkip(addSkip(undefined, slot), { ...slot, at: 3_600_000 })).toHaveLength(2)
  })
})

describe('wake queue', () => {
  it('merges pending reasons into one Autopilot message, without repeats', () => {
    let q = queued(['CO-1: done'])
    q = apply(q, [enqueue(q, 'CO', ['CO-2: stuck', 'CO-1: done'], 5, 'w2')])
    expect(q).toHaveLength(1)
    const r = tick(q, 'idle', 2 * MIN)
    expect(r.deliver).toMatchObject({ id: 'w1', reasons: ['CO-1: done', 'CO-2: stuck'], tries: 1 })
    expect(wakeText(r.deliver!)).toMatch(/^Autopilot: wake w1\n\nCO-1: done\n\nCO-2: stuck\n\nWhen you have handled this, run: wherdr pm ack w1$/)
    // With the autopilot on, it says which mechanical fixes it allows, and what stays the user's.
    expect(wakeText(r.deliver!, true)).toContain('CO-2: stuck\n\nIn this wake you may unblock a task of your project')
    expect(wakeText(r.deliver!, true)).toMatch(/--fix <kind>.*base \(merge the base.*stall \(restart a stalled agent\).*At most 2 times per task and step.*A permission request, merging, approving, guards, settings and limits stay the user's/)
    // Once delivered, new reasons start a new wake.
    expect(enqueue(r.q, 'CO', ['CO-3: added'], 3 * MIN, 'w3').id).toBe('w3')
  })

  it('names its source on the first line, one source per wake', () => {
    let q = queued(['CO-1: done'])
    q = apply(q, [enqueue(q, 'CO', ['CO-2 (Ship): Check again'], 0, 'w2', false, { kind: 'step', about: 'CO-2 (deploy)' })])
    q = apply(q, [enqueue(q, 'CO', ['CO-3: gave up'], 0, 'w3', false, { kind: 'engine' })])
    q = apply(q, [enqueue(q, 'CO', ['Disk almost full'], 0, 'w4', false, { kind: 'health' })])
    expect(q.map(w => w.reasons)).toEqual([['CO-1: done'], ['CO-2 (Ship): Check again'], ['CO-3: gave up'], ['Disk almost full']])
    const heads = q.map(w => wakeText(w).split('\n')[0])
    expect(heads).toEqual(['Autopilot: wake w1', 'Step check: CO-2 (deploy), wake w2', 'Engine: wake w3', 'Health check: wake w4'])
    expect(heads.map(wakeKindOf)).toEqual(['autopilot', 'step', 'engine', 'health'])
    expect(wakeKindOf('Autopilot: please look')).toBeNull()
    // Its queued form (Claude's paste wrapper, a leading line break) reads the same as the transcript's.
    const text = wakeText({ ...q[0]!, kind: 'incident', about: 'inc1' })
    expect(wakeKindOf(text)).toBe('incident')
    expect(wakeKindOf(`<pasted_content id="1">\n${text}\n</pasted_content id="1">`)).toBe('incident')
    expect(wakeKindOf(`\n ${text}`)).toBe('incident')
    // An old wake without a kind is the autopilot's; the ack line is the same for all.
    expect(wakeText({ ...q[0]!, kind: undefined })).toMatch(/^Autopilot: wake w1\n[\s\S]*run: wherdr pm ack w1$/)
    expect(wakeText(q[1]!)).toMatch(/run: wherdr pm ack w2$/)
    // Delivered one after the other.
    expect(tick(q, 'idle', 2 * MIN).deliver).toMatchObject({ id: 'w1' })
  })

  it('is never delivered in the middle of a turn', () => {
    const q = queued(['CO-1: done'])
    expect(tick(q, 'working', 10 * MIN).deliver).toBeUndefined()
    expect(tick(q, 'gone', 10 * MIN).deliver).toBeUndefined()
    expect(tick(q, 'idle', 10 * MIN).deliver).toBeDefined()
  })

  it('after a human message, waits 60 s', () => {
    const q = queued(['CO-1: done'])
    expect(tick(q, 'idle', 100_000, 100_000 - WAKE.QUIET_MS + 1).deliver).toBeUndefined()
    expect(tick(q, 'idle', 100_000, 100_000 - WAKE.QUIET_MS).deliver).toBeDefined()
  })

  it('no ack within 15 min: delivered once more, then the user is told', () => {
    let r = tick(queued(['CO-1: stuck']), 'idle', 0)
    r = tick(r.q, 'working', 1 * MIN)
    r = tick(r.q, 'working', WAKE.ACK_MS - 1)
    expect(r.deliver).toBeUndefined()
    // Meanwhile a new reason waits: it goes with the retry.
    r.q = apply(r.q, [enqueue(r.q, 'CO', ['CO-2: done'], WAKE.ACK_MS - 1, 'w2')])
    r = tick(r.q, 'idle', WAKE.ACK_MS) // its turn ends after 2 min idle
    expect(r.deliver).toBeUndefined()
    r = tick(r.q, 'idle', WAKE.ACK_MS + WAKE.IDLE_MS)
    expect(r.deliver).toMatchObject({ id: 'w1', tries: 2, reasons: ['CO-1: stuck', 'CO-2: done'] })
    expect(wakeText(r.deliver!)).toContain('(again: no ack after 15 min)')
    expect(r.q.find(w => w.id === 'w2')).toMatchObject({ ended: 'merged' })
    r = tick(r.q, 'idle', WAKE.ACK_MS + WAKE.IDLE_MS + 1)
    r = tick(r.q, 'idle', 2 * WAKE.ACK_MS + WAKE.IDLE_MS - 1)
    expect(r.notify).toBeUndefined()
    r = tick(r.q, 'idle', 2 * WAKE.ACK_MS + WAKE.IDLE_MS)
    expect(r.notify).toMatchObject({ id: 'w1', ended: 'unanswered' })
    expect(r.deliver).toBeUndefined()
    // Told once.
    expect(tick(r.q, 'idle', 3 * WAKE.ACK_MS).notify).toBeUndefined()
  })

  it('an acked wake is neither retried nor reported', () => {
    let r = tick(queued(['CO-1: stuck']), 'idle', 0)
    const a = ackWakes(r.q, 'CO', ['w1'], MIN)
    expect(a.unknown).toEqual([])
    r.q = apply(r.q, a.changed)
    expect(r.q[0]).toMatchObject({ ackedAt: MIN, ended: 'ack' })
    r = tick(r.q, 'idle', 3 * WAKE.ACK_MS)
    expect([r.deliver, r.notify]).toEqual([undefined, undefined])
    // Another coordinator's wake, or one never delivered, is unknown.
    expect(ackWakes(r.q, 'ST', ['w1'], MIN).unknown).toEqual(['w1'])
    expect(ackWakes(queued(['x'], 0, 'w9'), 'CO', ['w9'], MIN).unknown).toEqual(['w9'])
  })

  it('ends when the coordinator stays idle 2 min, so the next one can go', () => {
    let r = tick(queued(['CO-1: done']), 'idle', 0)
    r.q = apply(r.q, [enqueue(r.q, 'CO', ['CO-2: done'], 10_000, 'w2')])
    r = tick(r.q, 'idle', 30_000) // idle from here
    expect(inWake(r.q, 'CO')).toBe(true)
    expect(r.deliver).toBeUndefined() // still open
    r = tick(r.q, 'working', 60_000) // working again: the idle clock restarts
    r = tick(r.q, 'idle', 90_000)
    r = tick(r.q, 'idle', 90_000 + WAKE.IDLE_MS - 1)
    expect(r.deliver).toBeUndefined()
    r = tick(r.q, 'idle', 90_000 + WAKE.IDLE_MS)
    expect(r.q.find(w => w.id === 'w1')).toMatchObject({ ended: 'idle' })
    expect(r.deliver).toMatchObject({ id: 'w2' })
  })

  it('an unacked wake of a coordinator that quit is reported, not left pending', () => {
    let r = tick(tick(queued(['a']), 'idle', 0).q, 'gone', MIN)
    r = tick(r.q, 'gone', WAKE.ACK_MS)
    expect(r.notify).toMatchObject({ id: 'w1', ended: 'unanswered', tries: 1 })
  })

  it('ends when the coordinator quits, and after 1 h at most', () => {
    const quit = tick(tick(queued(['a']), 'idle', 0).q, 'gone', MIN)
    expect(quit.q[0]).toMatchObject({ ended: 'quit' })
    // Working past 15 min is not retried mid-turn; the turn ends at 1 h, then the retry.
    let long = tick(tick(queued(['a']), 'idle', 0).q, 'working', WAKE.ACK_MS)
    expect(inWake(long.q, 'CO')).toBe(true)
    expect(tickWakes(long.q, 'CO', { status: 'working', now: WAKE.TIMEOUT_MS }).changed[0]).toMatchObject({ deliveredAt: undefined, tries: 1 })
    long = tick(long.q, 'working', WAKE.TIMEOUT_MS)
    expect(inWake(long.q, 'CO')).toBe(false)
    expect(tick(long.q, 'idle', WAKE.TIMEOUT_MS + 1).deliver).toMatchObject({ id: 'w1', tries: 2 })
  })

  it('run now is never blocked by an open wake nor the quiet minute', () => {
    let r = tick(queued(['CO-1: done']), 'idle', 0)
    r.q = apply(r.q, [enqueue(r.q, 'CO', ['Run now'], 10_000, 'w2', true)])
    r = tick(r.q, 'idle', 20_000, 15_000)
    expect(r.deliver).toMatchObject({ id: 'w2', reasons: ['Run now'] })
    expect(r.q.find(w => w.id === 'w1')).toMatchObject({ ended: 'idle' })
    // Still never in the middle of a turn.
    const busy = queued(['Run now'], 0, 'w3').map(w => ({ ...w, now: true as const }))
    expect(tick(busy, 'working', MIN).deliver).toBeUndefined()
  })

  it('reads the last line of each id, skips a cut line and old ended wakes', () => {
    const w = queued(['a'])[0]!
    const lines = [JSON.stringify(w), JSON.stringify({ ...w, deliveredAt: 5 }), '{"id":"w', JSON.stringify({ ...w, id: 'old', endedAt: 1 })]
    expect(readQueue(lines, 2 * 86_400_000)).toEqual([{ ...w, deliveredAt: 5 }])
  })

  it('survives a restart: the queue is read back from wakes.jsonl', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-wakes-'))
    try {
      const a = createPmStore(dir)
      await a.setEnabled(true)
      const w = queued(['CO-1: done'], Date.now())[0]!
      await a.saveWakes([w])
      await a.saveWakes([{ ...w, deliveredAt: Date.now(), tries: 1 }])
      expect(await createPmStore(dir).wakes()).toEqual([{ ...w, deliveredAt: expect.any(Number), tries: 1 }])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
