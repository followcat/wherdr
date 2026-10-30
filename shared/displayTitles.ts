import type { Pane, Workspace } from './types'
import { cleanTitle, coordinatorTitle, paneTitle } from './paneTitle'

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

// One identity on a narrow header. Never replace a useful name with a
// generated tab number, or change it when a neighbouring tab opens/closes.
export function phoneHeaderTitle(p: Pane, workspace: Workspace | null | undefined, tabLabel: string | null | undefined, paneCount: number): string {
  return p.label?.trim() || coordinatorTitle(p) || cleanLabel(tabLabel)
    || (paneCount > 1 ? paneTitle(p) : spaceTitle(p, workspace))
}

export function conversationSubtitle(p: Pane, workspace?: Workspace | null): string {
  const title = cleanTitle(p.title).replace(/\s*\|\s*\S+$/, '').trim()
  if (!title || /^\S+@\S+:/.test(title)) return ''
  const generic = [p.agent, p.name, 'Claude Code', 'Claude', 'Codex', 'Gemini CLI', 'OpenCode', 'Kimi']
  if (generic.some(x => x && x.trim().toLocaleLowerCase() === title.toLocaleLowerCase())) return ''
  if (title.toLocaleLowerCase() === spaceTitle(p, workspace).toLocaleLowerCase()) return ''
  return title
}
