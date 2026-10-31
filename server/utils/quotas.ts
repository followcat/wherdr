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
// in the header (session_meta) of its conversations, never from auth.json.
// Codex's week may be reset early: without a turn since, its conversations
// still carry the old window; a `/status` read on one of the machine's Codex
// screens then corrects the gauge, and stays known after that screen is gone
// (KnownWeek, codexWeekWindow).
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AccountQuota, ClaudeSetup, ClaudeSetupState, Quota, QuotaWindow, Quotas } from '../../shared/types'
import { readDismissed } from './claudeSetup'
import type { ExecResult, MachineFs } from './fsx'
import { HerdrError } from './herdr'
import { allMachines, type Machine } from './machines'
import { fmt } from '../../shared/message'
import { type KnownWeek, type WeekReading, codexWeekWindow } from '../../shared/codexStatus'

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

// Last `rate_limits` line of a Codex conversation (read from the end).
export function lastCodexLimits(text: string): { rl: Json, at: number } | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.includes('"rate_limits"')) continue
    try {
      const d = JSON.parse(l)
      const rl = d.payload && d.payload.rate_limits
      if (rl && (rl.primary || rl.secondary)) return { rl, at: Date.parse(d.timestamp) || 0 }
    } catch { /* cut line */ }
  }
  return null
}

async function ls(fs: MachineFs, d: string) {
  try { return await fs.readdir(d) }
  catch { return [] }
}

// Claude reading of a machine, with its account fingerprint if known.
export type ClaudeReading = Quota & { account: string | null }
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
// a fingerprint (failing that, its first reading).
export function groupAccounts(list: { key: string, label: string, q: ClaudeReading }[], same = sameAccount): AccountQuota[] {
  const groups: { rep: ClaudeReading, best: ClaudeReading, machines: { key: string, label: string }[] }[] = []
  for (const { key, label, q } of list) {
    const g = groups.find(g => same(g.rep, q))
    if (!g) { groups.push({ rep: q, best: q, machines: [{ key, label }] }); continue }
    g.machines.push({ key, label })
    if (q.at > g.best.at) g.best = q
    if (!g.rep.account && q.account) g.rep = q
  }
  return groups.map(({ best: { account: _, ...q }, machines }) => ({ ...q, machines }))
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
  const pick = (k: 'five' | 'week') => latestWindow(readings.flatMap(r => (r.q[k] ? [{ w: r.q[k]!, stamp: r.stamp }] : [])))
  return quota(pick('five'), pick('week'), Math.max(...readings.map(r => r.q.at)))
}

// Codex account fingerprint of a conversation: `creator_account_id` of its
// first line (session_meta). Only a truncated hash comes out, never the value.
export function codexAccount(head: string): string | null {
  const first = head.split('\n', 1)[0] || ''
  if (!first.includes('"session_meta"')) return null
  const m = /"creator_account_id"\s*:\s*"([^"\\]{1,200})"/.exec(first)
  return m ? crypto.createHash('sha256').update(`wherdr:${m[1]}`).digest('hex').slice(0, 16) : null
}

// Codex quota of a machine: that of the account of the most recent conversation
// (readings without a fingerprint included: old Codex).
export function machineCodexQuota(readings: CodexReading[]): CodexAccountReading | null {
  if (!readings.length) return null
  const newest = readings.reduce((a, b) => (b.stamp > a.stamp ? b : a))
  const account = newest.account ?? readings.find(r => r.account)?.account ?? null
  const q = latestCodexQuota(readings.filter(r => !r.account || !account || r.account === account))
  return q ? { ...q, account } : null
}

export type CodexAccountReading = ClaudeReading

async function readHead(fs: MachineFs, f: string, size: number): Promise<string> {
  for (const max of [64 * 1024, 512 * 1024]) {
    const len = Math.min(size, max)
    const t = (await fs.read(f, 0, len)).toString('utf8')
    if (t.includes('\n') || len === size) return t
  }
  return ''
}

export async function readCodex(fs: MachineFs, home: string): Promise<CodexAccountReading | null> {
  const root = path.posix.join(home, '.codex/sessions')
  const files: string[] = []
  const now = new Date()
  for (let back = 0; back < 3; back++) {
    const d = new Date(now.getTime() - back * 86400000)
    const dir = path.posix.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    for (const n of await ls(fs, dir)) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.push(path.posix.join(dir, n))
  }
  if (!files.length) return null
  const st = await fs.statMany(files)
  const recent = files.map((f, i) => ({ f, s: st[i] })).filter(x => x.s && x.s.isFile)
    .sort((a, b) => b.s!.mtimeMs - a.s!.mtimeMs).slice(0, 6)
  // End of each file: 64 KiB is usually enough (one token_count per
  // reply), 512 KiB at most if nothing is there.
  const readings = await Promise.all(recent.map(async ({ f, s }) => {
    for (const max of [64 * 1024, 512 * 1024]) {
      const len = Math.min(s!.size, max)
      try {
        const hit = lastCodexLimits((await fs.read(f, s!.size - len, len)).toString('utf8'))
        const q = hit && codexQuota(hit.rl, hit.at || s!.mtimeMs)
        if (q) return { q, stamp: hit!.at, account: codexAccount(await readHead(fs, f, s!.size).catch(() => '')) }
      } catch { return null /* unreadable file */ }
      if (len === s!.size) break
    }
    return null
  }))
  return machineCodexQuota(readings.filter(Boolean) as CodexReading[])
}

// Codex gauge of a machine checked against the latest weekly window known
// for it (see codexWeekWindow): a later window (early reset seen by
// `/status`) replaces the week; the same window keeps the higher usage; an
// earlier one is ignored. The 5-hour window and the reading's age stay those
// of the conversations.
export function applyCodexKnown<Q extends Quota & { account?: string | null }>(q: Q, known: KnownWeek | null | undefined, now: number): Q {
  if (!known || !q.week) return q
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

// Codex: only fingerprints separate accounts (without a fingerprint, same
// account: previous display, the most recent reading wins).
export const sameCodexAccount = (a: ClaudeReading, b: ClaudeReading) => !a.account || !b.account || a.account === b.account

// Assembles the readings of the online machines (in machine order).
export function mergeQuotas(readings: { key: string, label: string, claude: ClaudeReading | null, codex: (Quota & { account?: string | null }) | null, setup?: ClaudeSetup | null }[]): Quotas {
  let codex: Quota | null = null
  for (const r of readings) {
    if (!r.codex) continue
    const { account: _, ...q } = r.codex
    codex = fresher(codex, q)
  }
  const codexAccounts = groupAccounts(readings.flatMap(r => (r.codex ? [{ key: r.key, label: r.label, q: { ...r.codex, account: r.codex.account ?? null } }] : [])), sameCodexAccount)
  const accounts = groupAccounts(readings.flatMap(r => (r.claude ? [{ key: r.key, label: r.label, q: r.claude }] : [])))
  let claude: Quota | null = null
  for (const { machines: _, ...a } of accounts) claude = fresher(claude, a)
  // A machine on API billing has no quota block: the subscription account(s)
  // then go under their own machines, so they are listed with them.
  const api = readings.some(r => r.setup?.state === 'api')
  const out: Quotas = accounts.length > 1 || (api && accounts.length) ? { claude, codex, claudeAccounts: accounts } : { claude, codex }
  if (codexAccounts.length > 1) out.codexAccounts = codexAccounts
  const setup = readings.flatMap(r => (r.setup ? [r.setup] : []))
  if (setup.length) out.claudeSetup = setup
  return out
}

async function canInstall(m: Machine): Promise<boolean> {
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
async function readMachineClaude(m: Machine): Promise<ClaudeMachineReading | null> {
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

// Last successful Codex reading of each machine. Claude cannot reuse an old
// identity after a failed read: the machine may have changed accounts meanwhile.
const lastRead = new Map<string, { codex?: CodexAccountReading | null }>()

export async function readQuotas(force = false): Promise<Quotas> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.q
  const version = ++readVersion
  const online = allMachines().filter(m => m.home && !m.info().baseKey && (m.local || m.status === 'online'))
  const dismissed = readDismissed()
  const readings = await Promise.all(online.map(async (m) => {
    const last = lastRead.get(m.key) || {}
    const [claude, rolled] = await Promise.all([
      readMachineClaude(m),
      readCodex(m.fs, m.home).then((r) => { last.codex = r; return r }, () => last.codex ?? null),
    ])
    lastRead.set(m.key, last)
    const week = rolled?.week ? { used: rolled.week.used, resetsAt: rolled.week.resetsAt, at: rolled.at, account: rolled.account } : null
    const known = knownWeek ? await knownWeek(m.key, week).catch(() => null) : null
    const codex = rolled && applyCodexKnown(rolled, known, Date.now())
    // Every machine read gets its state (Settings lists them all); a failed
    // read gets none, so it never looks "not set up".
    const state = claude?.setup
    const setup: ClaudeSetup | null = state
      ? { key: m.key, state, installable: await canInstall(m), ...(dismissed.has(m.key) ? { dismissed: true } : {}) }
      : null
    return { key: m.key, label: m.label, claude: claude?.q || null, codex, setup }
  }))
  const q = mergeQuotas(readings)
  // A slow older poll must not replace a newer completed snapshot.
  if (version === readVersion) cache = { at: Date.now(), q }
  return q
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
export async function installClaudeStatusline(m: Machine): Promise<string> {
  if (!m.local && m.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
  if (!(await canInstall(m))) throw new HerdrError('read_only', fmt('Home folder is read-only here: copy the command and paste it into a terminal on {machine}', { machine: m.label }))
  const script = await installerScript()
  const r = m.local ? await runLocal(script, m.home) : await m.exec!('exec sh -s', [], { input: Buffer.from(script), timeoutMs: 60000 })
  const last = (s: string) => (s.trim().split('\n').filter(Boolean).pop() || '').slice(0, 300)
  if (r.code !== 0) throw new HerdrError('install_failed', fmt('Install failed on {machine}: {reason}', { machine: m.label, reason: last(r.stderr) || `code ${r.code}` }))
  forgetQuotas()
  return last(r.stdout.toString('utf8'))
}
