// Notes: a whiteboard agents write and the user reads (WHR-295). Pure: the
// `notes …` words of `wherdr alfred` and `wherdr pm`, the note file's format,
// the paths and links that stay inside the notes folder, and a coordinator's
// default scope. The server (server/utils/notesStore.ts) reads and writes the files.
import { projectOnTab, projectTabMachines } from '../app/utils/projectTabs'
import { BAR_ALL, type MachineGroup } from '../app/utils/machineBar'
import { PROJECT_COLORS, isProjectColor } from './pm/projectKey'

// A home tab: all (every tab), a tab group's id (*group:…, from the
// machineGroups setting), or a machine shown as its own tab (machine:<base key>).
export type NoteScope = string
export const machineScope = (key: string): NoteScope => `machine:${key}`
export const scopeMachine = (scope: NoteScope) => (scope.startsWith('machine:') ? scope.slice(8) : null)
// A home tab a note may be scoped to: its scope, its name and its machines.
export interface NoteTab { scope: NoteScope, name: string, machines: string[] }
// The home tabs, in the bar's order (bar: its item ids), All left out. label:
// a machine's name from its base key.
export function noteTabs(bar: readonly string[], groups: readonly MachineGroup[], label: (key: string) => string): NoteTab[] {
  return bar.filter(id => id !== BAR_ALL).map((id) => {
    const g = groups.find(x => x.id === id)
    return g ? { scope: g.id, name: g.name, machines: g.machines } : { scope: machineScope(id), name: label(id), machines: [id] }
  })
}
// The home tab a bar pick stands for, null for every machine.
export const tabScope = (pick: string | null, groups: readonly MachineGroup[]): NoteScope | null =>
  (pick === null || pick === BAR_ALL ? null : groups.some(g => g.id === pick) ? pick : machineScope(pick))
export interface Note { id: string, title: string, scope: NoteScope, body: string, created: string, updated: string }

export type NotesCommand =
  | { verb: 'list', scope?: string }
  | { verb: 'show', id: string } // a note's id, or a file's path
  | { verb: 'add', title: string, scope?: string } // the lines come as the call's input
  | { verb: 'edit', id: string, title?: string, scope?: string } // new lines on input; none: kept
  | { verb: 'remove', id: string }
  | { verb: 'file put' | 'file remove', path: string } // put: the file's text on input

export const NOTES_COMMANDS: { usage: string, does: string }[] = [
  { usage: 'notes list [--scope all|<tab>]', does: 'every note (id, title, scope, dates), or one scope\'s, and the linked files' },
  { usage: 'notes show <id|path>', does: 'one note, or one linked file' },
  { usage: 'notes add "<title>" [--scope all|<tab>] < lines.md', does: 'add a note: a title and a few short Markdown lines on stdin (checkboxes, links to another note `other-note.md`, a file `plans/x.md` or an in-app place `#/board?task=ID`); scope all (every tab) or one home tab (a tab group or a machine shown as its own tab), by name; left out, the tab your project shows in' },
  { usage: 'notes edit <id> [--title "<title>"] [--scope all|<tab>] < lines.md', does: 'change a note: new lines on stdin replace its own (empty stdin keeps them); --scope moves it. Rewrite a note to keep it short rather than add another' },
  { usage: 'notes remove <id>', does: 'remove a note once its subject is decided or done' },
  { usage: 'notes file put <folder/name.md> < file.md', does: 'write a Markdown file under a folder of the notes (plans/x.md), for content too long for a note: link it from a note' },
  { usage: 'notes file remove <folder/name.md>', does: 'remove a linked file no note needs any more' },
]
// Badges in a note's lines (NotesPanel.vue renders them): [[WHR]], [[WHR-12]]
// a project's key badge; [[label|icon|colour|link]] one an agent makes up.
// Plain text anywhere else, so a note stays readable Markdown.
export const NOTE_ICONS: Record<string, string> = {
  'flag': 'i-lucide-flag', 'clock': 'i-lucide-clock', 'calendar': 'i-lucide-calendar', 'alert': 'i-lucide-triangle-alert', 'info': 'i-lucide-info',
  'check': 'i-lucide-circle-check', 'x': 'i-lucide-circle-x', 'pause': 'i-lucide-circle-pause', 'star': 'i-lucide-star', 'bug': 'i-lucide-bug',
  'lightbulb': 'i-lucide-lightbulb', 'rocket': 'i-lucide-rocket', 'eye': 'i-lucide-eye', 'lock': 'i-lucide-lock', 'link': 'i-lucide-link',
  'file': 'i-lucide-file-text', 'branch': 'i-lucide-git-branch', 'pr': 'i-lucide-git-pull-request', 'server': 'i-lucide-server', 'bell': 'i-lucide-bell',
}
export type NoteBadge = { kind: 'project', key: string, task?: string } | { kind: 'custom', label: string, icon?: string, colour?: string, link?: string }
const NOTE_BADGE_HELP = `Badges in a line: [[KEY]] or [[KEY-12]] shows a project's key badge (a task id opens its sheet); [[label|icon|colour|link]] a badge of your own, icon one of ${Object.keys(NOTE_ICONS).join(', ')}, colour one of ${PROJECT_COLORS.join(', ')}, link optional (another note, a file, #/…); leave a field empty to skip it ([[Waiting||amber]])`
export const NOTES_RULE = `Notes are the user's whiteboard, read-only for them: offer a reminder line in your reply ("Add a reminder: …?"), write it after their yes, and remove it once its subject is decided or done. Keep a note to a few lines; move anything longer to a linked file. Every change is logged with who made it. Change or remove another project's note only when it is outdated or the user asks. ${NOTE_BADGE_HELP}`

// A badge's inside ([[…]]) → the badge, or null (left as text).
export function noteBadge(inner: string): NoteBadge | null {
  const p = /^([A-Z][A-Z0-9]{1,9})(-\d{1,6})?$/.exec(inner.trim())
  if (p) return { kind: 'project', key: p[1]!, ...(p[2] ? { task: inner.trim() } : {}) }
  const [label = '', icon = '', colour = '', link = ''] = inner.split('|').map(x => x.trim())
  if (!label || label.length > 40 || inner.split('|').length > 4) return null
  return { kind: 'custom', label, ...(NOTE_ICONS[icon] ? { icon: NOTE_ICONS[icon] } : {}), ...(isProjectColor(colour) ? { colour } : {}), ...(link && !/\s/.test(link) ? { link } : {}) }
}
// A note's lines with each badge out of the text, outside code: `mark(i)`
// stands in for badges[i] (the panel mounts it there).
export function noteBadges(body: string, mark: (i: number) => string): { text: string, badges: NoteBadge[] } {
  const badges: NoteBadge[] = []
  const text = body.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/\[\[([^[\]\n]{1,200})\]\]/g, (all, inner: string) => {
    const b = noteBadge(inner)
    return b ? mark(badges.push(b) - 1) : all
  }))).join('')
  return { text, badges }
}

// The Notes panel's filter: follow the home tab, every note, or one tab.
export const NOTES_FOLLOW = 'follow'
// The home tab a filter shows, null for every note. followed: the home tab
// picked (tabScope).
export const filterTab = (filter: string, followed: NoteScope | null) => (filter === NOTES_FOLLOW ? followed : filter === 'all' ? null : filter)
// The notes it shows: that tab's own and the all ones. A group's tab also
// shows the notes of its machines (a machine that joined it keeps its notes).
export function notesShown(notes: readonly Note[], filter: string, followed: NoteScope | null, groups: readonly MachineGroup[]): Note[] {
  const tab = filterTab(filter, followed)
  if (!tab) return [...notes]
  const members = groups.find(g => g.id === tab)?.machines ?? []
  return notes.filter(n => n.scope === 'all' || n.scope === tab || members.includes(scopeMachine(n.scope) ?? '\0'))
}

export const MAX_LINES = 12
export const MAX_BODY = 1500
export const MAX_FILE = 200_000
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const usage = (verb: string) => ({ error: `usage: ${NOTES_COMMANDS.filter(c => c.usage.startsWith(`notes ${verb}`)).map(c => c.usage).join(' | ')}` })

// words and flags after `notes` → a command, or the reason it is not one.
export function parseNotes(words: string[], flags: Record<string, string>): NotesCommand | { error: string } {
  const [w0 = '', w1, w2, ...rest] = words
  const allowed = { list: ['scope'], add: ['scope'], edit: ['title', 'scope'] }[w0] ?? []
  const extra = Object.keys(flags).find(f => !allowed.includes(f))
  if (extra) return { error: `unknown option --${extra}` }
  const { scope, title } = flags
  if (w0 === 'list') return w1 ? usage(w0) : { verb: w0, ...(scope ? { scope } : {}) }
  if (w0 === 'show' || w0 === 'remove') return w1 && !w2 ? { verb: w0, id: w1 } : usage(w0)
  if (w0 === 'add') {
    const t = cleanTitle(words.slice(1).join(' '))
    return t ? { verb: w0, title: t, ...(scope ? { scope } : {}) } : usage(w0)
  }
  if (w0 === 'edit') {
    if (!w1 || w2) return usage(w0)
    if (title !== undefined && !cleanTitle(title)) return { error: '--title is one line of text' }
    return { verb: w0, id: w1, ...(title !== undefined ? { title: cleanTitle(title) } : {}), ...(scope ? { scope } : {}) }
  }
  if (w0 === 'file' && (w1 === 'put' || w1 === 'remove')) {
    if (!w2 || rest.length) return usage(`file ${w1}`)
    return filePath(w2) ? { verb: `file ${w1}`, path: w2 } : { error: `${w2}: a file is <folder>/<name>.md inside the notes (letters, digits, . _ -), never .. nor an absolute path` }
  }
  return { error: `unknown command: notes ${words.join(' ')} (${NOTES_COMMANDS.map(c => c.usage.split(' ').slice(0, 2).join(' ')).filter((u, i, a) => a.indexOf(u) === i).join(', ')})` }
}

export const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 120)
export const noteId = (id: string) => ID_RE.test(id)
// A title's id: its words, lowercase, joined by dashes.
export const slug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'note'

// A linked file's path: <folder>/…/<name>.md, every part plain (no .., no
// dot file), so it never leaves the notes folder nor clashes with a note.
export function filePath(p: string): boolean {
  const parts = p.split('/')
  return parts.length >= 2 && parts.length <= 4 && parts.every(s => SEGMENT_RE.test(s) && !s.includes('..')) && p.endsWith('.md')
}

// A note's lines: short, the whiteboard has no room for more.
export function noteBody(input: unknown): string | { error: string } {
  const lines = String(input ?? '').split(/\r?\n/).map(l => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  while (lines.length && !lines[0]) lines.shift()
  if (lines.length > MAX_LINES || lines.join('\n').length > MAX_BODY) return { error: `A note holds at most ${MAX_LINES} lines and ${MAX_BODY} characters: move the details to a linked file (notes file put plans/<name>.md) and keep one line that links to it` }
  return lines.join('\n')
}

// The note-folder targets a body links to, as paths from the folder: a note
// (<id>.md) or a file. Web and in-app (#/…) links are left out; a link that
// would leave the folder is an error.
// A badge's link ([[label|icon|colour|plans/x.md]]) counts like any other.
export function noteLinks(body: string): string[] | { error: string } {
  const out: string[] = []
  const hrefs = [...body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(m => m[1]!)
  for (const b of noteBadges(body, () => '').badges) if (b.kind === 'custom' && b.link) hrefs.push(b.link)
  for (const href of hrefs) {
    const target = href.split('#')[0]!
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || !target) continue
    const note = /^([^/]+)\.md$/.exec(target)
    if (!(note && noteId(note[1]!)) && !filePath(target)) return { error: `${href}: a link inside the notes is <id>.md or <folder>/<name>.md, never .. nor an absolute path` }
    out.push(target)
  }
  return out
}

// The note file: a small front matter (JSON values), then the lines.
export function noteText(n: Note): string {
  return ['---', ...(['title', 'scope', 'created', 'updated'] as const).map(k => `${k}: ${JSON.stringify(n[k])}`), '---', n.body, ''].join('\n')
}
export function readNote(id: string, text: string): Note | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return null
  const f: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv) try { const v = JSON.parse(kv[2]!); if (typeof v === 'string') f[kv[1]!] = v } catch { /* a broken line is skipped */ }
  }
  if (!f.title || !f.scope) return null
  return { id, title: f.title, scope: f.scope, body: m[2]!.replace(/\n+$/, ''), created: f.created ?? '', updated: f.updated ?? f.created ?? '' }
}

// A scope as an agent names it (all, a home tab's name or scope) → its stored value.
export function resolveScope(raw: string, tabs: readonly NoteTab[]): NoteScope | { error: string } {
  if (raw.toLowerCase() === 'all') return 'all'
  const t = tabs.find(x => x.scope === raw) ?? tabs.find(x => x.name.toLowerCase() === raw.trim().toLowerCase())
  return t ? t.scope : { error: `Unknown scope ${raw}: all, or a home tab (${tabs.map(x => x.name).join(', ') || 'none yet'})` }
}
// A scope's name: all, its tab's, else a machine's (label) or the scope itself.
export const scopeName = (scope: NoteScope, tabs: readonly NoteTab[], label: (key: string) => string = k => k) =>
  (scope === 'all' ? 'all' : tabs.find(t => t.scope === scope)?.name ?? (scopeMachine(scope) !== null ? label(scopeMachine(scope)!) : scope))

// The home tabs a project shows in, all (every tab) first when it shows in
// every one: its coordinator's default scope. override: its projectTabs entry.
export function projectScopes(project: { machine: string, machines?: string[], paused?: string[] }, override: string | undefined, groups: readonly MachineGroup[], tabs: readonly NoteTab[]): NoteScope[] {
  const tab = projectTabMachines({ machines: [project.machine, ...(project.machines ?? []).filter(m => m !== project.machine)], paused: project.paused }, override, groups)
  const mine = tabs.filter(t => projectOnTab(tab, t.machines)).map(t => t.scope)
  return mine.length === tabs.length ? ['all', ...mine] : mine
}

// A link in a note (from: '') or in a linked file (from: its path) → what it
// leads to inside the notes folder: a note, a file, or `out` when it would
// leave the folder or is not a notes path. Web and in-app links → null.
export type NoteTarget = { kind: 'note', id: string } | { kind: 'file', path: string } | { kind: 'out' }
export function noteTarget(href: string, from = ''): NoteTarget | null {
  const target = href.split('#')[0]!
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#') || !target) return null
  if (target.startsWith('/')) return { kind: 'out' }
  const parts = from.split('/').slice(0, -1)
  for (const s of target.split('/')) {
    if (s === '..') { if (!parts.pop()) return { kind: 'out' } }
    else if (s && s !== '.') parts.push(s)
  }
  const rel = parts.join('/'), note = /^([^/]+)\.md$/.exec(rel)
  if (note && noteId(note[1]!)) return { kind: 'note', id: note[1]! }
  return filePath(rel) ? { kind: 'file', path: rel } : { kind: 'out' }
}
