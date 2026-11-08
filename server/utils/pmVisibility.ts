// Whether a project's repository is public: checked once, on its machine (the
// remote, then `gh repo view`, else the host's public API; no network call
// without a remote), and kept on the project. The rules themselves are in
// shared/pm/visibility.ts.
import { HerdrError } from './herdr'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
import type { Project } from '../../shared/pm/project'
import { apiUrl, ownLeakCheck, parseRemote, visibilityFromApi, visibilityFromGh, type Visibility } from '../../shared/pm/visibility'

type Deps = CoreAdminDeps & { store: PmStore }
const SEP = '--wherdr-leak--'

// The remote's URL (origin, else the first one), then gh's answer when gh is
// there and logged in. Only a missing folder fails: gh's own failure (absent,
// logged out, not a GitHub remote) leaves the host's API to answer.
export const REMOTE_SCRIPT = `cd "$1" 2>/dev/null || exit 1
r=$(git remote | grep -qx origin && echo origin || git remote | head -n 1)
[ -n "$r" ] || exit 0
u=$(git remote get-url "$r") || exit 0
echo "$u"
command -v gh >/dev/null 2>&1 && GH_PROMPT_DISABLED=1 gh repo view "$u" --json visibility 2>/dev/null
exit 0`

export async function detectVisibility(deps: CoreAdminDeps, p: Pick<Project, 'machine' | 'path'>, fetcher: typeof fetch = fetch): Promise<Visibility> {
  const r = await exec(deps, machineOn(deps, p.machine).on, REMOTE_SCRIPT, [p.path])
  if (r.code !== 0) throw new HerdrError('core', 'Could not read the project\'s git remote')
  const [url = '', ...gh] = r.out.split('\n')
  const remote = parseRemote(url)
  if (!remote) return 'unknown'
  const v = visibilityFromGh(gh.join('\n'))
  const api = apiUrl(remote)
  if (v !== 'unknown' || !api) return v
  try {
    const res = await fetcher(api, { headers: { accept: 'application/json', 'user-agent': 'wherdr' }, signal: AbortSignal.timeout(10000) })
    return visibilityFromApi(res.status, await res.json().catch(() => null))
  }
  catch { return 'unknown' }
}

// "Check again", or the first check: the result is kept with its date.
export async function checkVisibility(deps: Deps, key: unknown, fetcher?: typeof fetch) {
  const p = await deps.store.project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  return deps.store.setVisibility(p.key, { value: await detectVisibility(deps, p, fetcher), at: Date.now(), by: 'check' })
}

// Before a coordinator or a task starts: checked once, never again on its own.
// A machine that cannot answer leaves it unchecked (tried at the next start).
// A folder without git has no remote to check.
export async function ensureVisibility(deps: Deps, p: Project, fetcher?: typeof fetch): Promise<Project> {
  if (p.visibility || p.git === false) return p
  return checkVisibility(deps, p.key, fetcher).catch(() => p)
}

// The worktree's own leak check (ownLeakCheck), and with diff, the lines its
// branch adds (git diff -U0 since it started).
export const LEAK_READ_SCRIPT = `cd "$1" 2>/dev/null || exit 1
cat package.json 2>/dev/null; echo; echo "${SEP}"
ls -A; h=$(git rev-parse --git-path hooks/pre-commit 2>/dev/null); [ -n "$h" ] && [ -x "$h" ] && echo .git-hook; echo "${SEP}"
[ "$3" = diff ] || exit 0
s=$(git config "branch.$2.wherdrstart")
git diff -U0 --no-color \${s:+"$s"} HEAD 2>/dev/null | head -c 4000000`

export async function readLeakCheck(deps: CoreAdminDeps, on: string | undefined, run: { worktree: string, branch: string }, diff = false) {
  const r = await exec(deps, on, LEAK_READ_SCRIPT, [run.worktree, run.branch, diff ? 'diff' : ''])
  // Unread: never a silent pass (the signal is tried again at the next tick).
  if (r.code !== 0) throw new HerdrError('core', 'Could not read the task\'s worktree for the leak scan')
  const [pkg = '', names = '', d = ''] = r.out.split(new RegExp(`${SEP}\\n?`))
  return { check: ownLeakCheck(pkg, names.split('\n').map(n => n.trim())), diff: d }
}
