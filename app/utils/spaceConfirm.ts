// Confirmation text before closing a pane: what will be stopped (named
// agent, terminal), and the tab or space that goes with it. Pure (tested):
// the language comes with `tl`.
import type { Pane } from '../../shared/types'
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
