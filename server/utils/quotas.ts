// Usage quotas of the Claude and Codex accounts, for the home screen. Passive
// reading, without typing anything into the agents:
//  - Codex writes its limits into its conversations (token_count event,
//    `rate_limits`: 5-hour window and week);
//  - Claude Code gives them to its status line; an invisible status line
//    (installed by scripts/install-claude-statusline.sh, see installClaudeStatusline)
//    keeps them in ~/.cache/herdr-web/claude-status.json.
// Quotas apply to the whole account: across several machines, we keep the
// most recent reading of each account. Claude: the status line also keeps
// an account fingerprint (claude-account, truncated hash of its identifier, never
// the identifier itself); machines on different accounts then each get
// their own block (claudeAccounts), shown under their machine by the app.
// Codex: same principle (codexAccounts), fingerprint taken from `creator_account_id`
// in the header (session_meta) of its conversations, never from auth.json;
// without one, only identical 5-hour and weekly windows join machines, or the
// same week and the machine's last known fingerprint when a 5-hour window
// ended (sameCodexAccount, CodexMemo).
// Codex's week may be reset early: without a turn since, its conversations
// still carry the old window; a `/status` read on one of the machine's Codex
// screens then corrects the gauge, and stays known after that screen is gone
// (KnownWeek, codexWeekWindow).
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AccountQuota, ClaudeSetup, ClaudeSetupState, Quota, QuotaAccount, QuotaCredits, QuotaWindow, Quotas } from '../../shared/types'
import { type QuotaProgram, accountKey, uniqueKey } from '../../shared/quotaAccount'
import { type PacingEntry, pacingEntry } from '../../shared/pacingLog'
import { readAccountNames } from './accountNames'
import { recordReadings } from './pacingLog'
import { readDismissed } from './claudeSetup'
import type { ExecResult, MachineFs } from './fsx'
import { HerdrError } from './herdr'
import type { Machine } from './machines'
import { coreQuotaMachines } from './coreQuotaMachines'
import { fmt } from '../../shared/message'
import { type KnownWeek, type WeekReading, codexWeekWindow } from '../../shared/codexStatus'

// What a quota reading needs of a machine (core's machines, coreQuotaMachines.ts).
export type QuotaMachine = Pick<Machine, 'key' | 'label' | 'local' | 'status' | 'home' | 'fs' | 'exec'>

// Lazy: coreAdminDeps reaches state.ts, which itself registers into this module.
const coreMachines = async () => coreQuotaMachines((await import('./coreAdminDeps')).coreAdminDeps())

const TTL = 30000
let cache: { at: number, q: Quotas } | null = null
let readVersion = 0

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const win = (used: unknown, resets: unknown, minutes: number): QuotaWindow | null => {
  const u = Number(used)
  if (!Number.isFinite(u)) return null
  return { used: Math.max(0, Math.min(100, u)), resetsAt: Number(resets) ? Number(resets) * 1000 : null, minutes }
}

// Impossible reset time (further than the window duration
// after the reading, give or take 10 min: wrong field, clock): unknown rather
// than a misleading date.
function plausible(w: QuotaWindow | null, at: number): QuotaWindow | null {
  if (!w || !w.resetsAt || !w.minutes || !at) return w
  return w.resetsAt > at + (w.minutes + 10) * 60000 ? { ...w, resetsAt: null } : w
}
const quota = (five: QuotaWindow | null, week: QuotaWindow | null, at: number): Quota | null =>
  five || week ? { five: plausible(five, at), week: plausible(week, at), at } : null

export function claudeQuota(status: Json, at: number): Quota | null {
  const r = status && status.rate_limits
  if (!r) return null
  // Right after a window ends (5 h or week), Claude only passes
  // the other one: a new window starts, nothing is used in it yet.
  const five = r.five_hour ? win(r.five_hour.used_percentage, r.five_hour.resets_at, 300) : null
  const week = r.seven_day ? win(r.seven_day.used_percentage, r.seven_day.resets_at, 10080) : null
  const fresh = (minutes: number): QuotaWindow => ({ used: 0, resetsAt: null, minutes, fresh: true })
  if (five && !week) return quota(five, fresh(10080), at)
  if (week && !five) return quota(fresh(300), week, at)
  return quota(five, week, at)
}

// Codex, for its part, does not omit a restarting window (it gives it at 0 %): a missing
// window is not part of the plan (Plus: week only; free: 30 days).
export function codexQuota(rl: Json, at: number): Quota | null {
  if (!rl) return null
  const pick = (w: Json | null | undefined) => (w ? win(w.used_percent, w.resets_at, Number(w.window_minutes) || 0) : null)
  // primary = short window (5 h), secondary = week; we rely on the duration.
  const ws = [pick(rl.primary), pick(rl.secondary)].filter(Boolean) as QuotaWindow[]
  const five = ws.find(w => w.minutes && w.minutes < 1440) || null
  const week = ws.find(w => w.minutes >= 1440) || null
  return quota(five, week, at)
}

// Reset time written in Codex's "usage limit" message: "try again at 6:37 AM"
// (today or tomorrow) or "try again at Nov 8th, 2026 2:52 PM". Local time of
// the machine running wherdr, which is the one Codex formatted it for in the
// usual case. null if the text carries no readable time.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export function codexLimitReset(message: string, at: number): number | null {
  const m = /try again at\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(message)
  if (!m) return null
  let h = Number(m[4]) % 12
  if (/p/i.test(m[6]!)) h += 12
  const base = new Date(at || Date.now())
  if (m[1]) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    if (mon < 0) return null
    const d = new Date(m[3] ? Number(m[3]) : base.getFullYear(), mon, Number(m[2]), h, Number(m[5]))
    if (!m[3] && d.getTime() <= base.getTime()) d.setFullYear(d.getFullYear() + 1)
    return d.getTime()
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, Number(m[5]))
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// Credits of the account, from `rate_limits.credits` (recent Codex versions:
// `has_credits`, `unlimited`, `balance` as a string): null without any.
export function codexCredits(c: Json | null | undefined): QuotaCredits | null {
  if (!c || !(c.has_credits || c.unlimited)) return null
  const b = c.balance == null || c.balance === '' ? NaN : Number(c.balance)
  return { unlimited: Boolean(c.unlimited), balance: Number.isFinite(b) ? b : null }
}

// Newest limit state of a Codex conversation (read from the end): the last
// `rate_limits` with numbers, or "limit reached" (`limited`): Codex writes no
// numbers then (primary/secondary null, no credits) and only reports the error
// `usage_limit_exceeded` (or sets `rate_limit_reached_type`). Whichever comes
// last wins, so a later reading with numbers brings the gauges back.
// `credits`: those of the newest `rate_limits` (the null one written just
// before the error carries them too).
export type CodexLimits = ({ rl: Json, at: number, limited?: undefined } | { limited: { resetsAt: number | null }, at: number, rl?: undefined }) & { credits?: QuotaCredits }
export function lastCodexLimits(text: string): CodexLimits | null {
  const lines = text.split('\n')
  const hit = lastLimits(lines)
  if (!hit) return null
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"credits"')) continue
    try {
      const rl = JSON.parse(lines[i]!).payload?.rate_limits
      if (!rl || !('credits' in rl)) continue
      const credits = codexCredits(rl.credits)
      return credits ? { ...hit, credits } : hit
    } catch { /* cut line */ }
  }
  return hit
}
function lastLimits(lines: string[]): CodexLimits | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    const reached = l.includes('usage_limit_exceeded')
    if (!reached && !l.includes('"rate_limits"')) continue
    try {
      const d = JSON.parse(l)
      const at = Date.parse(d.timestamp) || 0
      const p = d.payload
      if (reached) {
        const e = p && p.error
        if (e && e.codex_error_info === 'usage_limit_exceeded') return { limited: { resetsAt: codexLimitReset(String(e.message || ''), at) }, at }
        continue
      }
      const rl = p && p.rate_limits
      if (!rl || !(rl.primary || rl.secondary)) continue
      if (rl.rate_limit_reached_type) {
        const resets = [rl.primary, rl.secondary].flatMap(w => (w && Number(w.used_percent) >= 100 && Number(w.resets_at) ? [Number(w.resets_at) * 1000] : []))
        return { limited: { resetsAt: resets.length ? Math.max(...resets) : null }, at }
      }
      return { rl, at }
    } catch { /* cut line */ }
  }
  return null
}

async function ls(fs: MachineFs, d: string) {
  try { return await fs.readdir(d) }
  catch { return [] }
}

// Claude reading of a machine, with its account fingerprint if known.
// `lastAccount` (Codex only): the machine's last fingerprint seen, kept across
// refreshes (CodexMemo). It is only evidence for sameCodexAccount, never the
// reading's identity, and never leaves the server.
export type ClaudeReading = Quota & { account: string | null, lastAccount?: string | null }
export interface ClaudeMachineReading { q: ClaudeReading | null, setup: ClaudeSetupState }

// Snapshot of the current status line (identity and time bound to it) taken
// without rate limits: the status line keeps one only after an API response
// that carried none, so Claude Code runs on API billing (API key, Console
// credits): usage without quota. Gateway spend limits come inside rate_limits.
export function claudeApiBilling(status: Json | null): boolean {
  return Boolean(status && typeof status === 'object' && status._wherdr?.version === 1 && !('rate_limits' in status))
}

// Marker of a status line that keeps API-billing snapshots.
const API_AWARE = 'total_api_duration_ms'

// wherdr's status line set up on a machine? `api`: a current snapshot without
// rate limits (API billing, see claudeApiBilling). `ok`: complete reading
// (quotas + fingerprint), or an older snapshot without quotas. `pending`: the
// up-to-date status line (with fingerprint) is wired in settings.json, the
// quotas will come with the next exchange. `outdated`: a status file is there
// (the quotas show) but written by an older status line, or an older status
// line that never wrote one (it would miss API billing): an update is offered,
// never "not set up". `missing`: nothing at all.
export function claudeSetupState(f: { status: Json | null, account: boolean, statusline: string | null, settings: string | null }): ClaudeSetupState {
  if (claudeApiBilling(f.status)) return 'api'
  if (f.status && (!f.status.rate_limits || f.account)) return 'ok'
  const wired = Boolean(f.statusline?.includes('claude-account') && f.settings?.includes('wherdr-statusline.sh'))
  if (wired && f.status) return 'ok' // up to date, but no readable fingerprint: nothing more to do
  if (wired) return f.statusline!.includes(API_AWARE) ? 'pending' : 'outdated'
  return f.status ? 'outdated' : 'missing'
}

// A file that is absent reads as null; any other failure (refused SSH session,
// timeout) throws, so that an unreadable machine never looks "not set up".
export async function readClaude(fs: MachineFs, home: string): Promise<ClaudeMachineReading> {
  const dir = path.posix.join(home, '.cache/herdr-web')
  const f = path.posix.join(dir, 'claude-status.json')
  const text = (p: string) => fs.readFile(p).catch((e: { code?: string }) => {
    if (e?.code === 'ENOENT') return null
    throw e
  })
  let status: Json | null = null
  let at = 0
  const st = (await fs.statMany([f]))[0]
  if (st) {
    at = st.mtimeMs
    const raw = await text(f)
    try { status = raw === null ? null : JSON.parse(raw) } catch { status = null }
  }
  // New writers bind identity and observation time to the same atomic payload.
  // In particular, an explicit unknown identity must not reuse a stale sidecar.
  const bound = status?._wherdr?.version === 1
  const fingerprint = bound ? status!._wherdr.account : (await text(path.posix.join(dir, 'claude-account')))?.trim() || ''
  const account = typeof fingerprint === 'string' && /^[0-9a-f]{16,64}$/.test(fingerprint) ? fingerprint : null
  if (bound && Number.isFinite(status!._wherdr.at) && status!._wherdr.at > 0) at = status!._wherdr.at
  let setup = claudeSetupState(status && account
    ? { status, account: true, statusline: null, settings: null }
    : {
        status, account: Boolean(account),
        statusline: await text(path.posix.join(home, '.claude/wherdr-statusline.sh')),
        settings: await text(path.posix.join(home, '.claude/settings.json')),
      })
  // Legacy snapshots remain readable, but offer an update to remove the old
  // ten-minute identity cache and separate-file race on every machine. Their
  // quotas still show: `outdated`, not `missing` (which reads "not set up").
  if (status && !bound && setup === 'ok') {
    const script = await text(path.posix.join(home, '.claude/wherdr-statusline.sh'))
    if (!script?.includes('_wherdr')) setup = 'outdated'
  }
  const q = status ? claudeQuota(status, at) : null
  return { q: q ? { ...q, account } : null, setup }
}

// Same account? Known fingerprints never merge with unknown identities. Otherwise the weekly
// reset time, fixed for an account (compared modulo one
// week, as an old reading may date from a previous week); with
// nothing comparable, we assume the same account (previous display).
const WEEK_MS = 7 * 86400000
export function sameAccount(a: ClaudeReading, b: ClaudeReading): boolean {
  if (a.account || b.account) return a.account === b.account
  const x = a.week?.resetsAt
  const y = b.week?.resetsAt
  if (!x || !y) return true
  const d = (((x - y) % WEEK_MS) + WEEK_MS) % WEEK_MS
  return Math.min(d, WEEK_MS - d) <= 5 * 60000
}

// Groups the readings by account: the most recent of each account, with its
// machines in the order received. The group is compared with its first reading that has
// a fingerprint (failing that, its first reading). Each group gets its stable
// key (shared/quotaAccount.ts); the fingerprint itself never leaves.
// The key takes a member's last known fingerprint when none has a current one,
// so a fingerprint flickering on one machine does not flip it to `reset-…`.
export function groupAccounts(list: { key: string, label: string, q: ClaudeReading }[], same: (a: ClaudeReading, b: ClaudeReading) => boolean = sameAccount, program: QuotaProgram = 'claude'): AccountQuota[] {
  const groups: { rep: ClaudeReading, best: ClaudeReading, last: string | null, machines: { key: string, label: string }[] }[] = []
  for (const { key, label, q } of list) {
    const g = groups.find(g => same(g.rep, q))
    if (!g) { groups.push({ rep: q, best: q, last: q.lastAccount ?? null, machines: [{ key, label }] }); continue }
    g.machines.push({ key, label })
    if (q.at > g.best.at) g.best = q
    if (!g.rep.account && q.account) g.rep = q
    g.last ??= q.lastAccount ?? null
  }
  const taken = new Set<string>()
  return groups.map(({ rep, last, best: { account: _, lastAccount: _l, ...q }, machines }) => ({
    ...q, machines, key: uniqueKey(accountKey(program, rep.account ?? last, rep.week ?? q.week, machines[0]!.key), taken),
  }))
}

// Several Codex conversations write the limits of the same account: an old
// file still being modified may carry an old value. We keep, per window,
// the most recent reading (line timestamp, 0 if missing); within the
// same window (same reset time, give or take a few minutes: it
// is recomputed on each reply), usage can only grow: the highest.
export type CodexReading = { q: Quota, stamp: number, account?: string | null }
const SAME_WINDOW = 10 * 60000
function latestWindow(list: { w: QuotaWindow, stamp: number }[]): QuotaWindow | null {
  if (!list.length) return null
  const ref = list.reduce((a, b) => {
    if (b.stamp !== a.stamp) return b.stamp > a.stamp ? b : a
    const d = (b.w.resetsAt || 0) - (a.w.resetsAt || 0)
    return d > SAME_WINDOW || (Math.abs(d) <= SAME_WINDOW && b.w.used > a.w.used) ? b : a
  })
  const r = ref.w.resetsAt
  let used = ref.w.used
  for (const { w } of list) if (r && w.resetsAt && Math.abs(w.resetsAt - r) <= SAME_WINDOW) used = Math.max(used, w.used)
  return { ...ref.w, used }
}
export function latestCodexQuota(readings: CodexReading[]): Quota | null {
  if (!readings.length) return null
  // "Limit reached" holds until a reading with numbers comes after it.
  const limits = readings.filter(r => r.q.limited)
  if (limits.length) {
    const last = limits.reduce((a, b) => (b.stamp > a.stamp ? b : a))
    if (!readings.some(r => !r.q.limited && r.stamp >= last.stamp)) return last.q
    readings = readings.filter(r => !r.q.limited)
  }
  const pick = (k: 'five' | 'week') => latestWindow(readings.flatMap(r => (r.q[k] ? [{ w: r.q[k]!, stamp: r.stamp }] : [])))
  const q = quota(pick('five'), pick('week'), Math.max(...readings.map(r => r.q.at)))
  const credits = readings.reduce((a, b) => (b.stamp > a.stamp ? b : a)).q.credits
  return q && credits ? { ...q, credits } : q
}

// Codex account fingerprint of a conversation: `creator_account_id` of its
// first line (session_meta), the only account field Codex writes in its files
// (rate_limits carry none). Codex sets it when a thread is created with a
// ChatGPT login; older Codex versions, API-key logins and threads created before
// the field existed have none. Only a truncated hash comes out, never the value.
export function codexAccount(head: string): string | null {
  const first = head.split('\n', 1)[0] || ''
  if (!first.includes('"session_meta"')) return null
  const m = /"creator_account_id"\s*:\s*"([^"\\]{1,200})"/.exec(first)
  return m ? crypto.createHash('sha256').update(`wherdr:${m[1]}`).digest('hex').slice(0, 16) : null
}

// Codex quota of a machine: that of the account of the most recent conversation
// Unknown identities cannot inherit an older account or combine conversations.
type CodexSessionReading = Omit<CodexReading, 'q'> & { q: Quota | null }
export function machineCodexQuota(readings: CodexSessionReading[]): CodexAccountReading | null {
  if (!readings.length) return null
  const newest = readings.reduce((a, b) => (b.stamp > a.stamp ? b : a))
  const account = newest.account ?? null
  const selected = readings.filter(r => account ? r.account === account : r === newest)
  const q = latestCodexQuota(selected.filter((r): r is CodexReading => r.q !== null))
  return q ? { ...q, account } : null
}

export type CodexAccountReading = ClaudeReading

// Start of a conversation file, up to its first line break. A session_meta
// line longer than 512 KiB (large base instructions or tool list) comes back
// cut: its account and timestamp come first, so they stay readable.
async function readHead(fs: MachineFs, f: string, size: number): Promise<string> {
  let t = ''
  for (const max of [64 * 1024, 512 * 1024]) {
    const len = Math.min(size, max)
    t = (await fs.read(f, 0, len)).toString('utf8')
    if (t.includes('\n') || len === size) return t
  }
  return t
}

// Start time of a conversation (session_meta `timestamp`), 0 if unknown. The
// line may be cut (see readHead): then read from its first characters.
export function codexSessionStart(head: string): number {
  const first = head.split('\n', 1)[0] || ''
  try {
    const meta = JSON.parse(first)
    return meta?.type === 'session_meta' ? Date.parse(meta.timestamp) || 0 : 0
  } catch { /* cut or unknown line */ }
  const m = /^\{"timestamp":"([^"\\]{1,40})","type":"session_meta"/.exec(first)
  return m ? Date.parse(m[1]!) || 0 : 0
}

// What a machine's earlier reads established, kept between refreshes:
// the fingerprint of each conversation file (its first line never changes, so
// a failed or cut head read keeps it), and the machine's last fingerprint seen
// (`last`, from the newest identified session, with or without limits: a
// switch is remembered before its first limits; `lastStamp` keeps an older
// session from undoing it).
export interface CodexMemo { files: Map<string, string>, last: string | null, lastStamp: number }
const codexMemos = new Map<string, CodexMemo>()
export function codexMemo(machine: string): CodexMemo {
  let m = codexMemos.get(machine)
  if (!m) codexMemos.set(machine, m = { files: new Map(), last: null, lastStamp: 0 })
  return m
}

export async function readCodex(fs: MachineFs, home: string): Promise<CodexAccountReading | null> {
  return (await readCodexMachine(fs, home)).q
}

// Codex reading of a machine, and whether it has recent Codex conversations at
// all (`seen`): a machine with conversations but no reading (a new account's
// first conversation, before its first limits) must not show another
// machine's account as its own.
export async function readCodexMachine(fs: MachineFs, home: string, memo?: CodexMemo): Promise<{ q: CodexAccountReading | null, seen: boolean }> {
  const root = path.posix.join(home, '.codex/sessions')
  const files: string[] = []
  const now = new Date()
  for (let back = 0; back < 3; back++) {
    const d = new Date(now.getTime() - back * 86400000)
    const dir = path.posix.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    for (const n of await ls(fs, dir)) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.push(path.posix.join(dir, n))
  }
  if (!files.length) return { q: null, seen: false }
  const st = await fs.statMany(files)
  const recent = files.map((f, i) => ({ f, s: st[i] })).filter(x => x.s && x.s.isFile)
    .sort((a, b) => b.s!.mtimeMs - a.s!.mtimeMs).slice(0, 6)
  // End of each file: 64 KiB is usually enough (one token_count per
  // reply), 512 KiB at most if nothing is there.
  const readings = await Promise.all(recent.map(async ({ f, s }): Promise<CodexSessionReading> => {
    const head = await readHead(fs, f, s!.size).catch(() => '')
    const account = codexAccount(head) ?? memo?.files.get(f) ?? null
    if (account) memo?.files.set(f, account)
    const started = codexSessionStart(head)
    // Even without limits, a new session can identify an account switch.
    // File time is only a fallback when there is no timestamp in the session.
    const empty = { q: null, account, stamp: started || s!.mtimeMs }
    for (const max of [64 * 1024, 512 * 1024]) {
      const len = Math.min(s!.size, max)
      try {
        const hit = lastCodexLimits((await fs.read(f, s!.size - len, len)).toString('utf8'))
        const read = hit && (hit.limited ? { five: null, week: null, at: hit.at || s!.mtimeMs, limited: hit.limited } : codexQuota(hit.rl, hit.at || s!.mtimeMs))
        const q = read && hit!.credits ? { ...read, credits: hit!.credits } : read
        if (q) return { q, stamp: Math.max(started, hit!.at || s!.mtimeMs), account }
      } catch { return empty /* unreadable file: never reuse an older identity */ }
      if (len === s!.size) break
    }
    return empty
  }))
  const q = machineCodexQuota(readings)
  if (!memo) return { q, seen: true }
  for (const f of memo.files.keys()) if (!recent.some(r => r.f === f)) memo.files.delete(f)
  const identified = readings.reduce<CodexSessionReading | null>((a, b) => (b.account && (!a || b.stamp > a.stamp) ? b : a), null)
  if (identified && identified.stamp >= memo.lastStamp) {
    memo.last = identified.account!
    memo.lastStamp = identified.stamp
  }
  return { q: q && memo.last ? { ...q, lastAccount: memo.last } : q, seen: true }
}

// Codex gauge of a machine checked against the latest weekly window known
// for it (see codexWeekWindow): a later window (early reset seen by
// `/status`) replaces the week; the same window keeps the higher usage; an
// earlier one is ignored. The 5-hour window and the reading's age stay those
// of the conversations.
export function applyCodexKnown<Q extends Quota & { account?: string | null }>(q: Q, known: KnownWeek | null | undefined, now: number): Q {
  if (!known || !q.week || !q.account || q.account !== known.account) return q
  const w = codexWeekWindow({ week: { used: q.week.used, resetsAt: q.week.resetsAt, at: q.at, account: q.account ?? null }, known, now })
  if (!w) return q
  const used = 100 - w.left
  if (w.resetsAt !== q.week.resetsAt) return { ...q, week: plausible({ used, resetsAt: w.resetsAt, minutes: q.week.minutes }, now) }
  return used > q.week.used ? { ...q, week: { ...q.week, used } } : q
}

// Latest weekly window known for a machine (key), given its newest
// conversation reading; provided by the state (server/utils/state.ts), which
// knows the panes and their screens.
type KnownWeekSource = (key: string, rolled: WeekReading | null) => Promise<KnownWeek | null>
let knownWeek: KnownWeekSource | null = null
export function setCodexKnownWeek(f: KnownWeekSource | null) { knownWeek = f }

const fresher = (a: Quota | null, b: Quota | null) => (!a ? b : !b ? a : b.at > a.at ? b : a)

// Codex: two known fingerprints decide alone (equal: same account; different:
// never merged). Without a fingerprint on one side, a reading is only grouped
// with another when both show the same 5-hour AND the same weekly window
// (resets within SAME_RESET of each other), the week already started. Reset
// times come from OpenAI as absolute times, fixed for a window of one account:
// two accounts matching on both windows to the minute is not a coincidence that
// happens. An unused window may report "now + its length", so a week at 0 % is
// not evidence. Anything less (one window missing, different resets, a reading
// left over from before an account switch) keeps each machine on its own row:
// another account's numbers are never shown (WHR-221).
// A machine idle for hours keeps a 5-hour window that ended (past its reset,
// or read longer ago than its length): it no longer tells anything. Then the
// same started week plus the same last known fingerprint (lastAccount) on
// both sides is enough.
const SAME_RESET = 60000
const sameReset = (x: QuotaWindow | null, y: QuotaWindow | null) =>
  Boolean(x?.resetsAt && y?.resetsAt && Math.abs(x.resetsAt - y.resetsAt) <= SAME_RESET)
const stale = (w: QuotaWindow | null, at: number, now: number) =>
  !w?.resetsAt || w.resetsAt <= now || now - at > w.minutes * 60000
export function sameCodexAccount(a: ClaudeReading, b: ClaudeReading, now = Date.now()): boolean {
  if (a.account && b.account) return a.account === b.account
  if (!(sameReset(a.week, b.week) && a.week!.used > 0 && b.week!.used > 0)) return false
  if (sameReset(a.five, b.five)) return true
  if (!stale(a.five, a.at, now) && !stale(b.five, b.at, now)) return false
  const x = a.account ?? a.lastAccount
  return Boolean(x && x === (b.account ?? b.lastAccount))
}

// Assembles the readings of the online machines (in machine order).
// `codexSeen: false`: the machine has no recent Codex conversation (missing:
// unknown, as after a failed read).
// `names`: the user's account names, by key (accountNames.ts).
export function mergeQuotas(readings: { key: string, label: string, claude: ClaudeReading | null, codex: (Quota & { account?: string | null, lastAccount?: string | null }) | null, codexSeen?: boolean, setup?: ClaudeSetup | null }[], names: Record<string, string> = {}): Quotas {
  let codex: Quota | null = null
  for (const r of readings) {
    if (!r.codex) continue
    const { account: _, lastAccount: _l, ...q } = r.codex
    codex = fresher(codex, q)
  }
  const named = (a: AccountQuota): AccountQuota => (names[a.key] ? { ...a, name: names[a.key] } : a)
  const codexAccounts = groupAccounts(readings.flatMap(r => (r.codex ? [{ key: r.key, label: r.label, q: { ...r.codex, account: r.codex.account ?? null } }] : [])), (a, b) => sameCodexAccount(a, b), 'codex').map(named)
  const accounts = groupAccounts(readings.flatMap(r => (r.claude ? [{ key: r.key, label: r.label, q: r.claude }] : []))).map(named)
  let claude: Quota | null = null
  for (const { machines: _, key: _k, name: _n, ...a } of accounts) claude = fresher(claude, a)
  // A machine on API billing has no quota block: the subscription account(s)
  // then go under their own machines, so they are listed with them.
  const api = readings.some(r => r.setup?.state === 'api')
  const out: Quotas = accounts.length > 1 || (api && accounts.length) ? { claude, codex, claudeAccounts: accounts } : { claude, codex }
  // One Codex account at the top, like Claude, once it is established: a known
  // fingerprint, or several machines matched by their windows. A single
  // unidentified reading stays under its machine, and so does everything while
  // a machine with Codex has no reading (account switch waiting for its first
  // limits, failed read): the top row would pass for its account.
  const codexed = readings.filter(r => r.codex)
  const waiting = readings.some(r => !r.codex && r.codexSeen !== false)
  const shared = codexAccounts.length === 1 && !waiting && (codexed.length > 1 || Boolean(codexed[0]?.codex?.account))
  if (codexAccounts.length && !shared) out.codexAccounts = codexAccounts
  const setup = readings.flatMap(r => (r.setup ? [r.setup] : []))
  if (setup.length) out.claudeSetup = setup
  const table = (program: QuotaProgram) => (a: AccountQuota): QuotaAccount => ({ key: a.key, program, ...(a.name ? { name: a.name } : {}), machines: a.machines.map(m => m.key) })
  if (accounts.length || codexAccounts.length) out.accounts = [...accounts.map(table('claude')), ...codexAccounts.map(table('codex'))]
  return out
}

// Pacing log lines of a merge: each account's newest reading.
export function pacingEntries(q: Quotas, readings: Parameters<typeof mergeQuotas>[0]): PacingEntry[] {
  const out: PacingEntry[] = []
  for (const a of q.accounts ?? []) {
    const own = readings.flatMap((r) => {
      const x = a.program === 'claude' ? r.claude : r.codex
      return x && a.machines.includes(r.key) ? [x] : []
    })
    const best = own.reduce<Quota | null>(fresher, null)
    const e = best && pacingEntry(a.key, best)
    if (e) out.push(e)
  }
  return out
}

async function canInstall(m: QuotaMachine): Promise<boolean> {
  if (!m.local) return Boolean(m.exec)
  for (const d of [path.join(m.home, '.claude'), m.home]) {
    try {
      await fs.promises.access(d, fs.constants.W_OK)
      return true
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false }
  }
  return false
}

// A legacy Claude read spans separate SSH requests (status, fingerprint, setup).
// Even after reading a new status file, a later request can fail. Retrying once
// recovers a refused multiplexed session without hiding the machine's gauge.
// Never substitute the last successful reading: that cache had no expiry and
// could mask a newer file indefinitely, independently of the 30-second TTL.
async function readMachineClaude(m: QuotaMachine): Promise<ClaudeMachineReading | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await readClaude(m.fs, m.home) }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      // No account, quota payload or raw SSH diagnostics in logs.
      console.warn(new Date().toISOString(), 'Claude quota read failed', {
        machine: m.key || 'local',
        code: typeof code === 'string' && /^[a-z_0-9]+$/i.test(code) ? code : 'unknown',
        attempt, action: attempt === 1 ? 'retry' : 'discard',
      })
    }
  }
  return null
}

export async function readQuotas(force = false): Promise<Quotas> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.q
  const version = ++readVersion
  const all: QuotaMachine[] = await coreMachines()
  const online = all.filter(m => m.home && (m.local || m.status === 'online'))
  const dismissed = readDismissed()
  const readings = await Promise.all(online.map(async (m) => {
    const [claude, { q: rolled, seen: codexSeen }] = await Promise.all([
      readMachineClaude(m),
      readCodexMachine(m.fs, m.home, codexMemo(m.key)).catch(() => ({ q: null, seen: true })),
    ])
    const week = rolled?.week ? { used: rolled.week.used, resetsAt: rolled.week.resetsAt, at: rolled.at, account: rolled.account } : null
    const known = knownWeek ? await knownWeek(m.key, week).catch(() => null) : null
    const codex = rolled && applyCodexKnown(rolled, known, Date.now())
    // Every machine read gets its state (Settings lists them all); a failed
    // read gets none, so it never looks "not set up".
    const state = claude?.setup
    const setup: ClaudeSetup | null = state
      ? { key: m.key, state, installable: await canInstall(m), ...(dismissed.has(m.key) ? { dismissed: true } : {}) }
      : null
    return { key: m.key, label: m.label, claude: claude?.q || null, codex, codexSeen, setup }
  }))
  const q = mergeQuotas(readings, await readAccountNames())
  // A slow older poll must not replace a newer completed snapshot.
  if (version === readVersion) {
    cache = { at: Date.now(), q }
    await recordReadings(pacingEntries(q, readings)).catch((e: NodeJS.ErrnoException) => {
      console.warn(new Date().toISOString(), 'Pacing log write failed', { code: typeof e?.code === 'string' ? e.code : 'unknown' })
    })
  }
  return q
}

// The machine of a key (install route).
export async function quotaMachine(key: string): Promise<QuotaMachine | undefined> {
  return (await coreMachines()).find(m => m.key === key)
}

// Next read starts afresh (install, suggestion dismissed).
export function forgetQuotas() {
  readVersion++
  cache = null
}

// ---------------------------------------------------------------- installation
// Install script (self-contained, status line included), bundled at build time
// from scripts/ (nitro.serverAssets). Passed on the standard input of `sh -s`:
// never copied into a command line.
async function installerScript(): Promise<string> {
  const raw = await useStorage('assets:scripts').getItemRaw('install-claude-statusline.sh')
  const s = raw ? (typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) : ''
  if (!s.startsWith('#!/bin/sh')) throw new HerdrError('no_script', 'Install script not found')
  return s
}

export function runLocal(input: string, home: string, timeoutMs = 60000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-s'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString('utf8') })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// Installs (or updates) the status line on an online machine; returns the
// last line of the script ("status line added: …", "already installed: …").
export async function installClaudeStatusline(m: QuotaMachine): Promise<string> {
  if (!m.local && m.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
  if (!(await canInstall(m))) throw new HerdrError('read_only', fmt('Home folder is read-only here: copy the command and paste it into a terminal on {machine}', { machine: m.label }))
  const script = await installerScript()
  const r = m.local ? await runLocal(script, m.home) : await m.exec!('exec sh -s', [], { input: Buffer.from(script), timeoutMs: 60000 })
  const last = (s: string) => (s.trim().split('\n').filter(Boolean).pop() || '').slice(0, 300)
  if (r.code !== 0) throw new HerdrError('install_failed', fmt('Install failed on {machine}: {reason}', { machine: m.label, reason: last(r.stderr) || `code ${r.code}` }))
  forgetQuotas()
  return last(r.stdout.toString('utf8'))
}
