import type { Pane } from './types'

export const cleanTitle = (title: string | null | undefined) =>
  (title || '').replace(/^[^\p{L}\p{N}~/]+/u, '').trim()

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'login', 'tmux', 'screen'])
const GENERIC_AGENTS = new Set(['claude', 'claude code', 'codex', 'gemini', 'gemini cli', 'opencode', 'kimi', 'agent'])

const baseName = (dir: string | null | undefined) =>
  (dir || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || ''

// Title the program set and that says something: not the shell
// prompt ("user@host: ~/dir"), not the shell name, not a path nor the folder.
export function meaningfulTitle(p: Pick<Pane, 'title' | 'cwd' | 'agent'>): string {
  const title = cleanTitle(p.title).replace(/\s*\|\s*\S+$/, '').trim()
  if (!title || /^\S+@\S+:/.test(title)) return ''
  const low = title.toLocaleLowerCase()
  const first = baseName(low.split(/\s+/)[0]).replace(/^-/, '')
  if (SHELLS.has(first) && !/\s/.test(low)) return ''
  if (/^(?:~|\/)/.test(title) && !/\s/.test(title)) return ''
  const dir = baseName(p.cwd).toLocaleLowerCase()
  if (dir && (low === dir || low === `${dir}/`)) return ''
  if (p.agent && GENERIC_AGENTS.has(low)) return ''
  if (p.agent && low === p.agent.toLocaleLowerCase()) return ''
  return title
}

// A herdr-projects 1.x coordinator (coordinator/co.rs): its agent's name in
// Herdr is `sw-coordinator` (the Coordinator), `sw-coordinator-machine` or
// `sw-coordinator-<repo>` (a `-2` tells two alike apart), in a tab named after
// it: "Coordinator", "<host> coordinator", "<repo> coordinator" ("~
// coordinator" for the home folder's). Its space is the home folder's ("~") or
// its repo's, so the space's name would say only that. '' : not one.
export function coordinatorTitle(p: Pick<Pane, 'name' | 'tabLabel'>): string {
  const name = (p.name || '').toLocaleLowerCase()
  if (!/^sw-coordinator(?:-|$)/.test(name)) return ''
  const tab = cleanTitle(p.tabLabel)
  if (/(?:^|\s)coordinator$/i.test(tab)) return tab
  if (/^sw-coordinator(?:-\d+)?$/.test(name)) return 'Coordinator'
  if (/^sw-coordinator-machine(?:-\d+)?$/.test(name)) return 'Machine coordinator'
  return `${name.replace(/^sw-coordinator-/, '').replace(/-\d+$/, '')} coordinator`
}

// Name of a pane, independent of its space's name: chosen name (pane.rename),
// agent name, terminal title if meaningful, foreground
// command, and as a last resort the folder.
export function paneTitle(p: Pane, _workspaceTitle?: string | null): string {
  return titleOf(p, kindLabel)
}

// Same name, but an unnamed agent pane keeps its agent id as typed ("omp",
// "claude") instead of a capitalised kind label.
export function paneOwnTitle(p: Pane): string {
  return titleOf(p, kind => kind)
}

function titleOf(p: Pane, agentFallback: (kind: string) => string): string {
  if (p.label) return p.label
  const coordinator = coordinatorTitle(p)
  if (coordinator) return coordinator
  const shown = p.displayAgent?.trim()
  if (p.agent && shown && !GENERIC_AGENTS.has(shown.toLocaleLowerCase()) && shown.toLocaleLowerCase() !== p.agent.toLocaleLowerCase()) return shown
  const title = meaningfulTitle(p)
  if (title) return title
  if (p.agent) return p.name && p.name !== p.agent ? p.name : agentFallback(p.agent)
  if (p.command) return p.command
  return baseName(p.cwd) || (p.cwd ? '/' : 'Shell')
}

function kindLabel(kind: string | null) {
  if (kind === 'claude') return 'Claude'
  if (kind === 'codex') return 'Codex'
  if (kind === 'opencode') return 'OpenCode'
  if (kind === 'gemini') return 'Gemini CLI'
  if (kind === 'kimi') return 'Kimi'
  return kind ? kind[0]!.toUpperCase() + kind.slice(1) : 'Shell'
}
