import type { Pane, Workspace } from './types'
import { cleanTitle, coordinatorTitle, paneTitle } from './paneTitle'
import { addressOnly } from './coreInventory'

// herdr-projects marks its spaces with invisible characters (braille blank
// U+2800, zero-width spaces); some fonts draw them as dot grids.
export function cleanLabel(label: string | null | undefined): string {
  return (label ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/[\u2800\s]+/g, ' ').trim()
}

// Herdr's workspace label is the visible identity of a space. A pane title is
// still useful context, but only when it carries more information. A
// herdr-projects coordinator lives in the home folder's space or its repo's:
// its own name says what it is ("demo-app coordinator", not "demo-app").
export function spaceTitle(p: Pane, workspace?: Workspace | null): string {
  return (!p.label && coordinatorTitle(p)) || workspace?.label?.trim() || paneTitle(p)
}

// Desktop header: a renamed pane shows its own name.
export function desktopHeaderTitle(p: Pane, workspace: Workspace | null | undefined, ownTitle: boolean): string {
  return p.label?.trim() || (ownTitle ? paneTitle(p) : spaceTitle(p, workspace))
}

export function conversationSubtitle(p: Pane, workspace?: Workspace | null): string {
  const title = cleanTitle(p.title).replace(/\s*\|\s*\S+$/, '').trim()
  if (!title || /^\S+@\S+:/.test(title)) return ''
  const generic = [p.agent, p.name, 'Claude Code', 'Claude', 'Codex', 'Gemini CLI', 'OpenCode', 'Kimi']
  if (generic.some(x => x && x.trim().toLocaleLowerCase() === title.toLocaleLowerCase())) return ''
  if (title.toLocaleLowerCase() === spaceTitle(p, workspace).toLocaleLowerCase()) return ''
  return title
}

// herdr-core: a terminal with its own name (renamed, or named at creation) shows it on its
// home card, single terminal or lead of a space, rather than its folder. A name that is only
// its address ("t2") is not one: the folder stays.
export function coreOwnName(p: Pick<Pane, 'coreAddress' | 'label'>): string {
  const name = (p.coreAddress && p.label?.trim()) || ''
  return addressOnly(name, p.coreAddress) ? '' : name
}

// Title of a terminal on its home card and in the search results: its own name, else its space.
export function homeTitle(p: Pane, workspace?: Workspace | null): string {
  return coreOwnName(p) || spaceTitle(p, workspace)
}
