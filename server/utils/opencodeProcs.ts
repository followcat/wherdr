// Bounded OpenCode process scan on one machine, for the pane -> session
// selection in opencodeCore.ts. One Linux /proc scan per call (a single
// bounded script round trip through ShellExec: machine.exec on a remote core
// host, localShell locally). It reports every live process that could be an
// OpenCode agent — inside or outside core's terminal inventory — with its
// generation (start ticks), NUL-boundary argv, actual cwd and a conservative
// birth bound. The producer may over-emit but must never emit less than the
// parser could classify: a hidden peer is the unsafe direction, because two
// live OpenCode processes in one cwd refuse selection.
import type { ShellExec } from './fsx'
import { birthUpperBound } from './devinProcesses'

const MAX_CMDLINE = 16384
// Producer stdout is bounded: maxr records of a few hundred bytes each stay
// far under the ShellExec maxBytes and core's reply limit. $1: proc root
// (tests inject a synthetic one), $2: max pid dirs, $3: max records.
// Emitted rows: `S pid ticks up wall cwdb argvb mark` where cwdb/argvb are
// base64 (argvb keeps NUL separators so argv survives intact) and mark is
// 'u' for an emitted-but-unclassifiable empty-argv shape (bounded uncertain
// evidence — its cwd is proven before it can block anything). 'U pid'
// counts a live process the scan could not even sample; `T` carries
// scanned/emitted/overflow/unknown counts. The wall stamp follows every
// byte the parser may classify on, so it witnesses this generation's shape.
export const OPENCODE_PROCS_SCRIPT = `P=$1
maxd=\${2:-8192}
maxr=\${3:-128}
hz=$(getconf CLK_TCK 2>/dev/null); [ -n "$hz" ] || hz=-
boot=$(awk '$1 == "btime" { print $2 }' "$P/stat" 2>/dev/null); [ -n "$boot" ] || boot=-
if [ -d "$P" ] && [ -r "$P/uptime" ]; then ok=1; else ok=0; fi
printf 'H %s %s %s\\n' "$hz" "$boot" "$ok"
if [ "$ok" != 1 ]; then printf 'T 0 0 0 0\\n'; exit 0; fi
n=0; r=0; o=0; u=0
i1=$(printf '\\001')
for d in "$P"/[0-9]*; do
  [ -e "$d/stat" ] || continue
  pid=\${d##*/}
  n=$((n+1)); [ "$n" -le "$maxd" ] || { o=$((o|1)); continue; }
  # stat/comm come through builtin reads — no per-pid forks. The comm gate
  # below is the only prefilter: a comm outside it can never classify (the
  # agent's own name, a JS runtime or interpreter hosting a script-shaped
  # opencode, a launcher whose argv may still name it) nor carry a peer
  # shape, so it never pays for cmdline reads.
  st=; comm=
  IFS= read -r st < "$d/stat" 2>/dev/null
  IFS= read -r comm < "$d/comm" 2>/dev/null
  st1=\${st##*) }
  case $comm in ''|opencode|node|nodejs|node-*|bun|bunx|deno|python|python?*|npm|npx|timeout|sudo|doas|nice|ionice|setsid|busybox) ;; *) continue ;; esac
  args=$(head -c ${MAX_CMDLINE + 1} "$d/cmdline" 2>/dev/null | tr '\\000' '\\001')
  if [ -z "$st1$args$comm" ]; then [ -e "$d/stat" ] && u=$((u+1)); continue; fi
  set -- $st1
  state=$1; t1=\${20:-}; [ -n "$t1" ] || t1=-
  a0=\${args%%$i1*}
  a0b=\${a0##*/}
  em=
  if [ -z "$args" ]; then
    # Empty cmdline proves nothing: a zombie/dead state is excluded, but a
    # live interpreter- or agent-shaped comm (or an unreadable one) may hide
    # a peer — emit it as bounded uncertain evidence so its own cwd can
    # scope it, instead of a recordless unknown.
    case $state in
      Z|X|x) continue ;;
    esac
    case $comm in ''|opencode|node|nodejs|node-*|bun|bunx|deno) em=u ;; esac
  else
    case $comm in opencode) em=1 ;; esac
    case $a0b in opencode) em=1 ;; esac
    # An opencode named anywhere in the first argv elements: npx opencode,
    # node /x/opencode, env X=1 opencode, a rewritten argv0. The launcher
    # itself is never classified here — only the opencode element emits.
    oifs=$IFS; IFS=$i1; set -f; set -- $args; set +f; IFS=$oifs
    k=0
    for a do
      k=$((k+1)); [ $k -gt 8 ] && break
      case \${a##*/} in opencode) em=1; break ;; esac
    done
    [ -z "$em" ] && { e=$(basename "$(readlink "$d/exe" 2>/dev/null)" 2>/dev/null); [ "$e" = opencode ] && em=1; }
  fi
  [ -n "$em" ] || continue
  [ $r -lt "$maxr" ] || { o=$((o|2)); continue; }
  up=; read -r up _ < "$P/uptime" 2>/dev/null; [ -n "$up" ] || up=-
  argvb=$(printf %s "$args" | tr '\\001' '\\000' | base64 | tr -d '\\n')
  cwd=$(readlink "$d/cwd" 2>/dev/null)
  cwdb=$(printf %s "$cwd" | base64 | tr -d '\\n')
  st2=; IFS= read -r st2 < "$d/stat" 2>/dev/null
  set -- \${st2##*) }
  t2=\${20:-}
  wall=$(date +%s.%N 2>/dev/null); [ -n "$wall" ] || wall=-
  if [ "$t1" != "$t2" ]; then u=$((u+1)); continue; fi
  printf 'S %s %s %s %s %s %s %s\\n' "$pid" "$t1" "$up" "$wall" "$cwdb" "$argvb" "$em"
  r=$((r+1))
done
printf 'T %s %s %s %s\\n' "$n" "$r" "$o" "$u"`

export interface OpencodeProc {
  pid: number
  // /proc start field: the generation token — pid+startTicks can never recur,
  // so a post-collection row must match it, not just the pid.
  startTicks?: number
  argv: string[]
  cwd: string
  // Conservative birth upper bound in ms epoch; absent when the sampled
  // fields could not produce one (never a coordinator-clock fallback).
  startedAt?: number
}

export interface OpencodeScan {
  complete: boolean
  rows: OpencodeProc[]
  // Emitted opencode-shaped rows whose cwd could not be read, plus
  // empty-argv uncertain shapes: each can block a selection its cwd might
  // equal, so callers refuse when one is in scope.
  uncertain: OpencodeProc[]
  scanned: number
  emitted: number
}

const EMPTY: OpencodeScan = { complete: false, rows: [], uncertain: [], scanned: 0, emitted: 0 }

export function parseOpencodeProcs(text: string): OpencodeScan {
  const lines = text.split('\n')
  const head = lines[0]?.split(' ')
  if (!head || head[0] !== 'H') return EMPTY
  const hz = Number(head[1])
  const boot = Number(head[2])
  if (head[3] !== '1' || !Number.isSafeInteger(hz) || hz <= 0 || !Number.isSafeInteger(boot) || boot <= 0) return EMPTY
  const out: OpencodeScan = { complete: false, rows: [], uncertain: [], scanned: 0, emitted: 0 }
  let overflow = 0
  let unknown = 0
  for (const line of lines.slice(1)) {
    if (!line) continue
    const f = line.split(' ')
    if (f[0] === 'S' && f.length === 8) {
      const pid = Number(f[1])
      const ticks = Number(f[2])
      const up = Number(f[3])
      const wall = Number(f[4])
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      const argvb = Buffer.from(f[6] || '', 'base64')
      const argv = argvb.length > 1 && argvb.length <= MAX_CMDLINE && argvb.at(-1) === 0
        ? argvb.toString('utf8').split('\0').slice(0, -1) : []
      const cwdb = Buffer.from(f[5] || '', 'base64')
      const cwd = cwdb.length && cwdb.length <= 4096 ? cwdb.toString('utf8') : ''
      const startedAt = birthUpperBound(ticks, hz, boot, up, wall)
      const row: OpencodeProc = { pid, argv, cwd }
      if (Number.isSafeInteger(ticks) && ticks! > 0) row.startTicks = ticks
      if (startedAt !== undefined) row.startedAt = startedAt
      if (f[7] === 'u' || !cwd) out.uncertain.push(row)
      else out.rows.push(row)
      continue
    }
    if (f[0] === 'T') {
      out.scanned = Number(f[1]) || 0
      out.emitted = Number(f[2]) || 0
      overflow = Number(f[3]) || 0
      unknown = Number(f[4]) || 0
    }
  }
  out.complete = overflow === 0 && unknown === 0
  return out
}

// One bounded round trip. Non-Linux or a missing /proc => ok=0 => not
// complete => the selection fails closed, never a usable empty scan.
export async function opencodeProcs(exec: ShellExec, opts: { procRoot?: string, timeoutMs?: number } = {}): Promise<OpencodeScan> {
  const r = await exec(OPENCODE_PROCS_SCRIPT, [opts.procRoot || '/proc'], { timeoutMs: opts.timeoutMs ?? 10000, maxBytes: 1024 * 1024 })
  if (r.code !== 0) return EMPTY
  const scan = parseOpencodeProcs(r.stdout.toString('utf8'))
  if (scan.rows.length + scan.uncertain.length > 4096) return EMPTY
  return scan
}
