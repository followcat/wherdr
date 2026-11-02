// Confirmation text before closing a tab or a space: what will be
// stopped (named agents, terminals), and the space that goes with its last
// tab. Pure (tested): the language comes with `tl`.
import type { Pane } from '../../shared/types'
import { closeSummary } from '../../shared/spaceActions'
import { paneTitle } from '../../shared/paneTitle'
import { closeProcessMessage, type CloseProcess } from '../../shared/closeProcess'

type Tl = (en: string, fr: string) => string
const KIND: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const kindName = (k: string | null) => (k && KIND[k]) || (k ? k[0]!.toUpperCase() + k.slice(1) : 'Shell')
// An agent, by kind then name; no "Omp “Omp”" for a pane named after its agent.
function agentName(p: Pane, title: string, fr: boolean) {
  const kind = kindName(p.agent)
  if (title.toLocaleLowerCase() === kind.toLocaleLowerCase() || title.toLocaleLowerCase() === String(p.agent).toLocaleLowerCase()) return kind
  return fr ? `${kind}\u00a0«\u00a0${title}\u00a0»` : `${kind} “${title}”`
}

export interface CloseTarget {
  kind: 'tab' | 'workspace'
  label: string
  panes: Pane[]
  // Tab: last of its space (Herdr then closes the space too).
  lastTab?: boolean
  workspaceLabel?: string
  // Space: the names of its tabs.
  tabs?: string[]
}

const quoteEn = (x: string) => `“${x}”`
const quoteFr = (x: string) => `«\u00a0${x}\u00a0»`
const panesEn = (n: number) => (n === 1 ? '1 pane' : `${n} panes`)
const panesFr = (n: number) => (n === 1 ? '1 panneau' : `${n} panneaux`)
const tabsEn = (n: number) => (n === 1 ? '1 tab' : `${n} tabs`)
const tabsFr = (n: number) => (n === 1 ? '1 onglet' : `${n} onglets`)
function names(list: string[], tl: Tl) {
  const shown = list.slice(0, 3)
  const more = list.length > 3 ? tl(` and ${list.length - 3} more`, ` et ${list.length - 3} autre${list.length - 3 > 1 ? 's' : ''}`) : ''
  return tl(shown.map(quoteEn).join(', '), shown.map(quoteFr).join(', ')) + more
}

// Scope line: how many tabs and panes go, by name for the tabs.
function scopeLine(x: CloseTarget, tl: Tl): string {
  const n = x.panes.length
  if (x.kind === 'tab') return tl(`${panesEn(n)} will close.`, `${panesFr(n)} ${n > 1 ? 'seront fermés' : 'sera fermé'}.`)
  const tabs = x.tabs || []
  if (!tabs.length) return tl(`${panesEn(n)} will close.`, `${panesFr(n)} ${n > 1 ? 'seront fermés' : 'sera fermé'}.`)
  return tl(`Its ${tabsEn(tabs.length)} (${names(tabs, tl)}) and ${panesEn(n)} will close.`,
    `Ses ${tabsFr(tabs.length)} (${names(tabs, tl)}) et ${panesFr(n)} seront fermés.`)
}

export function closeConfirm(x: CloseTarget, tl: Tl): { message: string, action: string } {
  const s = closeSummary(x.panes)
  const what = x.kind === 'tab' ? tl(`tab “${x.label}”`, `l’onglet «\u00a0${x.label}\u00a0»`) : tl(`space “${x.label}”`, `l’espace «\u00a0${x.label}\u00a0»`)
  const parts = [tl(`Close ${what}?`, `Fermer ${what}\u00a0?`)]
  if (x.kind === 'tab' && x.lastTab && x.workspaceLabel) {
    parts.push(tl(`It is its last tab: space “${x.workspaceLabel}” will close too.`, `C’est son dernier onglet\u00a0: l’espace «\u00a0${x.workspaceLabel}\u00a0» sera fermé aussi.`))
  }
  parts.push(scopeLine(x, tl))
  const n = s.agents.length
  if (n) {
    const names = s.agents.slice(0, 3).map(p => agentName(p, paneTitle(p), true))
    const namesEn = s.agents.slice(0, 3).map(p => agentName(p, paneTitle(p), false))
    const more = n > 3 ? tl(` and ${n - 3} more`, ` et ${n - 3} autre${n - 3 > 1 ? 's' : ''}`) : ''
    parts.push(n === 1
      ? tl(`An agent is running there: ${namesEn[0]}. It will be stopped.`, `Un agent y tourne\u00a0: ${names[0]}. Il sera arrêté.`)
      : tl(`${n} agents are running there: ${namesEn.join(', ')}${more}. They will be stopped.`, `${n} agents y tournent\u00a0: ${names.join(', ')}${more}. Ils seront arrêtés.`))
  }
  if (s.shells === 1) parts.push(n ? tl('Its terminal will close too.', 'Son terminal sera fermé aussi.') : tl('Its terminal will close.', 'Son terminal sera fermé.'))
  else if (s.shells > 1) parts.push(n ? tl(`Its ${s.shells} terminals will close too.`, `Ses ${s.shells} terminaux seront fermés aussi.`) : tl(`Its ${s.shells} terminals will close.`, `Ses ${s.shells} terminaux seront fermés.`))
  const action = n
    ? tl(`Close and stop ${n > 1 ? `${n} agents` : 'the agent'}`, `Fermer et arrêter ${n > 1 ? `${n} agents` : 'l’agent'}`)
    : x.kind === 'tab' ? tl('Close tab', 'Fermer l’onglet') : tl('Close space', 'Fermer l’espace')
  return { message: parts.join(' '), action }
}

// Closing the pane being viewed (conversation or its terminal, the same pane):
// what stops, and what goes with it or stays open.
export interface PaneCloseTarget {
  pane: Pane
  // Shell or stopped agent: what the close inspection saw running.
  process: CloseProcess
  tabLabel: string
  // Panes of its tab (itself included), tabs of its space.
  tabPanes: number
  workspaceTabs: number
  workspaceLabel: string
  // From the close plan: its tab, or its whole space, goes too.
  closesTab: boolean
  closesWorkspace: boolean
}

export function paneCloseConfirm(x: PaneCloseTarget, tl: Tl): { message: string, action: string } {
  const p = x.pane
  // Its own name first; a shell without one is just "the terminal".
  const own = p.label || p.name || ''
  const title = own || paneTitle(p)
  const ws = x.workspaceLabel
  const named = { en: agentName(p, title, false), fr: agentName(p, title, true) }
  const parts = [p.agent
    ? tl(`Close the conversation with ${named.en}?`, `Fermer la conversation avec ${named.fr}\u00a0?`)
    : own
      ? tl(`Close the terminal “${own}” in space “${ws}”?`, `Fermer le terminal «\u00a0${own}\u00a0» de l’espace «\u00a0${ws}\u00a0»\u00a0?`)
      : tl(`Close the terminal in space “${ws}”?`, `Fermer le terminal de l’espace «\u00a0${ws}\u00a0»\u00a0?`)]
  parts.push(p.agent && !p.stopped
    ? tl(`${named.en} will be stopped.`, `${named.fr} sera arrêté.`)
    : closeProcessMessage(p, x.process, tl))
  if (x.closesWorkspace) {
    parts.push(tl(`It is the last pane of space “${ws}”: the space closes too.`, `C’est le dernier panneau de l’espace\u00a0«\u00a0${ws}\u00a0»\u00a0: l’espace sera fermé aussi.`))
  } else if (x.closesTab) {
    const k = x.workspaceTabs - 1
    parts.push(tl(`It is the only pane of tab “${x.tabLabel}”: the tab closes too. ${k > 1 ? `The other ${k} tabs` : 'The other tab'} of space “${ws}” ${k > 1 ? 'stay' : 'stays'} open.`,
      `C’est le seul panneau de l’onglet\u00a0«\u00a0${x.tabLabel}\u00a0»\u00a0: l’onglet sera fermé aussi. ${k > 1 ? `Les ${k} autres onglets` : 'L’autre onglet'} de l’espace\u00a0«\u00a0${ws}\u00a0» ${k > 1 ? 'restent ouverts' : 'reste ouvert'}.`))
  } else {
    const k = x.tabPanes - 1
    parts.push(tl(`Only this pane closes: ${k > 1 ? `the other ${k} panes` : 'the other pane'} of tab “${x.tabLabel}” ${k > 1 ? 'stay' : 'stays'} open.`,
      `Seul ce panneau sera fermé\u00a0: ${k > 1 ? `les ${k} autres panneaux` : 'l’autre panneau'} de l’onglet\u00a0«\u00a0${x.tabLabel}\u00a0» ${k > 1 ? 'restent ouverts' : 'reste ouvert'}.`))
  }
  return {
    message: parts.filter(Boolean).join(' '),
    action: p.agent ? tl('Close conversation', 'Fermer la conversation') : tl('Close terminal', 'Fermer le terminal'),
  }
}
