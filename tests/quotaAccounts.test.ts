import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Quota } from '../shared/types'
import { accountFor, accountKey, cleanAccountName, defaultAccountName, uniqueKey } from '../shared/quotaAccount'
import { type PacingEntry, changed, parseEntry, pacingEntry, usedToday } from '../shared/pacingLog'
import { mergeQuotas, pacingEntries } from '../server/utils/quotas'
import { forgetPacingLog, readPacingLog, recordReadings } from '../server/utils/pacingLog'
import { readAccountNames, setAccountName } from '../server/utils/accountNames'

const H = 3600000
const FP_A = 'a1b2c3d4e5f60718'
const FP_B = 'ffeeddccbbaa9988'
// Thursday 2026-10-29 21:00 UTC.
const RESET = Date.UTC(2026, 9, 29, 21)
const q = (at: number, account: string | null, used = 10, reset = RESET) =>
  ({ five: { used, resetsAt: at + 2 * H, minutes: 300 }, week: { used, resetsAt: reset, minutes: 10080 }, at, account })

describe('account keys', () => {
  it('keeps only 8 characters of a fingerprint, else the reset hour, else the machine', () => {
    expect(accountKey('claude', FP_A, null, '')).toBe('claude:a1b2c3d4')
    expect(accountKey('codex', null, { used: 1, resetsAt: RESET + 4 * 60000, minutes: 10080 }, 'x')).toBe('codex:reset-thu21')
    expect(accountKey('codex', null, { used: 0, resetsAt: null, minutes: 10080 }, 'Host A.lan')).toBe('codex:machine-host-a-lan')
    expect(accountKey('claude', null, null, '')).toBe('claude:machine-local')
    const taken = new Set<string>()
    expect([uniqueKey('claude:a1b2c3d4', taken), uniqueKey('claude:a1b2c3d4', taken)]).toEqual(['claude:a1b2c3d4', 'claude:a1b2c3d4-2'])
    expect(cleanAccountName('  Work \n Pro  ')).toBe('Work Pro')
    expect(cleanAccountName('x'.repeat(60))).toHaveLength(40)
    expect(cleanAccountName(3)).toBe('')
  })

  it('lists every account with its key and machines, never the fingerprint', () => {
    const readings = [
      { key: '', label: 'Server', claude: q(5, FP_A), codex: { ...q(4, FP_B), account: FP_B } },
      { key: 'laptop', label: 'Laptop', claude: q(3, FP_B), codex: null, codexSeen: false },
      { key: 'desk', label: 'Desk', claude: q(9, FP_A, 30), codex: { ...q(6, FP_B, 20), account: FP_B } },
    ]
    const out = mergeQuotas(readings, { 'claude:a1b2c3d4': 'Work Pro' })
    expect(out.accounts).toEqual([
      { key: 'claude:a1b2c3d4', program: 'claude', name: 'Work Pro', machines: ['', 'desk'] },
      { key: 'claude:ffeeddcc', program: 'claude', machines: ['laptop'] },
      { key: 'codex:ffeeddcc', program: 'codex', machines: ['', 'desk'] },
    ])
    expect(out.claudeAccounts!.map(a => [a.key, a.name])).toEqual([['claude:a1b2c3d4', 'Work Pro'], ['claude:ffeeddcc', undefined]])
    // One shared Codex account: no block of its own, still in the table.
    expect(out.codexAccounts).toBeUndefined()
    expect(out.claude).not.toHaveProperty('key')
    const json = JSON.stringify(out)
    expect(json).not.toContain(FP_A)
    expect(json).not.toContain(FP_B)
    // (machine, program) -> account.
    expect(accountFor(out.accounts, 'desk', 'claude')?.name).toBe('Work Pro')
    expect(accountFor(out.accounts, 'laptop', 'codex')).toBeNull()
    expect(accountFor(out.accounts, '', 'codex')?.key).toBe('codex:ffeeddcc')
    // Log lines: each account's newest reading.
    expect(pacingEntries(out, readings)).toEqual([
      { account: 'claude:a1b2c3d4', at: 9, five: 30, week: 30, reset: RESET },
      { account: 'claude:ffeeddcc', at: 3, five: 10, week: 10, reset: RESET },
      { account: 'codex:ffeeddcc', at: 6, five: 20, week: 20, reset: RESET },
    ])
  })
})

describe('pacing log', () => {
  const e = (at: number, week: number | null, reset: number | null = RESET, account = 'claude:a1b2c3d4'): PacingEntry =>
    ({ account, at, five: 1, week, reset })
  const day = (h: number, m = 0) => new Date(2026, 9, 28, h, m).getTime() // local time

  it('a line only when a value moves, never for an older or limited reading', () => {
    expect(changed(undefined, e(1, 5))).toBe(true)
    expect(changed(e(1, 5), e(2, 5))).toBe(false)
    expect(changed(e(1, 5), e(2, 5, RESET + 5 * 60000))).toBe(false) // recomputed reset
    expect(changed(e(1, 5), e(2, 6))).toBe(true)
    expect(changed(e(1, 5), e(2, 5, RESET + 7 * 24 * H))).toBe(true)
    expect(changed(e(3, 5), e(2, 9))).toBe(false)
    expect(pacingEntry('codex:x', { five: null, week: null, at: 1, limited: { resetsAt: null } } as Quota)).toBeNull()
    expect(parseEntry('{"account":"a","at":1,"five":null,"week":2,"reset":null}')).toEqual({ account: 'a', at: 1, five: null, week: 2, reset: null })
    expect(parseEntry('{"account":"a","at":1')).toBeNull()
  })

  it('used today: from the last line before midnight, reset and corrections included', () => {
    const log = [e(day(-2), 30), e(day(-1), 40), e(day(9), 43), e(day(11), 42), e(day(15), 50), e(day(16), 51, null, 'other')]
    expect(usedToday(log, 'claude:a1b2c3d4', day(18))).toBe(11) // 40 -> 43 (+3), 42 (correction), 50 (+8)
    expect(usedToday(log, 'claude:a1b2c3d4', day(10))).toBe(3)
    expect(usedToday(log, 'claude:a1b2c3d4', day(0, 30))).toBe(0)
    // Weekly reset at 14:00: 40 -> 46 before it, then 0 -> 4 after it.
    const next = RESET + 7 * 24 * H
    const reset = [e(day(-1), 40), e(day(13), 46), e(day(14, 5), 1, next), e(day(17), 4, next)]
    expect(usedToday(reset, 'claude:a1b2c3d4', day(18))).toBe(10)
    // Without a reset time, a drop means a reset.
    expect(usedToday([e(day(8), 80, null), e(day(15), 3, null)], 'claude:a1b2c3d4', day(18))).toBe(3)
    // First line of the day as the start when nothing came before.
    expect(usedToday([e(day(8), 20), e(day(12), 25)], 'claude:a1b2c3d4', day(18))).toBe(5)
    expect(usedToday(log, 'nobody', day(18))).toBeNull()
  })

  describe('file', () => {
    let dir = ''
    let file = ''
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pacing-'))
      file = path.join(dir, 'pacing-log.jsonl')
      forgetPacingLog()
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('appends changes only, and drops lines older than 8 days', async () => {
      const now = Date.now()
      const old = e(now - 9 * 24 * H, 3)
      fs.writeFileSync(file, JSON.stringify(old) + '\nnot json\n' + JSON.stringify(e(now - 2 * H, 5)) + '\n')
      // Unchanged reading: nothing new, but the stale line is purged.
      expect(await recordReadings([e(now - H, 5)], now, file)).toEqual([])
      expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
      expect(await recordReadings([e(now, 7), e(now, 2, RESET, 'codex:x')], now, file)).toHaveLength(2)
      expect(await recordReadings([e(now + 1000, 7)], now, file)).toEqual([])
      forgetPacingLog()
      expect((await readPacingLog(file)).map(x => x.week)).toEqual([5, 7, 2])
    })
  })
})

describe('account names', () => {
  it('sets, cleans and removes a name', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'names-'))
    const file = path.join(dir, 'account-names.json')
    try {
      expect(await readAccountNames(file)).toEqual({})
      await setAccountName('claude:a1b2c3d4', '  Work   Pro ', file)
      await setAccountName('codex:ffeeddcc', 'Personal', file)
      expect(await readAccountNames(file)).toEqual({ 'claude:a1b2c3d4': 'Work Pro', 'codex:ffeeddcc': 'Personal' })
      expect(await setAccountName('codex:ffeeddcc', ' ', file)).toEqual({ 'claude:a1b2c3d4': 'Work Pro' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

it('names an unnamed account by its program and a short id', () => {
  expect(['claude:a1b2c3d4', 'claude:reset-mon08', 'codex:machine-local', 'codex:ffeeddcc-2'].map(defaultAccountName))
    .toEqual(['Claude a1b2', 'Claude mon08', 'Codex local', 'Codex ffee'])
})
