// Processes an agent leaves behind. Ending an agent ends its terminal's whole
// process tree and every process group in it (groupTargets): a test runner's
// shells re-parented to init keep their group. A sweep finds the rest by the
// mark every agent's process inherits (orphanTargets): CLAUDE_CODE_TMPDIR set to
// its task's `.wherdr-tmp` (agentEnv), never by its folder alone, which an app
// or daemon of the user's may share. macOS hides the environment of its own
// binaries (sh, zsh, bash, sleep): those go with a marked leftover they are
// under or in the group of, or, re-parented to init, by their folder (one
// whose worktree was removed too). A CPU guard (hotTargets) catches what runs
// hot for long in a task's folder.
import { TMP_DIR } from './run'
import { underRoot } from './cleanup'

// unread: an environment macOS would not show (cwd then read too).
export interface Proc { pid: number, ppid: number, pgid: number, age: number, comm: string, cpu?: number, tmp?: string, unread?: true, cwd?: string }

const MARK = 'CLAUDE_CODE_TMPDIR='
// Lines `p<pid>`, `P<ppid>`, `g<pgid>`, `t<elapsed>`, `x<%cpu>`, `c<command>`, then with
// $1 = env `e<its CLAUDE_CODE_TMPDIR>` for the processes that have one (ps -E
// on macOS, /proc/<pid>/environ on Linux, where every process of the user's
// is read); on macOS, `u` for an environment not shown (no HOME or PATH) and
// `n<folder>` (lsof -F, as peaks.ts); on Linux, `n<folder>` of the processes
// working under the root $2 (/proc/<pid>/cwd). `W` once that root is read,
// then `w<task>` per worktree in it.
export const PROCS_SCRIPT = `ps -A -o pid=,ppid=,pgid=,etime=,%cpu=,comm= | awk '{c=$6; for(i=7;i<=NF;i++) c=c" "$i; print "p"$1; print "P"$2; print "g"$3; print "t"$4; print "x"$5; print "c"c}'
[ "$1" = env ] || exit 0
if [ -n "$2" ] && [ -d "$2" ]; then echo W; for d in "$2"/*/; do [ -d "$d" ] && d=\${d%/} && echo "w\${d##*/}"; done; fi
if [ "$(uname -s)" = Darwin ]; then ps -A -wwE -o pid=,command= 2>/dev/null | awk '{v=""; r=0; for(i=2;i<=NF;i++) {if (index($i,"${MARK}")==1) v=substr($i,${MARK.length + 1}); if (index($i,"HOME=")==1 || index($i,"PATH=")==1) r=1}; print "p"$1; if (v!="") print "e"v; if (!r) print "u"}'
  lsof -a -d cwd -Fpn 2>/dev/null || true
else grep -a -z -o -m1 '^${MARK}.*' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | awk '{f=$0; sub(":.*","",f); gsub("[^0-9]","",f); print "p"f; print "e"substr($0, index($0,"=")+1)}'
  [ -n "$2" ] && for c in /proc/[0-9]*/cwd; do t=$(readlink "$c" 2>/dev/null) || continue; case "$t" in "$2"/*) c=\${c#/proc/}; printf 'p%s\\nn%s\\n' "\${c%/cwd}" "\${t% (deleted)}" ;; esac; done; fi`

// TERM, then KILL for those still there after 3 s; fails when one is still
// there after that. Gone only when kill says so (ESRCH) or ps shows a
// zombie; any other answer (another user's, ps failing) counts as running.
const KILL_FN = `alive() {
e=$(LC_ALL=C kill -0 "$1" 2>&1) || case "$e" in *"No such process"*) return 1 ;; esac
case "$(ps -o stat= -p "$1" 2>/dev/null)" in *Z*) return 1 ;; esac; return 0
}
kill_all() {
kill -TERM "$@" 2>/dev/null
for i in 1 2 3 4 5 6; do a=; for p; do alive "$p" && a=1; done; [ -z "$a" ] && return 0; sleep 0.5; done
kill -KILL "$@" 2>/dev/null; sleep 0.5
for p; do alive "$p" && return 1; done; return 0
}`
export const KILL_SCRIPT = `${KILL_FN}
kill_all "$@"`

// Every process whose working folder is $dir or under it (a removed one
// too), marked or not, never this shell: killed, then \`killed <n>\` printed.
// Exit 3 when the folders could not be read or one is still running.
export const KILL_UNDER = `${KILL_FN}
d=$(cd "$dir" 2>/dev/null && pwd -P) || d=$dir
cwds=
if [ "$(uname -s)" = Darwin ]; then cwds=$(lsof -a -d cwd -Fpn 2>/dev/null) || cwds=
else [ -d /proc/self ] && cwds=$(for c in /proc/[0-9]*/cwd; do t=$(readlink "$c" 2>/dev/null) && c=\${c#/proc/} && printf 'p%s\\nn%s\\n' "\${c%/cwd}" "$t"; done); fi
# This shell's own folder is always there: lsof failed or none read, nothing known.
[ -n "$cwds" ] || { echo "the processes working in it could not be listed"; exit 3; }
pids=$(printf '%s\\n' "$cwds" | awk -v d="$d" -v me=$$ '/^p/ {p=substr($0,2)} /^n/ {n=substr($0,2); sub(/ \\(deleted\\)$/,"",n); if ((n==d || index(n,d"/")==1) && p!=me) print p}')
if [ -n "$pids" ]; then
  kill_all $pids || { echo "a process working in it could not be killed"; exit 3; }
  echo "killed $(echo $pids | wc -w | tr -d ' ')"
fi`

// ps's elapsed time, [[dd-]hh:]mm:ss → seconds.
export function seconds(etime: string) {
  const [d, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  return (rest ?? '').split(':').reduce((s, x) => s * 60 + Number(x), 0) + Number(d) * 86400
}

export function parseProcs(text: string): Proc[] {
  const out = new Map<number, Proc>()
  let cur: Proc | undefined
  for (const line of text.split('\n')) {
    const k = line[0], v = line.slice(1).trim()
    if (k === 'p') {
      const pid = Number(v)
      cur = out.get(pid) ?? { pid, ppid: 0, pgid: 0, age: 0, comm: '' }
      out.set(pid, cur)
    }
    else if (!cur) continue
    else if (k === 'P') cur.ppid = Number(v)
    else if (k === 'g') cur.pgid = Number(v)
    else if (k === 't') cur.age = seconds(v) || 0
    else if (k === 'x') cur.cpu = Number(v) || 0
    else if (k === 'c') cur.comm = v
    else if (k === 'e') cur.tmp = v
    else if (k === 'u') cur.unread = true
    else if (k === 'n') cur.cwd = v
  }
  return [...out.values()].filter(p => p.pid > 1 && p.comm)
}

const children = (procs: Proc[]) => {
  const m = new Map<number, Proc[]>()
  for (const p of procs) m.set(p.ppid, [...(m.get(p.ppid) ?? []), p])
  return m
}
function tree(kids: Map<number, Proc[]>, pid: number, out = new Set<number>()) {
  if (out.has(pid)) return out
  out.add(pid)
  for (const c of kids.get(pid) ?? []) tree(kids, c.pid, out)
  return out
}

// The pids to end with the terminal whose shell is `root`: its tree, and every
// process of a group one of them is in, but never the group of herdr-core (the
// shell's parents) nor init.
export function groupTargets(procs: Proc[], root: number): number[] {
  const by = new Map(procs.map(p => [p.pid, p]))
  if (!by.has(root)) return []
  const above = new Set<number>()
  for (let p = by.get(by.get(root)!.ppid); p && !above.has(p.pgid); p = by.get(p.ppid)) above.add(p.pgid)
  const mine = tree(children(procs), root)
  const groups = new Set([...mine].map(pid => by.get(pid)!.pgid).filter(g => g > 1 && !above.has(g)))
  return procs.filter(p => mine.has(p.pid) || groups.has(p.pgid)).map(p => p.pid).sort((a, b) => a - b)
}

export interface Leftovers { task: string, pids: number[], age: number, cpu: number }

// The task worktrees that exist (PROCS_SCRIPT's `w` lines; the root not read: undefined).
export function worktreesIn(text: string): Set<string> | undefined {
  const lines = text.split('\n')
  return lines.includes('W') ? new Set(lines.filter(l => l[0] === 'w').map(l => l.slice(1))) : undefined
}

const INIT = new Set(['launchd', 'systemd', 'init'])
// The system's own binaries, whose environment macOS hides (sh, zsh, sleep,
// cat), by path or by bare name (`sh -c`: ps shows `sh`).
const SYSTEM_BIN = /^(\/(usr\/)?(s?bin|libexec)\/)?[^/]+$/

// Per task, the leftovers under `root` (the pm worktrees folder) of a task
// with no live agent (or a removed one), never `keep`:
// - a process marked with its `.wherdr-tmp`, wherever it runs;
// - an unmarked one under such a process or in its process group;
// - a system binary whose environment macOS hides, in its worktree (or in
//   one removed since, whatever its task: not in `worktrees`) and re-parented
//   to init (or a subreaper), with all it started.
// An unmarked process whose environment can be read (the user's apps,
// daemons, editors) or that a terminal app holds (the user's shell) is never
// touched on its own.
export function orphanTargets(procs: Proc[], root: string, live: (task: string) => boolean, keep: number[] = [], worktrees?: Set<string>): Leftovers[] {
  const base = `${root.replace(/\/+$/, '')}/`, by = new Map(procs.map(p => [p.pid, p])), kids = children(procs)
  const idIn = (path: string | undefined, tmpOnly: boolean) => {
    if (!path || !underRoot(path, root)) return undefined
    const [id, tmp, ...rest] = path.slice(base.length).replace(/\/+$/, '').split('/')
    if (tmpOnly && (tmp !== TMP_DIR || rest.length)) return undefined
    return id && (!live(id) || (!tmpOnly && worktrees && !worktrees.has(id))) ? id : undefined
  }
  const owner = new Map<number, string>()
  for (const p of procs) {
    const parent = by.get(p.ppid)
    const detached = p.ppid <= 1 || (!!parent && INIT.has(parent.comm.split('/').pop()!))
    const id = p.tmp ? idIn(p.tmp, true) : p.unread && detached && SYSTEM_BIN.test(p.comm) ? idIn(p.cwd, false) : undefined
    if (id) owner.set(p.pid, id)
  }
  const groups = new Map([...owner].map(([pid, id]) => [by.get(pid)!.pgid, id] as const).filter(([g]) => g > 1))
  for (const [pid, id] of [...owner]) for (const d of tree(kids, pid)) if (!by.get(d)!.tmp && !owner.has(d)) owner.set(d, id)
  for (const p of procs) if (!p.tmp && !owner.has(p.pid) && groups.has(p.pgid)) owner.set(p.pid, groups.get(p.pgid)!)
  const out = new Map<string, Proc[]>()
  for (const [pid, id] of owner) if (!keep.includes(pid)) out.set(id, [...(out.get(id) ?? []), by.get(pid)!])
  return [...out].map(([task, ps]) => ({ task, pids: ps.map(p => p.pid).sort((a, b) => a - b), age: Math.max(...ps.map(p => p.age)), cpu: Math.max(...ps.map(p => p.cpu ?? 0)) }))
}

// The CPU guard: over HOT.cpu % for HOT.ms (seen at each sweep), a process
// of a task (marked with its temp folder, or working in its worktree) is
// killed once its task has no live agent; while the agent runs, its
// coordinator is told once.
export const HOT = { cpu: 80, ms: 20 * 60_000 } as const
export function hotProcs(procs: Proc[], root: string, keep: number[] = []) {
  const base = `${root.replace(/\/+$/, '')}/`
  const task = (p: Proc) => [p.tmp, p.cwd].map(x => x && underRoot(x, root) ? x.slice(base.length).split('/')[0] : '').find(Boolean)
  return procs.filter(p => (p.cpu ?? 0) >= HOT.cpu && !keep.includes(p.pid)).flatMap(p => (task(p) ? [{ task: task(p)!, proc: p }] : []))
}

// Hot since when, per `<pid> <command>`: those not hot now are forgotten, a
// task whose agent started or ended starts again. `told`: set by the caller
// once a coordinator was woken (offered again at each sweep until then).
export type HotSeen = Map<string, { since: number, live: boolean, told?: true }>
export const hotKey = (p: Proc) => `${p.pid} ${p.comm}`
export function hotTargets(seen: HotSeen, hot: { task: string, proc: Proc }[], live: (task: string) => boolean, now: number) {
  const keys = new Set<string>(), kill: typeof hot = [], tell: (typeof hot[number] & { key: string })[] = []
  for (const h of hot) {
    const key = hotKey(h.proc), on = live(h.task)
    keys.add(key)
    const s = seen.get(key)?.live === on ? seen.get(key)! : { since: now, live: on }
    seen.set(key, s)
    if (now - s.since < HOT.ms) continue
    if (!on) { kill.push(h); seen.delete(key) }
    else if (!s.told) tell.push({ ...h, key })
  }
  for (const k of [...seen.keys()]) if (!keys.has(k)) seen.delete(k)
  return { kill, tell }
}

// '6 h', '12 min', '40 s': the log's "killed 7 leftover processes, 6 h old".
export const ageText = (s: number) => s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`
