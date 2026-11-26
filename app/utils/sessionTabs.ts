// Sessions are a dimension above machines: primary first, then by name. Empty
// non-primary sessions are not offered as tabs.
import type { HerdrState, Pane, SessionInfo } from '../../shared/types'

export interface SessionTab extends SessionInfo { count: number, terminals: number, empty: boolean }

export const paneSessionName = (pane: Pick<Pane, 'session'>, state?: Pick<HerdrState, 'session'> | null): string =>
  pane.session || state?.session || 'default'

export function sessionTabsOf(state: HerdrState | null | undefined): SessionTab[] {
  const sessions = state?.sessions?.length
    ? state.sessions
    : [{ key: '', name: state?.session || 'default', primary: true, status: 'online' as const }]
  const counts = new Map<string, number>()
  const terminals = new Map<string, number>()
  const nonEmpty = new Set<string>()
  for (const pane of state?.panes ?? []) {
    const name = paneSessionName(pane, state)
    nonEmpty.add(name)
    terminals.set(name, (terminals.get(name) ?? 0) + 1)
    if (pane.status === 'blocked' || pane.status === 'done') counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return sessions
    .map(s => ({ ...s, count: counts.get(s.name) ?? 0, terminals: terminals.get(s.name) ?? 0, empty: !nonEmpty.has(s.name) }))
    .filter(s => s.primary || !s.empty)
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
}

export function sessionKeyForName(state: HerdrState | null | undefined, name: string): string {
  return sessionTabsOf(state).find(s => s.name === name)?.key
    ?? state?.sessions?.find(s => s.name === name)?.key
    ?? (state?.session === name ? '' : '')
}

export function sessionKeyOfPane(state: HerdrState | null | undefined, pane: Pick<Pane, 'session'> | null | undefined): string {
  return pane ? sessionKeyForName(state, paneSessionName(pane, state)) : ''
}

// The client keeps the untouched all-session state for search/alerts and filters
// the interactive Home state to the selected session.
export function stateForSession(state: HerdrState, key: string): HerdrState {
  const sessions = state.sessions ?? []
  const selected = sessions.find(s => s.key === key) ?? sessions.find(s => s.primary)
  const name = selected?.name || state.session || 'default'
  const mine = <T extends { session?: string }>(x: T) => (x.session || state.session || 'default') === name
  const panes = state.panes.filter(mine)
  const workspaces = state.workspaces.filter(mine)
  const tabs = (state.tabs ?? []).filter(mine)
  const machines = (state.machines ?? []).filter(m => !m.sessions || name in m.sessions || panes.some(p => (p.machine || '') === m.key))
  return { ...state, session: name, panes, workspaces, tabs, machines }
}

// Waiting panes in the sessions other than the selected one (the selected
// session's count already shows in Home's state counters).
export function waitingOutsideSession(tabs: readonly SessionTab[], key: string): number {
  return tabs.reduce((n, tab) => n + (tab.key === key ? 0 : tab.count), 0)
}

// Width the eyebrow needs for the logo and the session switcher at its natural
// size. The font is mono, uppercase, 10.5 px with .16 em of tracking: about
// 8 px per glyph; 70 px covers the logo, gaps, status square, chevron and padding,
// and a waiting count takes 18 px more. headerFold uses this estimate so the
// actions fold before the row overflows; the name itself truncates in CSS.
export function sessionSwitcherHeaderWidth(name: string, waiting: number): number {
  return 70 + [...name].length * 8 + (waiting > 0 ? 18 : 0)
}
