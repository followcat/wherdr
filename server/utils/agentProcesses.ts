// Bounded Command Code process census on one machine, for the A5 display-only
// session fallback. One Linux /proc scan per call (a single bounded script
// round trip through ShellExec: machine.exec on a remote core host, localShell
// locally). It reports every live process that could be a cmd agent — inside
// or outside core's terminal inventory — with parent pid, generation (start
// ticks), NUL-boundary argv, actual cwd and a conservative birth bound. The
// record contract and classification live in agentCensus.ts; the producer may
// over-emit but must never emit less than the parser could classify.
import { execFile } from 'node:child_process'
import type { ShellExec } from './fsx'
import { parseAgentCensus, type AgentCensus } from './agentCensus'

const MAX_CMDLINE = 16384
// Producer stdout is bounded BEFORE machine.exec serializes its reply: emit()
// stops at ~3 MiB, under the ShellExec maxBytes and the parser's 4 MiB gate
// (both far below core's 16 MiB reply limit). An overflow sets footer bit 4.
// $1: proc root (tests inject a synthetic one), $2: max pid dirs, $3: max records.
// argv fields are \x01-joined after translation so blank args survive;
// `res` is base64 of <arg>\x01<resolved>\x01 pairs for the identified script
// and operand values. `R pid` marks a record dropped by a mid-read generation
// change; `T` carries scanned/emitted/overflow/unknown counts.
export const AGENT_CENSUS_SCRIPT = `P=$1
maxd=\${2:-8192}
maxr=\${3:-256}
CAP=3000000
hz=$(getconf CLK_TCK 2>/dev/null); [ -n "$hz" ] || hz=-
boot=$(awk '$1 == "btime" { print $2 }' "$P/stat" 2>/dev/null); [ -n "$boot" ] || boot=-
if [ -d "$P" ] && [ -r "$P/uptime" ]; then ok=1; else ok=0; fi
printf 'H %s %s %s\\n' "$hz" "$boot" "$ok"
if [ "$ok" != 1 ]; then printf 'T 0 0 0 0\\n'; exit 0; fi
n=0; r=0; rr=0; o=0; u=0; ob=0
i1=$(printf '\\001')
# Proven package entrypoint / bin-alias shapes only — mirrors ENTRY + CMD_BIN.
chk() {
  case \${1##*/} in cmd|cmdc|command-code|commandcode|command_code) return 0 ;; esac
  case $1 in */command-code/dist/index.mjs|*/command-code/dist/cli.mjs|*/command-code/bin/cmd|*/command-code/bin/cmdc|*/command-code/bin/command-code|*/command-code/bin/commandcode|*/command-code/bin/command_code) return 0 ;; esac
  return 1
}
rslv() { case $1 in /*) readlink -f "$1" 2>/dev/null ;; *) readlink -f "$d/cwd/$1" 2>/dev/null ;; esac }
emit() { l=\${#1}; [ $((ob + l)) -ge $CAP ] && { o=$((o|4)); return 1; }; ob=$((ob+l+1)); printf '%s\\n' "$1"; }
for d in "$P"/[0-9]*; do
  [ -e "$d/stat" ] || continue
  pid=\${d##*/}
  n=$((n+1)); [ "$n" -le "$maxd" ] || { o=$((o|1)); continue; }
  st1=$(sed 's/.*) //' "$d/stat" 2>/dev/null)
  args=$(head -c ${MAX_CMDLINE + 1} "$d/cmdline" 2>/dev/null | tr '\\000' '\\001')
  comm=$(head -c 64 "$d/comm" 2>/dev/null | tr -d '\\n')
  if [ -z "$st1$args$comm" ]; then [ -e "$d/stat" ] && u=$((u+1)); continue; fi
  a0=\${args%%$i1*}
  a0b=\${a0##*/}
  em=0; res=
  if [ -z "$args" ]; then
    # Empty cmdline proves nothing: a zombie/dead state is excluded, but a
    # live interpreter- or agent-shaped comm (or an unreadable one) may hide
    # a peer — emit it as bounded uncertain evidence so its own cwd and
    # generation can scope it, instead of a recordless footer unknown.
    case $(printf %s "$st1" | awk '{ print $1 }') in
      Z|X|x) continue ;;
    esac
    case $comm in ''|node*|nodejs*|bun*|deno*|cmd|cmd.exe|cmdc|command-code*|command_code*|commandcode*) em=1 ;; esac
  else
    case $comm in command-code|command_code|commandcode|cmdc) em=1 ;; esac
    case $a0b in cmd|cmdc|command-code|commandcode|command_code) em=1 ;; esac
    # The real binary (comm) decides the option language; argv0 may be
    # rewritten. Only Node's CLI subset is supported — other interpreters are
    # emitted as unclassifiable rather than silently dropped.
    iname=
    case $comm in node|nodejs|node[0-9]*|bun|bunx|bun[0-9]*|deno|deno[0-9]*) iname=$comm ;; esac
    [ -n "$iname" ] || case $a0b in node*|nodejs*|bun*|bunx*|deno*) iname=$a0b ;; esac
    if [ -n "$iname" ]; then
    case $iname in
      bun*|deno*) em=1 ;; # unsupported interpreter CLI: emit for the parser
      *) # Structural script-position scan; keep the option subset in sync
         # with scriptPos() in agentCensus.ts. scr: s=script u=unknown n=none.
        scr=n; raw=
        tail=0; rest=
        case $args in
          *"$i1") rest=\${args%$i1} ;;
          *) tail=1; rest=$args ;;
        esac
        case $rest in *"$i1"*) rest=\${rest#*$i1} ;; *) rest= ;; esac
        oifs=$IFS; IFS=$i1; set -f; set -- $rest; set +f; IFS=$oifs
        while [ $# -gt 0 ]; do
          [ $# -eq 1 ] && [ "$tail" = 1 ] && { scr=u; break; }
          case $1 in
            --) shift; if [ $# -gt 0 ] && { [ $# -gt 1 ] || [ "$tail" = 0 ]; }; then raw=$1; scr=s; else scr=u; fi; break ;;
            -e|--eval|-p|--print|--eval=*|--print=*|-) scr=u; break ;; # dynamic/stdin: no identity
            -r|--require|--import|--experimental-loader)
              shift; v=\${1-}
              if [ -n "$v" ]; then
                chk "$v" && em=1; vr=$(rslv "$v"); chk "$vr" && em=1
                [ \${#res} -lt 2048 ] && res="$res$(printf '%s\\001%s\\001' "$v" "$vr")"
              fi ;;
            --require=*|--import=*|--experimental-loader=*)
              v=\${1#*=}
              chk "$v" && em=1; vr=$(rslv "$v"); chk "$vr" && em=1
              [ \${#res} -lt 2048 ] && res="$res$(printf '%s\\001%s\\001' "$v" "$vr")" ;;
            --env-file|-C|--conditions|--watch-path|--config|--import-map|--node-modules-dir|--lock|--cert) shift ;;
            --*=*) ;;
            -v|--version|-h|--help|-i|--interactive|-c|--check|--inspect|--inspect-brk|--watch|--no-warnings|--trace-warnings|--preserve-symlinks|--preserve-symlinks-main|--harmony|--experimental-strip-types|--experimental-transform-types) ;;
            -*) scr=u; break ;;
            *) raw=$1; scr=s; break ;;
          esac
          [ $# -gt 0 ] && shift
        done
        case $scr in
          s) chk "$raw" && em=1
             [ "$em" = 0 ] && { sr=$(rslv "$raw"); chk "$sr" && em=1; }
             [ "$em" = 1 ] && res="$res$(printf '%s\\001%s\\001' "$raw" "\${sr-}")" ;;
          u|n) em=1 ;;
        esac ;;
    esac
  fi
    [ "$em" = 0 ] && { chk "$(readlink "$d/exe" 2>/dev/null)" && em=1; }
  fi
  [ "$em" = 1 ] || continue
  [ $((r + rr)) -lt "$maxr" ] || { o=$((o|2)); continue; }
  up=$(cut -d ' ' -f 1 "$P/uptime" 2>/dev/null); [ -n "$up" ] || up=-
  argvb=$(head -c ${MAX_CMDLINE + 1} "$d/cmdline" 2>/dev/null | base64 2>/dev/null | tr -d '\\n')
  cwdb=$(readlink "$d/cwd" 2>/dev/null | base64 | tr -d '\\n')
  exeb=$(readlink "$d/exe" 2>/dev/null | base64 | tr -d '\\n')
  resb=$(printf %s "$res" | base64 | tr -d '\\n')
  st2=$(sed 's/.*) //' "$d/stat" 2>/dev/null)
  t1=$(printf %s "$st1" | awk '{ print $20 }'); [ -n "$t1" ] || t1=-
  t2=$(printf %s "$st2" | awk '{ print $20 }')
  pp=$(printf %s "$st1" | awk '{ print $2 }'); [ -n "$pp" ] || pp=-
  commb=$(printf %s "$comm" | base64 | tr -d '\\n')
  # The wall stamp must follow every byte the parser may classify on: only
  # then is it a machine-time witness that this record's shape existed — a
  # fork->exec flip can never mint an earlier cmd bound. Uptime stays first
  # so the birth upper bound keeps its before-wall ordering.
  wall=$(date +%s.%N 2>/dev/null); [ -n "$wall" ] || wall=-
  if [ "$t1" != "$t2" ]; then emit "R $pid" && rr=$((rr+1)) || break
  else emit "S $pid $pp $t1 $up $wall $commb $argvb $cwdb $exeb $resb" && r=$((r+1)) || break
  fi
done
printf 'T %s %s %s %s\\n' "$n" "$r" "$o" "$u"`

// One bounded round trip. Non-Linux or a missing /proc => ok=0 => unavailable;
// a failed exec reports the same, never a usable empty census.
export async function agentCensus(exec: ShellExec, opts: { procRoot?: string, timeoutMs?: number } = {}): Promise<AgentCensus> {
  const r = await exec(AGENT_CENSUS_SCRIPT, [opts.procRoot || '/proc'], { timeoutMs: opts.timeoutMs ?? 10000, maxBytes: 3 * 1024 * 1024 })
  if (r.code !== 0) return { complete: false, incomplete: 'unavailable', processes: [], uncertain: [], scanned: 0, unknown: 0 }
  return parseAgentCensus(r.stdout.toString('utf8'))
}

// Same script locally (the core terminal machine may be this host).
export const localShell: ShellExec = (script, args = [], opts = {}) => new Promise((resolve) => {
  execFile('sh', ['-c', script, 'sh', ...args], { timeout: opts.timeoutMs ?? 15000, encoding: 'buffer', maxBuffer: (opts.maxBytes ?? 4 * 1024 * 1024) + 64 * 1024 }, (err, out, stderr) => {
    const e = err as (Error & { code?: unknown, killed?: boolean }) | null
    const code = !e ? 0 : e.killed ? 124 : typeof e.code === 'number' ? e.code : 1
    resolve({ code, stdout: out as Buffer, stderr: String(stderr || '') })
  })
})
