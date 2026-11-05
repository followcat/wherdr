import type { DevinProcess } from './devinSessions'

// Linux only. Other systems keep core's exact argv, but cannot claim PID locks.
// Sample uptime BEFORE wall time: the resulting birth is an upper bound. Add
// one clock tick because /proc/stat field 22 is quantized. Unlike btime alone,
// this does not lose a full second of boot-time precision. btime is a sanity check.
export const DEVIN_PROCESS_SCRIPT = `hz=$(getconf CLK_TCK 2>/dev/null)
[ -n "$hz" ] || hz=-
boot=$(awk '$1 == "btime" { print $2 }' /proc/stat 2>/dev/null)
[ -n "$boot" ] || boot=-
for pid; do
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  ticks=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{ print $20 }')
  up=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)
  wall=$(date +%s.%N 2>/dev/null)
  [ -n "$up" ] || up=-
  [ -n "$wall" ] || wall=-
  args=$(head -c 131073 "/proc/$pid/cmdline" 2>/dev/null | base64 | tr -d '\\n')
  after=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{ print $20 }')
  [ -n "$ticks" ] && [ "$ticks" = "$after" ] || continue
  printf '%s %s %s %s %s %s %s\\n' "$pid" "$ticks" "$hz" "$boot" "$up" "$wall" "$args"
done`

export function devinProcesses(snapshot: string): Map<number, DevinProcess> {
  const out = new Map<number, DevinProcess>()
  for (const line of snapshot.split('\n')) {
    const parts = line.split(' ')
    if (parts.length !== 7) continue
    const [pid, ticks, hz, boot, uptime, wall] = parts.slice(0, 6).map(Number)
    if (!Number.isSafeInteger(pid) || pid! <= 0) continue
    const bytes = Buffer.from(parts[6]!, 'base64')
    if (!bytes.length || bytes.length > 131072 || bytes.at(-1) !== 0) continue
    const proc: DevinProcess = { pid, argv: bytes.toString('utf8').split('\0').slice(0, -1), argvExact: true }
    if (Number.isSafeInteger(ticks) && ticks! >= 0 && Number.isSafeInteger(hz) && hz! > 0
      && Number.isSafeInteger(boot) && boot! > 0 && Number.isFinite(uptime) && uptime! >= 0 && Number.isFinite(wall)) {
      const upper = Math.ceil(wall! * 1000 - uptime! * 1000 + (ticks! + 1) * 1000 / hz!)
      const coarse = boot! * 1000 + ticks! * 1000 / hz!
      if (upper >= coarse && upper - coarse < 2000) proc.startedAt = upper
    }
    out.set(pid!, proc)
  }
  return out
}
