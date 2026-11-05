import type { AgentStatus } from './types'
import { cleanTitle } from './paneTitle'
// Deliberately independent of legacy panes, desktop layouts and conversation IDs.
export interface CoreTerminal {
  agent?: string | null
  argv?: string[]
  foreground?: { argv: string[]; name?: string; cwd?: string } | null
  address: string
  name?: string | null
  title?: string
  template?: string | null
  cwd: string
  state: string
  reason?: string | null
  status?: { state: string; app?: string; msg?: string } | null
  // Shared with herdr-app: herdr.space / herdr.tab place the terminal (shared/coreLayout.ts).
  labels?: Record<string, string>
  // Completed turns (`herdr.seen` is compared to it), and when the status last changed (ms).
  turn?: number
  status_ms?: number | null
  // The terminal that started this one (a sub-agent has a parent).
  parent?: string | null
  keep?: boolean
  cols?: number
  rows?: number
}
export interface CoreInventory {
  terminals: CoreTerminal[]
  machines: { name: string; state: string }[]
  hidden_finished: number
}
export function coreActivity(terminal: CoreTerminal): AgentStatus | 'error' {
  const state = terminal.status?.state
  return state && ['idle', 'working', 'blocked', 'done', 'error'].includes(state) ? state as AgentStatus | 'error' : 'unknown'
}
// Name chosen in an interface (herdr-app's `herdr.title` label), else the name given at creation.
export const TITLE_LABEL = 'herdr.title'
export const SEEN_LABEL = 'herdr.seen'
// A name that only repeats the address ("t2" for "box/t2") is no name.
export const addressOnly = (name: string | null | undefined, address: string | null | undefined) =>
  Boolean(name && address && [address, address.split('/').pop()].includes(name.trim()))
export const ownTitle = (terminal: Pick<CoreTerminal, 'name' | 'labels' | 'address'>) => {
  const name = terminal.labels?.[TITLE_LABEL]?.trim() || terminal.name?.trim() || null
  return name && !addressOnly(name, terminal.address) ? name : null
}
export function coreTitle(terminal: CoreTerminal) {
  return ownTitle(terminal) || cleanTitle(terminal.title) || terminal.cwd?.split('/').filter(Boolean).pop() || terminal.address
}
// herdr-app's contract: `herdr.seen` holds the last turn somebody looked at. A terminal that
// never got the label is not tracked (absent is not 0): it is never unread.
export function seenTurn(terminal: Pick<CoreTerminal, 'labels'>): number | null {
  const raw = terminal.labels?.[SEEN_LABEL]
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}
export function coreUnread(terminal: Pick<CoreTerminal, 'labels' | 'turn'>): boolean {
  const seen = seenTurn(terminal)
  return seen !== null && (terminal.turn ?? 0) > seen
}
// Label value to write for read / unread, or null when nothing needs writing
// (seen only moves up; "unread" is one turn behind, never below 0).
export function seenUpdate(terminal: Pick<CoreTerminal, 'labels' | 'turn'>, read: boolean): string | null {
  const turn = terminal.turn ?? 0
  const seen = seenTurn(terminal)
  if (read) return seen !== null && seen >= turn ? null : String(turn)
  return turn <= 0 || (seen !== null && seen < turn) ? null : String(turn - 1)
}
