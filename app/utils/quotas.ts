// Home quotas, split between the top of the list and the machines. Pure, without Vue.
//  - An account shared by all online machines (Codex, or a single Claude
//    account): once at the top, as before.
//  - Different accounts (Claude or Codex): each machine has the table of its
//    account under its header (collapsed with it), nothing left of that agent at the top.
import type { ClaudeSetup, Quota, QuotaWindow, Quotas } from '../../shared/types'
import installer from '../../scripts/install-claude-statusline.sh?raw'

export interface QuotaRow { key: string, agent: 'claude' | 'codex', q: Quota }

// Machines whose Claude Code runs on API billing (usage without quota).
const claudeApiKeys = (q: Quotas) => (q.claudeSetup || []).filter(s => s.state === 'api').map(s => s.key)
// Claude shown under each machine: several accounts, or a subscription account
// next to machines on API billing.
function claudeSplit(q: Quotas) {
  const n = q.claudeAccounts?.length || 0
  return n > 1 || (n > 0 && claudeApiKeys(q).length > 0)
}

// "Claude · API usage, no quota" label instead of gauges: at the top (`key`
// null) when every machine read with a Claude reading is on API billing,
// under a machine when it is the API one among subscription machines.
export function claudeApiShown(q: Quotas | null, key: string | null, hidden: readonly string[] = []): boolean {
  if (!q || hidden.includes('claude')) return false
  const api = claudeApiKeys(q)
  if (!api.length) return false
  return key === null ? !q.claude : claudeSplit(q) && api.includes(key)
}

// Rows at the top of the home screen.
export function quotaRows(q: Quotas | null, hidden: readonly string[] = []): QuotaRow[] {
  if (!q) return []
  const rows: QuotaRow[] = []
  if (q.claude && !hidden.includes('claude') && !claudeSplit(q)) rows.push({ key: 'claude', agent: 'claude', q: q.claude })
  if (q.codex && !hidden.includes('codex') && !((q.codexAccounts?.length || 0) > 1)) rows.push({ key: 'codex', agent: 'codex', q: q.codex })
  return rows
}

// Rows specific to a machine (key '' = local): its Claude account, its Codex
// account, each only when the machines do not use the same one.
export function machineQuotaRows(q: Quotas | null, key: string, hidden: readonly string[] = []): QuotaRow[] {
  if (!q) return []
  const rows: QuotaRow[] = []
  for (const agent of ['claude', 'codex'] as const) {
    const list = agent === 'claude' ? q.claudeAccounts : q.codexAccounts
    if (hidden.includes(agent) || !(agent === 'claude' ? claudeSplit(q) : (list?.length || 0) > 1)) continue
    const a = list!.find(a => a.machines.some(m => m.key === key))
    if (!a) continue
    const { machines: _, ...quota } = a
    rows.push({ key: `${agent}:${key}`, agent, q: quota })
  }
  return rows
}

// A machine bar tab showing one machine: the shared rows and that machine's
// own rows together, Claude first, then Codex.
export function tabQuotaRows(top: readonly QuotaRow[], machine: readonly QuotaRow[]): QuotaRow[] {
  return (['claude', 'codex'] as const).flatMap(agent => [...top, ...machine].filter(r => r.agent === agent))
}

// Claude quota status line of a machine (key '' = local), as the server read it.
export function claudeSetupOf(q: Quotas | null, key: string): ClaudeSetup | null {
  return q?.claudeSetup?.find(s => s.key === key) || null
}

// Something to offer for a machine with Claude: install (`missing`) or update
// (`outdated`), unless declined or skipped. Never a block in the home list:
// an item of the machine's "…" menu and a step of the setup guide.
export function claudeSuggestion(q: Quotas | null, key: string, hasClaude: boolean, hidden: readonly string[] = []): ClaudeSetup | null {
  if (!hasClaude || hidden.includes('claude')) return null
  const s = claudeSetupOf(q, key)
  return s && (s.state === 'missing' || s.state === 'outdated') && !s.dismissed ? s : null
}

// Self-contained command to paste into a terminal on the machine: the install
// script (status line included) passed to sh, identical everywhere.
export const claudeInstallCommand = `sh <<'WHERDR_INSTALL'\n${installer.trimEnd()}\nWHERDR_INSTALL\n`

// Remaining share (%); window already reset since the reading: everything is back.
export function quotaLeft(w: QuotaWindow, now: number) {
  if (w.resetsAt && w.resetsAt <= now) return 100
  return Math.round(100 - w.used)
}
// Settings → Appearance → Quotas: remaining share (default, like Codex) or used
// share (like Claude, 100 % for an exhausted window).
export type QuotaDisplay = 'left' | 'used'
export function readQuotaDisplay(raw: string | null): QuotaDisplay {
  return raw === 'used' ? 'used' : 'left'
}
// Percentage shown (number and bar); the alert (`quotaLevel`) always follows
// what remains.
export function quotaShown(w: QuotaWindow, now: number, display: QuotaDisplay) {
  const l = quotaLeft(w, now)
  return display === 'used' ? 100 - l : l
}
export const quotaLevel = (w: QuotaWindow, now: number) => {
  const l = quotaLeft(w, now)
  return l <= 15 ? 'hi' : l <= 40 ? 'mid' : 'lo'
}

// Reading older than an hour: numbers to take with caution.
export const STALE_MS = 3600000

// Reset time: the time alone within the next 24 h (even the
// next day: "00:00" and not "Sun 00:00", which looks like the weekly one),
// with the day beyond that. `null`: already reset; '': unknown.
export function resetText(w: QuotaWindow, now: number, locale: string): string | null {
  if (!w.resetsAt) return ''
  if (w.resetsAt <= now) return null
  const d = new Date(w.resetsAt)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return w.resetsAt - now < 86400000 ? time : `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
}

// Machines listed in Settings › Agents › Claude quotas and the setup guide:
// those where Claude is installed, and those whose status line was found
// anyway. `setup` null: not read (offline, read failed, not loaded yet).
export interface ClaudeSetupRow { key: string, name: string, online: boolean, setup: ClaudeSetup | null }
export function claudeSetupRows(q: Quotas | null, machines: readonly { key: string, name: string, online: boolean, kinds: readonly string[] }[]): ClaudeSetupRow[] {
  return machines.flatMap((m) => {
    const setup = m.online ? claudeSetupOf(q, m.key) : null
    if (!m.kinds.includes('claude') && (!setup || setup.state === 'missing')) return []
    return [{ key: m.key, name: m.name, online: m.online, setup }]
  })
}
