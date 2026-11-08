// A project's key and color. `key` is its fixed id: the key it was created
// with, never changed, what task ids (<key>-<n>), runs, coordinators,
// automations, workflows and logs refer to. `label` is the key the user sees
// and edits (WHR renamed WD: every task, old ones too, reads WD-<n>); the keys
// it had before stay in `aliases`, so old CLI and URL forms keep resolving.
import type { Project } from './project'

// The palette (names; the colors are theme tokens, --project-<name>).
export const PROJECT_COLORS = ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink'] as const
export type ProjectColor = typeof PROJECT_COLORS[number]
export const isProjectColor = (c: unknown): c is ProjectColor => PROJECT_COLORS.includes(c as ProjectColor)

type Keyed = Pick<Project, 'key'> & { label?: string, aliases?: string[] }

export const shownKey = (p: Keyed) => p.label ?? p.key
// Every key that names the project: its id, its shown key, its former ones.
const namesOf = (p: Keyed) => [p.key, ...(p.label ? [p.label] : []), ...(p.aliases ?? [])]

// The project a key names (any case, an alias too), or undefined.
export function projectOf<P extends Keyed>(projects: P[], key: unknown): P | undefined {
  if (typeof key !== 'string' || !key) return undefined
  const k = key.trim().toUpperCase()
  return projects.find(p => p.key === k) ?? projects.find(p => namesOf(p).includes(k))
}

// A task id as typed (WD-5, wd-5, WHR-5) → its stored id (WHR-5), or null.
export function storedTaskId(projects: Keyed[], id: unknown): string | null {
  const m = typeof id === 'string' ? /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})$/.exec(id.trim()) : null
  const p = m && projectOf(projects, m[1])
  return p ? `${p.key}-${m![2]}` : null
}

// A stored task id as the user sees it: WHR-5 → WD-5.
export function shownTaskId(projects: Keyed[], id: string) {
  const i = id.lastIndexOf('-')
  const p = i > 0 ? projects.find(x => x.key === id.slice(0, i)) : undefined
  return p ? `${shownKey(p)}${id.slice(i)}` : id
}

// The other project a key would clash with (any case), or undefined: a key
// names one project only, its id and former keys included.
export const keyClash = <P extends Keyed>(projects: P[], key: string, self?: string) =>
  projects.find(p => p.key !== self && namesOf(p).includes(key.toUpperCase()))

// A new key for project `p`: its label and aliases after the change.
export function renamed(p: Keyed, key: string): { label?: string, aliases?: string[] } {
  const next = key.toUpperCase(), old = shownKey(p)
  const aliases = [...new Set([...(p.aliases ?? []), ...(old !== p.key ? [old] : [])])].filter(a => a !== next)
  return { ...(next !== p.key ? { label: next } : {}), ...(aliases.length ? { aliases } : {}) }
}

// A new project's color: the first one no project has yet, else in turn.
export function defaultColor(projects: { color?: string }[]): ProjectColor {
  const used = new Set(projects.map(p => p.color))
  return PROJECT_COLORS.find(c => !used.has(c)) ?? PROJECT_COLORS[projects.length % PROJECT_COLORS.length]!
}
