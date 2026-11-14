// `wherdr pm repo adopt <repo>` (docs/workspaces.md#adopting-a-repository): a
// workspace's coordinator makes a repository under the workspace's root one
// of its member projects, with no approval of the user. Key and name are
// proposed from the folder as the New sheet does; the color is the next
// free one. Nothing is cloned: a member runs only where its clone is.
import { isRepo } from './workspaceMap'
import { proposeKey, proposeName, type FolderProbe } from './newProject'
import { cloneOn, type Project } from './project'

export type RepoCommand = { name: 'repo adopt', repo: string }

export const REPO_COMMANDS = [
  { usage: 'repo adopt <repo>', does: 'make a repository under the workspace\'s root one of its member projects (<repo>: its path under the root, such as payroll-api, or its full path); key and color are picked for it, it takes the workspace\'s settings and workflow, and its visibility is checked. Refused outside the root, for a folder already a project, without git, or without an origin when the workflow pushes or opens pull requests. Nothing is cloned: it runs only on machines with its clone under their root. Written to the workspace\'s log' },
]

// `repo …` words (after `repo`) → a command, or why not.
export function parseRepo(words: string[]): RepoCommand | { error: string } {
  const [verb, repo, extra] = words
  if (verb !== 'adopt' || !repo || extra !== undefined || repo.length > 1024 || /[\x00-\x1f]/.test(repo)) return { error: `usage: wherdr pm ${REPO_COMMANDS[0]!.usage}` }
  return { name: 'repo adopt', repo }
}

const trim = (p: string) => p.replace(/\/+$/, '')

// The repository's path under the root, from a path under it (payroll-api,
// apps/web-app) or a full one (~/… needs home); refused outside the root.
export function repoUnder(arg: string, root: string, home = ''): string | { error: string } {
  const base = trim(root), full = trim(arg.trim().replace(/^~(?=\/|$)/, trim(home) || '~'))
  const rel = full.startsWith('/') || full.startsWith('~') ? (full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null) : full
  if (rel === null || rel.split('/').includes('..')) return { error: `${arg} is outside the workspace's root ${base}: adopt a repository under it` }
  return isRepo(rel) ? rel : { error: `${arg} is not a repository path under the root (payroll-api, apps/web-app; 4 folders at most)` }
}

// The root and the folder as the workspace's machine resolves them (symlinks
// followed: pwd -P), one per line; a line is empty when that folder is missing.
export const REAL_SCRIPT = `r=$(cd "$1" 2>/dev/null && pwd -P); f=$(cd "$2" 2>/dev/null && pwd -P); printf '%s\\n%s\\n' "$r" "$f"; exit 0`

// The repository's path under the root once resolved: a folder (or a symlink
// to one) outside the real root is refused; one inside is named by its real
// path, so two links to the same repository are the same one.
export function realRepo(rel: string, realRoot: string, realFolder: string): string | { error: string } {
  if (!realFolder) return rel // missing: the probe says so
  const base = trim(realRoot), folder = trim(realFolder)
  const real = base && folder.startsWith(`${base}/`) ? folder.slice(base.length + 1) : null
  if (real === null) return { error: `${rel} leads outside the workspace's root (to ${folder}): adopt a repository under it` }
  return isRepo(real) ? real : { error: `${rel} is not a repository path under the root (4 folders at most)` }
}

// Each project's folder on the machine (its own, or its clone there; ~ expanded
// as cloneOn does), to resolve with REAL_ALL_SCRIPT before ownership is checked.
export const foldersOn = (projects: Project[], machine: string, home: string) =>
  projects.flatMap((p) => { const f = cloneOn(p, machine, home); return f ? [{ project: p, folder: trim(f) }] : [] })
// Each argument resolved (pwd -P), one line each, "x" first so an empty one keeps its place.
export const REAL_ALL_SCRIPT = `for d in "$@"; do printf 'x%s\\n' "$(cd "$d" 2>/dev/null && pwd -P)"; done; exit 0`
export const realLines = (out: string, n: number) => {
  const lines = out.split('\n')
  return Array.from({ length: n }, (_, i) => (lines[i] ?? '').replace(/^x/, ''))
}

// The member to add: on the workspace's machine, its key and name from the folder.
export function adoptedMember(ws: Project, repo: string, projects: Project[]) {
  const name = proposeName(repo)
  const taken = projects.flatMap(p => [p.key, ...(p.aliases ?? [])])
  return { key: proposeKey(name, taken), name, machine: ws.machine, path: `${trim(ws.path)}/${repo}`, workspace: ws.key }
}

// Why the folder cannot be adopted ('' when it can). folders: its paths on the
// machine (as named, and resolved); owners: each project's folder on that
// machine (its own or its clone, from foldersOn), as written and resolved.
// needsOrigin: the workflow the member would run pushes or opens pull requests.
export function adoptRefusal(folders: string[], owners: { project: Project, folders: string[] }[], probe: Pick<FolderProbe, 'exists' | 'git' | 'remote'>, needsOrigin: boolean): string {
  const mine = new Set(folders.filter(Boolean).map(trim)), folder = folders[0]!
  const owner = owners.find(o => o.folders.some(f => f && mine.has(trim(f))))?.project
  if (owner) return `${folder} is already project ${owner.key}${owner.workspace ? ` (workspace ${owner.workspace})` : ''}: a repository belongs to one workspace at most`
  if (!probe.exists) return `${folder} does not exist: nothing is cloned for you, clone it under the root first`
  if (!probe.git) return `${folder} is not a git repository`
  if (needsOrigin && !probe.remote) return `${folder} has no origin, and the workflow its tasks would run pushes or opens pull requests: add the remote first`
  return ''
}

// The adoptions in the workspace's log since the last health check, for its summary.
export const adoptedSince = (log: { at: number, adopted?: { project: string, repo: string } }[], since: number) =>
  log.flatMap(e => (e.adopted && e.at > since ? [`${e.adopted.project} (${e.adopted.repo})`] : []))
