import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { localFs } from '../server/utils/fsx'
import { codexLimitReset, lastCodexLimits, mergeQuotas, readCodexMachine } from '../server/utils/quotas'

const nullTokens = (t: string) => JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, rate_limit_reached_type: null } } })
const limitError = (t: string, text = 'try again at Nov 8th, 2026 2:52 PM.') => JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: `You’ve hit your usage limit. Upgrade to Pro, or ${text}`, codex_error_info: 'usage_limit_exceeded' } } })
const numbers = (t: string, used: number, resets = 1793900000) => JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 69, window_minutes: 10080, resets_at: 1794200000 }, rate_limit_reached_type: null } } })

describe('Codex usage limit reached', () => {
  it('reads the reset time of the message', () => {
    expect(codexLimitReset('try again at Nov 8th, 2026 2:52 PM.', 0)).toBe(new Date(2026, 10, 8, 14, 52).getTime())
    const at = new Date(2026, 9, 30, 16, 40).getTime()
    expect(codexLimitReset('or try again at 6:37 AM.', at)).toBe(new Date(2026, 9, 31, 6, 37).getTime())
    expect(codexLimitReset('or try again at 6:37 PM.', at)).toBe(new Date(2026, 9, 30, 18, 37).getTime())
    expect(codexLimitReset('12:05 AM nothing', at)).toBeNull()
  })

  it('limited: null limits then the error; recovered: a later reading with numbers', () => {
    const limited = [numbers('2026-11-01T10:00:00Z', 100), nullTokens('2026-11-02T10:00:00Z'), limitError('2026-11-02T10:00:01Z')].join('\n')
    const hit = lastCodexLimits(limited)!
    expect(hit.limited).toEqual({ resetsAt: new Date(2026, 10, 8, 14, 52).getTime() })
    expect(hit.at).toBe(Date.parse('2026-11-02T10:00:01Z'))
    const back = lastCodexLimits([limited, numbers('2026-11-08T21:00:00Z', 3)].join('\n'))!
    expect(back.limited).toBeUndefined()
    expect(back.rl!.primary.used_percent).toBe(3)
  })

  it('rate_limit_reached_type with numbers also means limited', () => {
    const l = JSON.stringify({ timestamp: '2026-11-02T10:00:00Z', payload: { rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 1793900000 }, secondary: null, rate_limit_reached_type: 'primary' } } })
    expect(lastCodexLimits(l)!.limited).toEqual({ resetsAt: 1793900000000 })
  })

  it('home: stale gauge replaced by the limit, gauges back after a new reading', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-limit-'))
    const now = new Date()
    const dir = path.join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    const meta = JSON.stringify({ timestamp: new Date(now.getTime() - 3600000).toISOString(), type: 'session_meta', payload: { creator_account_id: 'acc-1' } })
    const ts = (min: number) => new Date(now.getTime() - min * 60000).toISOString()
    // Reset times relative to now: the stale gauge's window has ended, the new reading is in the current one.
    const resets = (min: number) => Math.round(now.getTime() / 1000) + min * 60
    const old = path.join(dir, 'rollout-a.jsonl')
    const cur = path.join(dir, 'rollout-b.jsonl')
    try {
      fs.writeFileSync(old, [meta, numbers(ts(50), 100, resets(-1))].join('\n'))
      fs.writeFileSync(cur, [meta, nullTokens(ts(5)), limitError(ts(5))].join('\n'))
      const r = (await readCodexMachine(localFs, home)).q!
      expect(r.limited).toBeTruthy()
      expect(r.five).toBeNull()
      expect(r.account).toBeTruthy()
      const merged = mergeQuotas([{ key: '', label: 'Local', claude: null, codex: r }])
      expect(merged.codex!.limited).toBeTruthy()
      fs.appendFileSync(cur, `\n${numbers(ts(1), 4, resets(240))}`)
      const back = (await readCodexMachine(localFs, home)).q!
      expect(back.limited).toBeUndefined()
      expect(back.five!.used).toBe(4)
    }
    finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})
