// A workspace's map (docs/workspaces.md#the-workspace-map): what each of its
// repositories does and talks to, written by its coordinator the first time a
// task touches a repository (no upfront reading). Stored as maps/<WS>.json;
// map.md, rendered from it, sits in the coordinator's folder. `map list` adds
// every git repository under the root with an automatic one-line description
// (the manifest's, else the README's first sentence): no model, cached a day.

export const DOES_MAX = 160
const LINKS_MAX = 20
export const LIST_TTL = 24 * 3_600_000
// A repository: its path under the root (payroll-api, or group/payroll-api),
// up to 4 folders of any name (spaces and Unicode too) but . and .., no control character.
const SEGMENT_RE = /^[^/\p{Cc}]{1,100}$/u

export interface MapEntry {
  repo: string, path: string, does: string, talks: string[], usedBy: string[]
  project?: string // the member project of this repository, when there is one
  readAt: number
}
export interface ListedRepo { repo: string, path: string, does: string }
export interface MapFile { entries: MapEntry[], listed?: { at: number, repos: ListedRepo[] } }

export type MapCommand =
  | { name: 'map show' } | { name: 'map list', refresh?: true } | { name: 'map remove', repo: string }
  | { name: 'map set', repo: string, does?: string, talks?: string[], usedBy?: string[] }

export const MAP_COMMANDS = [
  { usage: 'map show', does: 'the workspace\'s map: each repository mapped so far, what it does, what it talks to and what uses it (also in map.md in your folder)' },
  { usage: 'map list [--refresh]', does: 'every git repository under the workspace\'s root, its automatic one-line description (package manifest, else README) and whether it is mapped; cached a day, --refresh looks again' },
  { usage: `map set <repo> --does "<one line>" [--talks <repo>,<repo>] [--used-by <repo>,<repo>]`, does: `write a repository's line in the workspace's map (--does: ${DOES_MAX} characters at most; left out, an existing line keeps its own); --talks and --used-by replace their list` },
  { usage: 'map remove <repo>', does: 'take a repository off the workspace\'s map' },
]

export const isRepo = (r: unknown): r is string => {
  const parts = typeof r === 'string' ? r.split('/') : []
  return parts.length >= 1 && parts.length <= 4 && parts.every(s => SEGMENT_RE.test(s) && s !== '.' && s !== '..')
}
const repoList = (v: string, flag: string): string[] | { error: string } => {
  const list = [...new Set(v.split(',').map(s => s.trim()).filter(Boolean))]
  return list.length <= LINKS_MAX && list.every(isRepo) ? list : { error: `--${flag} is a list of repositories (at most ${LINKS_MAX}): a,b` }
}

// `map …` words (after `map`) and flags → a command, or why not.
export function parseMap(words: string[], flags: Record<string, string>): MapCommand | { error: string } {
  const [verb, repo, extra] = words, name = `map ${verb ?? ''}`
  const usage = { error: `usage: wherdr pm ${MAP_COMMANDS.find(c => c.usage.startsWith(name))?.usage ?? MAP_COMMANDS.map(c => c.usage).join(' | ')}` }
  if (verb === 'show') return repo ? usage : { name: 'map show' }
  if (verb === 'list') return repo ? usage : { name: 'map list', ...(flags.refresh ? { refresh: true as const } : {}) }
  if (!isRepo(repo) || extra) return usage
  if (verb === 'remove') return { name: 'map remove', repo }
  if (verb !== 'set') return usage
  const does = flags.does?.replace(/\s+/g, ' ').trim()
  if (does !== undefined && (!does || does.length > DOES_MAX)) return { error: `--does is one line of ${DOES_MAX} characters at most` }
  const talks = flags.talks === undefined ? undefined : repoList(flags.talks, 'talks')
  const usedBy = flags['used-by'] === undefined ? undefined : repoList(flags['used-by'], 'used-by')
  if (talks && 'error' in talks) return talks
  if (usedBy && 'error' in usedBy) return usedBy
  if (!does && !talks && !usedBy) return usage
  return { name: 'map set', repo, ...(does ? { does } : {}), ...(talks ? { talks } : {}), ...(usedBy ? { usedBy } : {}) }
}

// The map with one repository's line set; a new line needs --does.
export function setEntry(file: MapFile, cmd: Extract<MapCommand, { name: 'map set' }>, root: string, project: string | undefined, now: number): MapFile | { error: string } {
  const old = file.entries.find(e => e.repo === cmd.repo)
  if (!old && !cmd.does) return { error: `${cmd.repo} is not on the map yet: give it --does "<one line>"` }
  const entry: MapEntry = {
    repo: cmd.repo, path: `${root.replace(/\/+$/, '')}/${cmd.repo}`, does: cmd.does ?? old!.does,
    talks: cmd.talks ?? old?.talks ?? [], usedBy: cmd.usedBy ?? old?.usedBy ?? [], ...(project ? { project } : {}), readAt: now,
  }
  const entries = [...file.entries.filter(e => e.repo !== cmd.repo), entry].sort((a, b) => a.repo.localeCompare(b.repo))
  return { ...file, entries }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

// map.md, for the workspace's coordinator to read at its start.
export function renderMap(ws: { key: string, name: string, path: string }, file: MapFile): string {
  const lines = [`# Map of workspace ${ws.name} (${ws.key})`, '',
    `Written by wherdr from \`wherdr pm map set\`: do not edit this file. Root: ${ws.path}. Repositories not here yet: \`wherdr pm map list\`.`, '']
  if (!file.entries.length) lines.push('No repository mapped yet.')
  for (const e of file.entries) {
    lines.push(`## ${e.repo}${e.project ? ` (project ${e.project})` : ''}`, '', e.does, '')
    if (e.talks.length) lines.push(`- talks to: ${e.talks.join(', ')}`)
    if (e.usedBy.length) lines.push(`- used by: ${e.usedBy.join(', ')}`)
    lines.push(`- path: ${e.path}`, `- read: ${day(e.readAt)}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

// The cached repository list is used when it is under a day old, unless refreshed.
export const listFresh = (file: MapFile, now: number, refresh = false) =>
  !refresh && !!file.listed && now - file.listed.at < LIST_TTL

// The list with each repository marked mapped or not.
export const markMapped = (file: MapFile, repos: ListedRepo[]) =>
  repos.map(r => ({ ...r, mapped: file.entries.some(e => e.repo === r.repo) }))

const clip = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > DOES_MAX ? `${one.slice(0, DOES_MAX - 1).trimEnd()}…` : one
}

// A manifest's description: package.json's "description", or a TOML `description = "…"`.
export function manifestDescription(file: string, text: string): string {
  if (file === 'package.json') {
    const m = /"description"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)
    try { return m ? clip(JSON.parse(m[1]!) as string) : '' } catch { return '' }
  }
  // A TOML basic string ("…", with escapes) or literal string ('…', as is).
  const m = /^description\s*=\s*(?:("(?:[^"\\]|\\.)*")|'([^']*)')/m.exec(text)
  if (!m) return ''
  try { return clip(m[2] ?? JSON.parse(m[1]!) as string) } catch { return clip(m[1]!.slice(1, -1)) }
}

// A README's first sentence: its first paragraph of prose (no heading, badge,
// HTML or code), markdown links and emphasis removed.
export function readmeSentence(text: string): string {
  const paragraphs = text.replace(/```[\s\S]*?(```|$)/g, '').split(/\n\s*\n/)
  for (const p of paragraphs) {
    const prose = p.split('\n').filter(l => !/^\s*(#|!\[|\[!\[|<|=+$|-+$|\||>)/.test(l)).join(' ')
    const plain = prose.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
    if (plain.length < 3) continue
    return clip(/^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain)
  }
  return ''
}

// The output of REPO_LIST_SCRIPT (server/utils/pmRepos.ts) → each repository, its absolute path and description
// (the manifest's, else the README's first sentence).
export function parseRepoList(out: string, root: string): ListedRepo[] {
  const base = root.replace(/\/+$/, '')
  return out.split('\x1e').slice(1).flatMap((block) => {
    const [head = '', ...parts] = block.split('\x1f'), repo = head.replace(/\n$/, '')
    if (!isRepo(repo)) return []
    const files = parts.map((part) => { const i = part.indexOf('\n'); return { file: (i < 0 ? part : part.slice(0, i)).trim(), text: i < 0 ? '' : part.slice(i + 1) } })
    const manifest = files.find(f => !/^readme/i.test(f.file)), readme = files.find(f => /^readme/i.test(f.file))
    const does = (manifest && manifestDescription(manifest.file, manifest.text)) || (readme ? readmeSentence(readme.text) : '')
    return [{ repo, path: `${base}/${repo}`, does }]
  }).sort((a, b) => a.repo.localeCompare(b.repo))
}
