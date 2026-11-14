// Is a machine ready to take a project's tasks? READY_SCRIPT runs on it
// (machine.exec, after PATH_SETUP) and prints one line per check,
// `<id> ok|fail|warn <detail>`; readyOf turns them into a result and
// readyRefusal into the reason a start is refused. Checks that do not apply
// (no package.json, no PR step, not a visual task) print nothing.
//
// Arguments: clone, base branch ('' none), wherdr's base URL ('' skips the
// check), gh (1: the workflow uses GitHub), visual (1: screenshots), then the
// agent programs the task needs (worker, reviewer).
export const READY_SCRIPT = `export DISABLE_AUTOUPDATER=1
clone=$1 base=$2 wherdr=$3 gh=$4 visual=$5; shift 5
say() { printf '%s %s %s\\n' "$1" "$2" "$(printf %s "$3" | tail -n 1 | cut -c1-200)"; }
check() { id=$1; shift; if out=$("$@" 2>&1 </dev/null); then say "$id" ok "$out"; else say "$id" fail "$out"; fi; }
if ! git -C "$clone" rev-parse --git-dir >/dev/null 2>&1; then say clone fail "no git repository in $clone"; else
  check clone git -C "$clone" remote get-url origin
  check fetch git -C "$clone" fetch -q origin \${base:+"$base"}
  check push git -C "$clone" push -q --dry-run origin HEAD:refs/heads/wherdr-ready-check
fi
[ "$gh" = 1 ] && check gh gh auth status
if [ -f "$clone/package.json" ]; then
  want=$(cat "$clone/.nvmrc" 2>/dev/null || sed -n 's/.*"node" *: *"\\([^"]*\\)".*/\\1/p' "$clone/package.json" | head -n 1)
  if v=$(node --version 2>&1); then say node ok "$v want=$want"; else say node fail "$v"; fi
  check npm npm --version
  if [ -f "$clone/package-lock.json" ]; then
    if [ -f "$clone/node_modules/.package-lock.json" ] && [ ! "$clone/package-lock.json" -nt "$clone/node_modules/.package-lock.json" ]; then say deps ok installed
    else say deps warn "not installed in the clone: each task runs npm ci"; fi
  fi
fi
for p in "$@"; do
  if ! command -v "$p" >/dev/null 2>&1; then say "agent:$p" fail "$p is not installed"
  else case $p in claude) check "agent:$p" claude auth status;; codex) check "agent:$p" codex login status;; *) say "agent:$p" ok "";; esac; fi
done
pm=$HOME/.wherdr/pm
check pm sh -c 'mkdir -p "$1/worktrees" "$1/tasks" && : > "$1/tasks/.ready-check" && rm -f "$1/tasks/.ready-check"' sh "$pm"
say disk ok "$(df -Pk "$pm" 2>/dev/null | awk 'NR==2 { print $4 }')"
[ -n "$wherdr" ] && check reach curl -fsS -m 5 -o /dev/null "$wherdr/api/health"
if [ "$visual" = 1 ]; then
  if ! v=$(cd "$clone" && npx --no-install playwright --version 2>&1); then say browsers fail "$v"; else
    found=; for d in "$HOME/.cache/ms-playwright"/chromium* "$HOME/Library/Caches/ms-playwright"/chromium*; do [ -d "$d" ] && found=1; done
    if [ -n "$found" ]; then say browsers ok "$v"; else say browsers fail "no Chromium in the Playwright cache: run npx playwright install chromium"; fi
  fi
fi
exit 0`

export interface ReadyItem { id: string, ok: boolean, warn?: true, detail: string }
export interface Readiness { items: ReadyItem[], at: number }

const NAMES: Record<string, string> = {
  clone: 'clone', fetch: 'git fetch', push: 'push rights', gh: 'gh login', node: 'node', npm: 'npm', deps: 'dependencies',
  pm: 'wherdr folders', disk: 'disk space', reach: 'reaching wherdr', browsers: 'browsers',
}
export const readyName = (id: string) => NAMES[id] ?? (id.startsWith('agent:') ? `${id.slice(6)} login` : id)

const MIN_FREE_KB = 5 * 1024 * 1024 // a worktree and a copy of node_modules

// The same repository, whatever the URL's form (https, ssh, scp-like, .git, a user).
export const sameRepo = (a: string, b: string) => {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').replace(/\.git$/, '').replace(/^[a-z+]+:\/\/([^@/]+@)?/i, '').replace(/^[^@/:]+@([^:/]+):/, '$1/').toLowerCase()
  return !!a.trim() && norm(a) === norm(b)
}

// node's major against the wanted one: '22', 'v22.3', '>=20' (anything else: any version).
function nodeFits(version: string, want: string) {
  const major = Number(/^v?(\d+)/.exec(version)?.[1])
  const m = /^\s*(>=)?\s*v?(\d+)/.exec(want)
  if (!m || !major) return true
  return m[1] ? major >= Number(m[2]) : major === Number(m[2])
}

// origin: the home clone's origin, which every other clone must share.
export function readyOf(out: string, origin: string, at = Date.now()): Readiness {
  const items: ReadyItem[] = []
  for (const line of out.split('\n')) {
    const m = /^([a-z]+(?::[a-z0-9_-]+)?) (ok|fail|warn) ?(.*)$/.exec(line.trim())
    if (!m) continue
    const [, id, verdict, raw] = m as unknown as [string, string, string, string]
    let ok = verdict !== 'fail', detail = raw.trim()
    if (id === 'clone' && ok && !sameRepo(detail, origin)) { ok = false; detail = origin ? `its origin is ${detail}, not the project's ${origin}` : 'the project\'s own clone has no origin to share' }
    if (id === 'node' && ok) {
      const [version = '', want = ''] = detail.split(' want=')
      ok = nodeFits(version, want)
      detail = ok ? version : `${version}, the project wants ${want.trim()}`
    }
    if (id === 'disk') {
      const kb = Number(detail)
      ok = !!detail && kb >= MIN_FREE_KB
      detail = detail ? `${(kb / 1024 / 1024).toFixed(1)} GB free${ok ? '' : ', 5 GB needed'}` : 'free space unknown'
    }
    if (!ok && id.startsWith('agent:') && !/not installed/.test(detail)) detail = 'not logged in'
    items.push({ id, ok, ...(verdict === 'warn' ? { warn: true as const } : {}), detail })
  }
  return { items, at }
}

// Why the machine cannot take the task (each failed check, one line), or undefined.
export function readyRefusal(r: Readiness) {
  if (!r.items.length) return 'the check could not run'
  const failed = r.items.filter(i => !i.ok)
  return failed.length ? failed.map(i => `${readyName(i.id)}: ${i.detail}`).join('; ') : undefined
}
