import type { HerdrState, Pane, Workspace } from '../../shared/types'
import { type LinkedTask, type MachineLinks, tasksIn } from '../../shared/boardLinks'

export type CloseKind = 'pane' | 'tab' | 'workspace'
export interface ClosePlan {
  group: boolean
  workspaces: Workspace[]
  panes: Pane[]
  // What actually disappears with it: the tabs left empty, and whether its
  // space goes too (a pane or tab that was the last one, or the space itself).
  tabs: string[]
  closesWorkspace: boolean
}

// Herdr requires explicit group intent when the primary workspace closes while
// linked checkouts remain open. A pane/tab close can close that workspace too.
export function planClose(state: HerdrState, kind: CloseKind, id: string): ClosePlan {
  const pane = kind === 'pane' ? state.panes.find(p => p.id === id) : undefined
  const tab = kind === 'tab' ? state.tabs?.find(t => t.id === id) : undefined
  const wsId = kind === 'workspace' ? id : pane?.workspace || tab?.workspace
  const ws = state.workspaces.find(w => w.id === wsId)
  if (!ws) return { group: false, workspaces: [], panes: [], tabs: [], closesWorkspace: false }
  const wsPanes = state.panes.filter(p => p.workspace === ws.id)
  const closesWorkspace = kind === 'workspace'
    || kind === 'pane' && wsPanes.length === 1
    || kind === 'tab' && (state.tabs || []).filter(t => t.workspace === ws.id).length === 1
  const linked = ws.repo && !ws.worktree && closesWorkspace
    ? state.workspaces.filter(w => w.id !== ws.id && w.machine === ws.machine && w.repo === ws.repo && w.worktree)
    : []
  const workspaces = linked.length ? [ws, ...linked] : [ws]
  const panes = linked.length ? state.panes.filter(p => workspaces.some(w => w.id === p.workspace))
    : kind === 'pane' ? pane ? [pane] : []
      : kind === 'tab' ? state.panes.filter(p => p.tab === id) : wsPanes
  const tabs = closesWorkspace || linked.length
    ? (state.tabs || []).filter(t => workspaces.some(w => w.id === t.workspace)).map(t => t.id)
    : kind === 'tab' ? [id]
      : pane && state.panes.filter(p => p.tab === pane.tab).length === 1 ? [pane.tab] : []
  return { group: Boolean(linked.length), workspaces, panes, tabs, closesWorkspace }
}

// The structure changed while the confirmation was open: does the close now
// take more than what was shown (another pane, a tab, a space, the group)?
export function widerClose(shown: ClosePlan, now: ClosePlan): boolean {
  const spaces = (x: ClosePlan) => x.closesWorkspace || x.group ? x.workspaces.map(w => w.id) : []
  const more = (a: string[], b: string[]) => b.some(id => !a.includes(id))
  return (now.group && !shown.group)
    || more(shown.panes.map(p => p.id), now.panes.map(p => p.id))
    || more(shown.tabs, now.tabs)
    || more(spaces(shown), spaces(now))
}

export interface CheckoutStatus { label: string, modified: number, untracked: number, truncated?: boolean }
export function checkoutMessage(statuses: CheckoutStatus[], group: boolean, tl: (en: string, fr: string) => string): string {
  const parts: string[] = []
  if (group) parts.push(tl('The worktree group and all its open spaces will close.', 'Le groupe de worktrees et tous ses espaces ouverts seront fermés.'))
  parts.push(tl('Files, branches and checkout/worktree directories will be kept.', 'Les fichiers, les branches et les dossiers de checkout/worktree seront conservés.'))
  for (const s of statuses) {
    const count = s.modified + s.untracked
    const prefix = s.truncated ? tl('At least ', 'Au moins ') : ''
    parts.push(count
      ? tl(`⚠ ${s.label}: ${prefix}${s.modified} modified, ${s.untracked} untracked file(s) — uncommitted changes will be kept.`, `⚠ ${s.label} : ${prefix}${s.modified} fichier(s) modifié(s), ${s.untracked} non suivi(s) — modifications non commitées conservées.`)
      : tl(`${s.label}: no uncommitted changes.`, `${s.label} : aucune modification non commitée.`))
  }
  return parts.join('\n')
}

// herdr-projects tasks whose agents a close stops: those with a pane among the
// panes it closes, and, when whole spaces close (a space, a worktree group),
// those whose space it is. The repo's own space heads its worktree group in
// Herdr: closing it closes its tasks' spaces too.
export function tasksClosing(plan: ClosePlan, kind: CloseKind, links: MachineLinks[]): LinkedTask[] {
  const spaces = kind === 'workspace' || plan.group ? plan.workspaces.map(w => w.id) : []
  const byPane = new Set(plan.panes.map(p => p.id))
  const out = tasksIn(spaces, plan.panes, links)
  for (const m of links) for (const t of m.tasks) if (!out.includes(t) && t.panes.some(p => byPane.has(p.id))) out.push(t)
  return out
}

// The warning for them, named (at most 4), and the button that says so.
export function taskStopMessage(tasks: Pick<LinkedTask, 'key' | 'title'>[], tl: (en: string, fr: string) => string): { message: string, action: string } | null {
  const n = tasks.length
  if (!n) return null
  const names = tasks.slice(0, 4).map(t => `${t.key}${t.title ? ` ${t.title}` : ''}`)
  const more = n > 4 ? tl(` and ${n - 4} more`, ` et ${n - 4} autre${n - 4 > 1 ? 's' : ''}`) : ''
  return n === 1
    ? {
        message: tl(`⚠ This stops the agent of herdr-projects task ${names[0]}: its terminal closes and the task loses its agent.`, `⚠ Cela arrête l’agent de la tâche herdr-projects ${names[0]} : son terminal se ferme et la tâche perd son agent.`),
        action: tl('Close and stop the task', 'Fermer et arrêter la tâche'),
      }
    : {
        message: tl(`⚠ This stops the agents of ${n} herdr-projects tasks: ${names.join(', ')}${more}. Their terminals close and the tasks lose their agents.`, `⚠ Cela arrête les agents de ${n} tâches herdr-projects : ${names.join(', ')}${more}. Leurs terminaux se ferment et les tâches perdent leurs agents.`),
        action: tl(`Close and stop ${n} tasks`, `Fermer et arrêter ${n} tâches`),
      }
}
