// The git repositories under a machine's home folder, for the New sheet's
// project form: one `find` a few levels deep, skipping hidden folders (so
// herdr's own worktrees too), node_modules and macOS's Library. Kept a few
// minutes per machine; refresh looks again.
import { posix as px } from 'node:path'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import { HerdrError } from './herdr'
import type { Project } from '../../shared/pm/project'

export const REPO_DEPTH = 4 // ~/a/b/c/.git: a repository three folders down
const MAX = 500
export const REPOS_SCRIPT = `cd "$HOME" 2>/dev/null || exit 1
printf '%s\\n' "$HOME"
find . -mindepth 1 -maxdepth ${REPO_DEPTH} \\( -name node_modules -o -name Library -o \\( -name '.*' ! -name .git \\) \\) -prune -o -name .git -print 2>/dev/null | head -n ${MAX}
exit 0`

// The script's output (home, then ./a/b/.git lines): absolute paths, sorted.
export function parseRepos(out: string): { home: string, repos: string[] } {
  const [home = '', ...lines] = out.split('\n')
  const repos = new Set<string>()
  for (const l of lines) {
    const rel = l.trim().replace(/^\.\//, '').replace(/\/?\.git$/, '')
    if (rel && !rel.split('/').includes('..')) repos.add(px.join(home, rel))
  }
  return { home, repos: [...repos].sort((a, b) => a.localeCompare(b)) }
}

const TTL = 5 * 60_000
const cache = new Map<string, { at: number, home: string, repos: string[] }>()

export async function findRepos(deps: CoreAdminDeps, machine: string, { refresh = false, now = Date.now() } = {}) {
  const { on } = machineOn(deps, machine)
  const old = cache.get(machine)
  if (old && !refresh && now - old.at < TTL) return { home: old.home, repos: old.repos }
  const r = await exec(deps, on, REPOS_SCRIPT, [])
  if (r.code !== 0) throw new HerdrError('core', 'Could not look for git repositories on this machine')
  const found = parseRepos(r.out)
  cache.set(machine, { at: now, ...found })
  return found
}

// The remote branches of a project's repository (origin, as last fetched),
// for its working branch field. A repository without origin: none.
export const BRANCHES_SCRIPT = `git -C "$1" for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin 2>/dev/null | grep -vx HEAD | head -n ${MAX}
exit 0`
export const parseBranches = (out: string) => [...new Set(out.split('\n').map(l => l.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))

export async function remoteBranches(deps: CoreAdminDeps, p: Pick<Project, 'machine' | 'path'>) {
  const { on } = machineOn(deps, p.machine)
  const r = await exec(deps, on, BRANCHES_SCRIPT, [p.path])
  if (r.code !== 0) throw new HerdrError('core', 'Could not read the branches of this repository')
  return parseBranches(r.out)
}
