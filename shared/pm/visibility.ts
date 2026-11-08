// Whether a project's repository is public, and the rules that keep private
// things out of it when it is: the text its coordinator, workers and reviewers
// read, the repo's own leak check, and a built-in scan of a task's diff. Pure:
// server/utils/pmVisibility.ts runs the commands and the API call.

export type Visibility = 'public' | 'private' | 'unknown'
// Found by wherdr's check, or set by the user in Settings › Projects.
export interface RepoVisibility { value: Visibility, at: number, by: 'check' | 'user' }
export const isPublic = (p: { visibility?: RepoVisibility }) => p.visibility?.value === 'public'

export interface Remote { host: string, path: string } // path: owner/repo (GitLab: group/sub/repo)

// A git remote URL → its host and repository path; credentials dropped.
// https://github.com/o/r.git, git@github.com:o/r.git, ssh://git@host:22/o/r
export function parseRemote(url: string): Remote | null {
  const u = url.trim()
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u) ?? /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(u)
  if (!m) return null
  const path = m[2]!.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  return /^[\w.-]+(\/[\w.-]+)+$/.test(path) ? { host: m[1]!.toLowerCase(), path } : null
}

// `gh repo view --json visibility` → its answer.
export function visibilityFromGh(out: string): Visibility {
  try {
    const v = String((JSON.parse(out) as { visibility?: unknown }).visibility ?? '').toLowerCase()
    return v === 'public' ? 'public' : v === 'private' || v === 'internal' ? 'private' : 'unknown'
  }
  catch { return 'unknown' }
}

// The host's public API for a repository, without a login: only GitHub, GitLab and Bitbucket.
export function apiUrl(r: Remote): string | undefined {
  if (r.host === 'github.com') return `https://api.github.com/repos/${r.path}`
  if (r.host === 'gitlab.com') return `https://gitlab.com/api/v4/projects/${encodeURIComponent(r.path)}`
  if (r.host === 'bitbucket.org') return `https://api.bitbucket.org/2.0/repositories/${r.path}`
}

// The API's answer without a login: a private repository is not found (404).
export function visibilityFromApi(status: number, body: unknown): Visibility {
  if (status === 404) return 'private'
  if (status !== 200 || !body || typeof body !== 'object') return 'unknown'
  const b = body as { private?: unknown, visibility?: unknown, is_private?: unknown }
  if (b.private === false || b.is_private === false || b.visibility === 'public') return 'public'
  if (b.private === true || b.is_private === true || b.visibility === 'private' || b.visibility === 'internal') return 'private'
  return 'unknown'
}

// The repo's own leak check, from its package.json and the names at its root
// (and '.git-hook' when git runs a pre-commit hook): the command to run before
// each commit, '' when its hook runs it on each commit, or undefined (none).
export function ownLeakCheck(pkg: string, names: string[]): string | undefined {
  let scripts: Record<string, unknown> = {}
  try { scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {} }
  catch {}
  const script = Object.keys(scripts).find(k => /leak|secret/i.test(k))
  if (script) return `npm run ${script}`
  if (names.some(n => /^\.?gitleaks\.toml$/.test(n))) return 'gitleaks protect --staged'
  if (names.includes('.pre-commit-config.yaml')) return 'pre-commit run'
  if (names.includes('.git-hook')) return ''
}

// The rule, one text for the coordinator, the worker and the reviewer.
export const PUBLIC_RULE = 'This project\'s repository is public. Never commit, and never put in a branch, a PR, a commit message, a task description or a screenshot: private paths (home folders), machine or host names, e-mail addresses, tokens or secrets, real conversations or user data, or screenshots that show any of them. Use placeholders (`~/project`, `user@example.com`).'

// The worker's section. check: its repo's own command, '' (its hook), or undefined (the engine's scan).
export function publicWorkerSection(check: string | undefined) {
  return ['## Public repository', '', PUBLIC_RULE,
    check ? `Before each commit, run \`${check}\` and fix what it finds.`
    : check === '' ? 'The repository\'s pre-commit hook checks for leaks: never skip it (no --no-verify).'
    : 'When you say you are done, wherdr scans your diff for home paths, e-mail addresses and token shapes: a finding keeps the step open until you remove it.', '']
}

export const publicReviewSection = () =>
  ['## Public repository', '', PUBLIC_RULE, 'Check the diff, commit messages and screenshots for it: any leak is a critical finding.', '']

// Placeholders that leak nothing.
const SAFE_HOME = /^(user|username|you|me|name|runner|ubuntu|node|alice|bob|someone|example|x|u)$/i
const SAFE_MAIL = /^git@|@example\.(com|org|net)$|noreply|no-reply|@localhost$/i
const LEAKS: { what: string, re: RegExp, ok?: (m: RegExpExecArray) => boolean }[] = [
  { what: 'home path', re: /(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)([A-Za-z0-9._-]+)/, ok: m => SAFE_HOME.test(m[1]!) || m[1] === '$USER' },
  { what: 'e-mail address', re: /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, ok: m => SAFE_MAIL.test(m[0]) },
  { what: 'token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,}|glpat-[\w-]{20,}|sk-(?:ant-)?[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,})\b/ },
  { what: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]
export interface Leak { file: string, what: string }

// The lines a diff (git diff -U0) adds that look like a leak: one per file and kind.
export function scanDiff(diff: string): Leak[] {
  const out: Leak[] = []
  let file = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue }
    if (!line.startsWith('+')) continue
    for (const l of LEAKS) {
      const re = new RegExp(l.re.source, 'g')
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (l.ok?.(m)) continue
        if (!out.some(x => x.file === file && x.what === l.what)) out.push({ file, what: l.what })
        break
      }
    }
  }
  return out
}

export const leakText = (leaks: Leak[]) =>
  `This repository is public and your diff adds what looks private: ${leaks.map(l => `${l.what} in ${l.file}`).join('; ')}. Remove it from the commits that added it (a placeholder instead; amend or rebase: a later commit would leave it in the history), then say you are done again.`
