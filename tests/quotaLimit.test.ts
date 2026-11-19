import { describe, expect, it } from 'vitest'
import { limitState } from '../shared/quotaLimit'
import { windowStale } from '../app/utils/quotas'
import { codexLimitsLine } from '../server/utils/codexLimitsRead'
import { lastCodexLimits } from '../server/utils/quotas'

const now = Date.UTC(2026, 10, 17, 12)
const H = 3_600_000

describe('limitState with the reading\'s age', () => {
  const limited = (at: number, resetsAt: number) => ({ at, limited: { resetsAt } })
  it('fresh reached, stale reached → stale (unknown), reset passed → expired', () => {
    expect(limitState(limited(now - 10 * 60_000, now + 8 * H), now)).toBe('reached')
    expect(limitState(limited(now - 16 * H, now + 8 * H), now)).toBe('stale')
    expect(limitState(limited(now - 16 * H, now - H), now)).toBe('expired')
    expect(limitState({ at: now, five: null }, now)).toBeNull()
  })

  it('a Claude window at 100 % read over an hour ago is unknown, not exhausted', () => {
    const full = { used: 100, resetsAt: now + 3 * H, minutes: 300 }
    expect(windowStale(full, now - 10 * 60_000, now)).toBe(false)
    expect(windowStale(full, now - 2 * H, now)).toBe(true)
    expect(windowStale({ ...full, used: 60 }, now - 2 * H, now)).toBe(false)
  })
})

describe('Codex app-server limits read', () => {
  it('reads as a conversation\'s limits: limited until the full window resets', () => {
    const answer = JSON.stringify({ id: 2, result: { rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now / 1000 + 7200 },
      credits: { hasCredits: false, unlimited: false, balance: '0' }, rateLimitReachedType: 'rate_limit_reached',
    } } })
    expect(lastCodexLimits(codexLimitsLine(`{"id":1,"result":{}}\n${answer}\n`, now)!)).toEqual({ limited: { resetsAt: now + 2 * H }, at: now })
    const open = answer.replace('"usedPercent":100', '"usedPercent":40').replace('"rate_limit_reached"', 'null')
    expect(lastCodexLimits(codexLimitsLine(open, now)!)).toMatchObject({ rl: { secondary: { used_percent: 40 } }, at: now })
    expect(codexLimitsLine('', now)).toBeNull()
  })
})
