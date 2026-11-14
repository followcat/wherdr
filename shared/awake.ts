// Keep a machine awake (Settings › Machines, a machine tab's menu): the shell run on
// that machine through herdr-core's machine.exec, and what it prints, read here.
// caffeinate on macOS, systemd-inhibit on Linux. The inhibitor we started is
// recorded in ~/.cache/herdr-web/awake.pid (pid|until|lid|start, as in v2) and only
// a process with that PID, our exact command and that start time is ours.

export type AwakePlatform = 'mac' | 'linux' | 'other'
export type AwakeMode = 'hour' | 'fourHours' | 'evening' | 'untilOff' | 'extend'
export const AWAKE_MODES: readonly (AwakeMode | 'off')[] = ['hour', 'fourHours', 'evening', 'untilOff', 'extend', 'off']
export interface AwakeState {
  supported: boolean
  platform: AwakePlatform
  active: boolean
  // ms; null while active = until turned off.
  until: number | null
  // A laptop: its battery, and whether its lid is closed (null: unknown or no lid).
  battery: { percent: number, source: 'ac' | 'battery' } | null
  lidClosed: boolean | null
  // Machine time ≥ 8 pm: "until this evening" no longer makes sense.
  eveningPast: boolean
}

// $1 ours [start]: a PID whose command is our inhibitor (and, given, its start time:
// a recycled PID is not ours). /proc on Linux, ps -p on macOS, pinned to C/UTC so
// another session's locale or time zone reads the same start.
const OURS = `cmdline() {
  if [ -r "\${AWAKE_PROC:-/proc}/$1/cmdline" ]; then tr '\\000' ' ' < "\${AWAKE_PROC:-/proc}/$1/cmdline"
  else ps -p "$1" -o args= 2>/dev/null; fi
}
started() {
  if [ -r "\${AWAKE_PROC:-/proc}/$1/stat" ]; then sed 's/.*) //' "\${AWAKE_PROC:-/proc}/$1/stat" | cut -d' ' -f20
  else LC_ALL=C TZ=UTC0 ps -p "$1" -o lstart= 2>/dev/null | sed 's/ *$//'; fi
}
ours() {
  case "$1" in *[!0-9]*|'') return 1;; esac
  case "$(cmdline "$1")" in
    caffeinate\\ -i*|*/caffeinate\\ -i*|systemd-inhibit\\ --what=idle:sleep*|*/systemd-inhibit\\ --what=idle:sleep*) ;;
    *) return 1;;
  esac
  [ -z "\${2:-}" ] || [ "$(started "$1")" = "$2" ]
}`

export const STATUS_SCRIPT = `${OURS}
platform=$(uname -s)
case "$platform" in Darwin) platform=mac;; Linux) platform=linux;; *) platform=other;; esac
echo "platform=$platform"
echo "clock=$(date +%H%M)"
if [ "$platform" = mac ]; then
  pmset -g batt 2>/dev/null
  ioreg -r -k AppleClamshellState -d 1 2>/dev/null | grep -q '"AppleClamshellState" = Yes' && echo "lid=closed"
fi
if [ "$platform" = linux ]; then
  command -v systemd-inhibit >/dev/null 2>&1 && command -v systemd-run >/dev/null 2>&1 && echo "inhibit=1"
  for b in /sys/class/power_supply/BAT*; do [ -r "$b/capacity" ] && echo "battery=$(cat "$b/capacity")" && break; done
  for a in /sys/class/power_supply/*; do [ "$(cat "$a/type" 2>/dev/null)" = Mains ] && echo "ac=$(cat "$a/online" 2>/dev/null)" && break; done
  grep -qs closed /proc/acpi/button/lid/*/state && echo "lid=closed"
fi
d="$HOME/.cache/herdr-web/awake.pid"
if [ -f "$d" ]; then
  IFS='|' read -r pid until lid start < "$d" || true
  case "$until" in *[!0-9]*|'') until=0;; esac
  if ours "$pid" "\${start:-}" && { [ "$until" -eq 0 ] || [ "$until" -gt "$(date +%s)" ]; }; then
    echo "awake=$pid|$until"
  else rm -f "$d"; fi
fi`

// How the inhibitor starts, per platform, so it outlives the machine.exec call
// (herdr-core ends whatever an exec started): on Linux a transient user unit
// (systemd-run), on macOS a perl fork in a new session. It prints the PID.
export function inhibitorLaunch(platform: AwakePlatform, timed: boolean): string {
  if (platform === 'mac') {
    return `perl -MPOSIX -e '$p = fork; if ($p) { print "$p\\n"; exit } POSIX::setsid(); open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">/dev/null"; exec @ARGV' caffeinate -i -s${timed ? ' -t "$seconds"' : ''}`
  }
  if (platform === 'linux') {
    return `u="wherdr-awake-$now-$$"; systemd-run --user --quiet --collect --unit="$u" -- systemd-inhibit --what=idle:sleep --who=wherdr --why="Keep awake" sleep ${timed ? '"$seconds"' : 'infinity'} </dev/null >/dev/null 2>&1 && systemctl --user show -p MainPID --value "$u"`
  }
  return 'false'
}

// $1 mode. The new inhibitor starts and is checked alive BEFORE the old one stops
// (no moment without an assertion). Expected errors: an "error=<code>" line, exit 0.
export function controlScript(platform: AwakePlatform): string {
  return `set -u
${OURS}
mode=$1
dir="$HOME/.cache/herdr-web"; d="$dir/awake.pid"
mkdir -p "$dir"
fail() { echo "error=$1"; exit 0; }
now=$(date +%s)
old_pid=; old_until=0; old_lid=0; old_start=
if [ -f "$d" ]; then IFS='|' read -r old_pid old_until old_lid old_start < "$d" || true; fi
case "$old_until" in *[!0-9]*|'') old_until=0;; esac
ours "$old_pid" "$old_start" || old_pid=
if [ "$mode" = off ]; then
  [ -z "$old_pid" ] || kill "$old_pid" 2>/dev/null || true
  rm -f "$d"; echo "stopped"; exit 0
fi
case "$mode" in
  hour) seconds=3600;; fourHours) seconds=14400;;
  evening) hour=$(expr "$(date +%H)" + 0); minute=$(expr "$(date +%M)" + 0); seconds=$(( (20 - hour) * 3600 - minute * 60 )); [ "$seconds" -gt 0 ] || fail evening_past;;
  untilOff) seconds=0;;
  extend) { [ -n "$old_pid" ] && [ "$old_until" -gt "$now" ]; } || fail not_active; seconds=$((old_until - now + 3600));;
  *) fail bad_mode;;
esac
until=0; [ "$seconds" -eq 0 ] || until=$((now + seconds))
if [ "$seconds" -eq 0 ]; then pid=$(${inhibitorLaunch(platform, false)}) || fail start_failed
else pid=$(${inhibitorLaunch(platform, true)}) || fail start_failed; fi
# Loaded machine: wait for the tool to be exec'd (5 s max), then 1 s for an early failure.
i=0
while [ "$i" -lt 50 ] && kill -0 "$pid" 2>/dev/null && ! ours "$pid"; do sleep 0.1; i=$((i + 1)); done
sleep 1
# Failure: the old inhibitor (if any) keeps running, file untouched.
ours "$pid" || fail start_failed
start=$(started "$pid")
printf '%s|%s|0|%s\\n' "$pid" "$until" "$start" > "$d.tmp" && mv "$d.tmp" "$d"
if [ -n "$old_pid" ] && [ "$old_pid" != "$pid" ]; then kill "$old_pid" 2>/dev/null || true; fi
echo "started=$pid"`
}

export const AWAKE_ERRORS: Record<string, string> = {
  no_tool: 'Sleep control is not available on this machine',
  evening_past: 'It is already past 8 pm on this machine: pick a duration',
  not_active: 'Nothing to extend: the machine is not being kept awake',
  bad_mode: 'Invalid keep-awake option',
  start_failed: 'Keep awake did not start; the previous state is kept',
}

export function parseBattery(raw: string, platform: AwakePlatform): AwakeState['battery'] {
  if (platform === 'linux') {
    const percent = /^battery=(\d{1,3})$/m.exec(raw)
    return percent ? { percent: Math.min(100, Number(percent[1])), source: /^ac=1$/m.test(raw) ? 'ac' : 'battery' } : null
  }
  const percent = platform === 'mac' ? /\b(\d{1,3})%/.exec(raw) : null
  return percent ? { percent: Math.min(100, Number(percent[1])), source: /AC Power/i.test(raw) ? 'ac' : 'battery' } : null
}

export function parseAwakeStatus(raw: string): AwakeState {
  const platform = (/^platform=(mac|linux|other)$/m.exec(raw)?.[1] as AwakePlatform | undefined) || 'other'
  const match = /^awake=(\d+)\|(\d+)$/m.exec(raw)
  const battery = parseBattery(raw, platform)
  return {
    platform, supported: platform === 'mac' || (platform === 'linux' && /^inhibit=1$/m.test(raw)),
    active: Boolean(match), until: match && Number(match[2]) ? Number(match[2]) * 1000 : null,
    battery, lidClosed: /^lid=closed$/m.test(raw) ? true : battery ? false : null,
    eveningPast: Number(/^clock=(\d{4})$/m.exec(raw)?.[1] ?? 0) >= 2000,
  }
}

export function parseControl(raw: string): { error: string } | { started: number | null } {
  const error = /^error=(\w+)$/m.exec(raw)?.[1]
  if (error) return { error }
  return { started: Number(/^started=(\d+)$/m.exec(raw)?.[1]) || null }
}

// A laptop on battery sleeps when its lid closes, whatever keeps it awake.
export function awakeWarning(s: AwakeState | undefined): string {
  if (!s?.battery || s.battery.source === 'ac') return ''
  return s.lidClosed ? 'Lid closed on battery: this machine will sleep' : 'On battery: closing the lid puts it to sleep'
}
