// Codex notices shown in its conversation view: "Update available" (with an
// Update button) and the weekly-limit warning. Pure logic, shared by the
// server and the tests. Structured data first:
//  - running version: the TUI's own header on screen ("OpenAI Codex (v…)"),
//    else `cli_version` in the header of the agent's rollout (written by the
//    shared app-server daemon, which may run another version than the TUI);
//  - latest version: `latest_version` in ~/.codex/version.json (Codex's own
//    daily check, `dismissed_version` when the user skipped it in Codex);
//  - installed version: ~/.codex/packages/standalone/current/codex-package.json
//    (standalone installer), or the result of an update run by wherdr;
//  - weekly-limit warning: only what Codex's screen shows right now
//    (codexWeeklyWarning), nothing computed from its files.
// The screen otherwise only fills the gaps (the update command it suggests).
// A command read from the screen is never run as is: only the known official
// commands below can be run.
import { compareVersions, parseVersion } from './updates'

export const CODEX_RELEASE_NOTES = 'https://github.com/openai/codex/releases/latest'
// Official update commands printed by Codex ("Run … to update."), one per
// install method. The standalone one downloads the installer from this URL only.
export const CODEX_STANDALONE_COMMAND = `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`
const KNOWN_COMMANDS = [
  CODEX_STANDALONE_COMMAND,
  'npm install -g @openai/codex',
  'npm install -g @openai/codex@latest',
  'bun install -g @openai/codex',
  'bun install -g @openai/codex@latest',
  'brew upgrade --cask codex',
  'brew upgrade codex',
]
const norm = (s: string) => s.trim().replace(/\s+/g, ' ')

// The known command `text` is (spacing aside), or null: anything else
// (other URL, extra arguments, chained command) is only shown to copy.
export function knownUpdateCommand(text: string | null | undefined): string | null {
  const t = norm(String(text || ''))
  return KNOWN_COMMANDS.find(c => c === t) ?? null
}

export interface CodexScreenWeekly {
  left: number
  // `exact`: a gauge ("weekly limit: 12% left", `/status`); otherwise the
  // startup heads-up ("less than 25% of your weekly limit left"), a bound only.
  exact: boolean
  // Reset as printed by `/status` ("10:33 on 10 Oct"), machine local time.
  resets?: string
}

export interface CodexScreenInfo {
  // Version in the TUI's header, "OpenAI Codex (v0.159.1)" (last one on screen).
  version?: string
  // "✨ Update available! 0.159.1 -> 0.160.0"
  update?: { current: string, latest: string }
  // "Run <command> to update." (raw text, not validated)
  command?: string
  // Last weekly reading with a reset on screen, else the last gauge or heads-up.
  weekly?: CodexScreenWeekly
}

const VERSION = String.raw`v?(\d+\.\d+\.\d+(?:-[\w.]+)?)`
const UPDATE_RE = new RegExp(String.raw`Update available!?\s*${VERSION}\s*(?:->|→)\s*${VERSION}`, 'i')
const HEADER_RE = new RegExp(String.raw`OpenAI Codex\s*\(${VERSION}\)`, 'i')
// Footer gauge, or the `/status` line "Weekly limit: [████] 100% left (resets 10:33 on 10 Oct)".
const WEEK_LEFT_RE = /weekly limit:?\s*(?:\[[^\]]*\]\s*)?(\d{1,3})\s*%\s*left(?:\s*\(resets\s+([^)]+)\))?/i
const WEEK_LESS_RE = /less than\s*(\d{1,3})\s*%\s*of your weekly limit left/i

// What Codex's screen says (plain text, as read by `pane.read`). The update
// command may wrap over several lines in a narrow pane.
export function parseCodexScreen(text: string | null | undefined): CodexScreenInfo {
  const out: CodexScreenInfo = {}
  if (!text) return out
  const lines = text.split('\n').map(l => l.replace(/^[\s│┃]+|[\s│┃]+$/g, ''))
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const h = HEADER_RE.exec(l)
    if (h) out.version = h[1]!
    const u = UPDATE_RE.exec(l)
    if (u) out.update = { current: u[1]!, latest: u[2]! }
    const r = /(?:^|\s)Run\s+(.*)$/.exec(l)
    if (r && (out.update || /to update\.?$/.test(l) || lines.slice(i + 1, i + 4).some(x => /to update\.?$/.test(x)))) {
      let cmd = r[1]!
      for (let j = i + 1; j < Math.min(lines.length, i + 4) && !/\bto update\.?$/.test(cmd); j++) cmd += ` ${lines[j]}`
      const m = /^(.*?)\s+to update\.?$/.exec(cmd)
      if (m) out.command = norm(m[1]!)
    }
    // Prefer complete `/status` readings: a footer gauge must not discard
    // their reset. Among equally complete gauges, the last one wins.
    // Gauges always win over the heads-up printed once at startup.
    const w = WEEK_LEFT_RE.exec(l)
    if (w) {
      if (w[2] || !out.weekly?.resets) out.weekly = { left: clampPct(Number(w[1])), exact: true, ...(w[2] ? { resets: norm(w[2]) } : {}) }
    }
    else {
      const hu = WEEK_LESS_RE.exec(l)
      if (hu && !out.weekly?.exact) out.weekly = { left: clampPct(Number(hu[1])), exact: false }
    }
  }
  return out
}
const clampPct = (n: number) => Math.max(0, Math.min(100, n))

// Lines from the bottom of the screen that hold Codex's footer.
const FOOTER_LINES = 6
const FOOTER_GAUGE_RE = /weekly limit:?\s*(\d{1,3})\s*%\s*left/i

// Weekly-limit warning Codex shows right now, with its own values, or null:
//  - the footer gauge ("⚠ weekly limit: 12% left · /status"), in the last
//    lines of the screen (Codex redraws its footer there; not the bar of a
//    `/status` card, which is a reading, not a warning);
//  - the heads-up ("Heads up, you have less than 25% of your weekly limit
//    left"), only after the last "OpenAI Codex (v…)" header: one is printed
//    when Codex starts (a heads-up above it is from before a restart) and by
//    `/status` (which shows the up-to-date usage instead).
// The gauge wins over the heads-up. Nothing on screen: no warning.
export function codexWeeklyWarning(text: string | null | undefined): CodexWeekly | null {
  if (!text) return null
  const lines = text.split('\n').map(l => l.replace(/^[\s│┃]+|[\s│┃]+$/g, ''))
  const filled = lines.filter(Boolean)
  for (const l of filled.slice(-FOOTER_LINES).reverse()) {
    if (l.includes('[') || /\(resets\b/i.test(l)) continue
    const g = FOOTER_GAUGE_RE.exec(l)
    if (g) return { left: clampPct(Number(g[1])), lessThan: false }
  }
  let start = 0
  lines.forEach((l, i) => { if (HEADER_RE.test(l)) start = i + 1 })
  for (let i = lines.length - 1; i >= start; i--) {
    const hu = WEEK_LESS_RE.exec(lines[i]!)
    if (hu) return { left: clampPct(Number(hu[1])), lessThan: true }
  }
  return null
}

// ~/.codex/version.json: { latest_version, last_checked_at, dismissed_version }.
export function parseVersionFile(text: string | null | undefined): { latest: string | null, dismissed: string | null } {
  try {
    const d = JSON.parse(String(text || ''))
    const v = (x: unknown) => (typeof x === 'string' && parseVersion(x) ? x.replace(/^v/, '') : null)
    return { latest: v(d && d.latest_version), dismissed: v(d && d.dismissed_version) }
  } catch { return { latest: null, dismissed: null } }
}

// Version of a standalone install (codex-package.json of the `current` release).
export function parsePackageVersion(text: string | null | undefined): string | null {
  try {
    const v = JSON.parse(String(text || '')).version
    return typeof v === 'string' && parseVersion(v) ? v : null
  } catch { return null }
}

// `cli_version` of a rollout's first line (session_meta).
export function rolloutCliVersion(head: string | null | undefined): string | null {
  const first = String(head || '').split('\n', 1)[0] || ''
  if (!first.includes('"session_meta"')) return null
  const m = /"cli_version"\s*:\s*"([^"\\]{1,40})"/.exec(first)
  return m && parseVersion(m[1]!) ? m[1]! : null
}

// `codex --version` output ("codex-cli 0.160.0").
export function parseCliVersion(out: string | null | undefined): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(String(out || ''))
  return m ? m[1]! : null
}

export type CodexUpdateMethod = 'direct' | 'terminal'

export type CodexUpdateJob = { phase: 'running', pane?: string } | { phase: 'done', version: string | null, at: number } | { phase: 'failed', error: string }

export interface CodexUpdate {
  // `available`: newer version to install; `installed`: already installed
  // on the machine, the agent must be restarted to use it.
  state: 'available' | 'installed'
  latest: string
  // Version the agent runs (null if unknown).
  current: string | null
  // Command to update: the known official one, or the screen's text to copy.
  command: string | null
  // The server may run `command` (a known official command) from wherdr.
  runnable: boolean
  method: CodexUpdateMethod | null
  notes: string
  job?: CodexUpdateJob
}

// Weekly-limit warning, as Codex shows it: "weekly limit: 12% left" (footer
// gauge) or "less than 25% of your weekly limit left" (heads-up, `lessThan`).
export interface CodexWeekly { left: number, lessThan: boolean }
export interface CodexStatus { update?: CodexUpdate, weekly?: CodexWeekly }

const newest = (...vs: (string | null | undefined)[]) =>
  vs.reduce<string | null>((a, b) => (!b ? a : !a || compareVersions(b, a) > 0 ? b : a), null)

// Version the agent runs: the TUI's own word first (`tuiVersion`: on screen,
// or remembered for the same process), then the rollout's `cli_version`.
// No guess from dates: an agent started after an install may still run an
// older version (another binary, daemon kept), the screen tells.
export function runningVersion(o: { rollout: string | null, screen: CodexScreenInfo, seen?: string | null }): string | null {
  return tuiVersion(o.screen, o.seen) || o.rollout || null
}

// Version the TUI itself says it runs: its header on screen ("OpenAI Codex
// (v…)"), else its "Update available" box, else `seen`, the version read
// earlier on the screen of the same Codex process. Never the rollout's
// `cli_version`: written by the shared app-server daemon, or by the version
// that created a conversation later resumed (`codex resume` keeps its first
// line), it may be older than the TUI. Null: unknown.
export function tuiVersion(screen: CodexScreenInfo, seen?: string | null): string | null {
  return screen.version || screen.update?.current || seen || null
}

// Update notice of a Codex agent, or null. `canRun`: the server can run a
// command on the agent's machine (remote over SSH, or a writable local home);
// otherwise a known command is typed into the agent's own terminal.
// `tui`: version the TUI itself says it runs (tuiVersion), the only one that
// can ask for a restart: "installed" only when a newer version is installed
// than the one this Codex process runs.
export function codexUpdateState(o: {
  running: string | null
  tui?: string | null
  latest: string | null
  dismissed?: string | null
  installed: string | null
  standalone: boolean
  screen: CodexScreenInfo
  canRun: boolean
  job?: CodexUpdateJob | null
}): CodexUpdate | null {
  const running = o.running
  // A version installed by wherdr's update is also installed on the machine.
  const done = o.job?.phase === 'done' ? o.job.version : null
  const installed = newest(o.installed, done)
  const latest = newest(o.latest, o.screen.update?.latest)
  const have = newest(installed, running)
  const job = o.job || undefined
  const base = { notes: CODEX_RELEASE_NOTES, ...(job ? { job } : {}) }
  if (latest && have && compareVersions(latest, have) > 0 && o.dismissed !== latest) {
    // Standalone install (seen on disk): its command, whatever the screen says.
    const known = o.standalone ? CODEX_STANDALONE_COMMAND : knownUpdateCommand(o.screen.command)
    const command = known || (o.screen.command ? norm(o.screen.command) : null)
    const method: CodexUpdateMethod | null = known ? (o.canRun ? 'direct' : 'terminal') : null
    return { state: 'available', latest, current: have, command, runnable: Boolean(method), method, ...base }
  }
  const tui = o.tui || null
  if (installed && tui && compareVersions(installed, tui) > 0) {
    return { state: 'installed', latest: installed, current: tui, command: null, runnable: false, method: null, ...base }
  }
  // Update running or failed with nothing else to say: its progress or error stays shown.
  if (job && job.phase !== 'done') return { state: 'available', latest: latest || '', current: running, command: null, runnable: false, method: null, ...base }
  return null
}

// `account`: fingerprint of the Codex account (see codexAccount, quotas.ts), if known.
export interface WeekReading { used: number, resetsAt: number | null, at: number, account?: string | null }

// Two weekly resets further apart than this are two different windows
// (the screen's time is the Codex machine's local time, maybe not ours).
const SAME_WINDOW_MS = 20 * 3600000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Reset time printed by `/status`: "10:33", "10:33 on 10 Oct", "3:46 PM on Oct 4".
// Local time of this server; null if unreadable.
export function parseResetTime(text: string | null | undefined, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s+on\s+(?:(\d{1,2})\s+([a-z]{3})[a-z]*|([a-z]{3})[a-z]*\s+(\d{1,2})))?$/i.exec(norm(String(text || '')))
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  const n = new Date(now)
  const day = m[4] ?? m[7]
  const mon = (m[5] ?? m[6])?.toLowerCase()
  if (day && mon) {
    const mi = MONTHS.indexOf(mon)
    if (mi < 0) return null
    let t = new Date(n.getFullYear(), mi, Number(day), h, min).getTime()
    // "on 2 Jan" read late December is next year's.
    if (t < now - 180 * 86400000) t = new Date(n.getFullYear() + 1, mi, Number(day), h, min).getTime()
    return t
  }
  let t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min).getTime()
  if (t < now - 60000) t += 86400000
  return t
}

// Current weekly window for the home gauge (server/utils/quotas.ts), from
// the most recent reading (whatever is left):
//  - structured: the freshest `rate_limits` (agent's rollout or the machine's
//    newest conversation); a window whose reset is past has been renewed;
//  - `/status` on screen, with its reset: a later window than the structured
//    one means a reset since (early, or no turn since): the screen wins; the
//    same window: the higher usage (it only grows); an earlier window: stale.
//  - `known`: the latest window remembered for the machine (rememberWeek),
//    kept across agent and wherdr restarts, same rule as the screen: once a
//    later window has been seen, an older one is stale even if its reset is
//    still to come (the `/status` read before Codex restarted is gone from
//    the new screen, its rollouts still carry the old window).
//  - a gauge without reset, or the startup heads-up, only without structured data.
// Null: nothing current (no reading, or an expired one nothing replaces).
export interface WeekWindow { left: number, resetsAt: number | null, source: 'rollout' | 'screen' }
export interface WeekInputs { week: WeekReading | null, machine?: WeekReading | null, screen?: CodexScreenWeekly, known?: KnownWeek | null, now: number }
export function codexWeekWindow(o: WeekInputs): WeekWindow | null {
  const s = [o.week, o.machine].reduce<WeekReading | null>((a, b) => (!b ? a : !a || b.at > a.at ? b : a), null)
  let out: WeekWindow | null = null
  const expired = Boolean(s?.resetsAt && s.resetsAt <= o.now)
  if (s && !expired) out = { left: Math.round(Math.max(0, 100 - s.used)), resetsAt: s.resetsAt, source: 'rollout' }
  const later = (left: number, resetsAt: number, source: WeekWindow['source']) => {
    if (!s || expired || !out || !out.resetsAt || resetsAt - out.resetsAt > SAME_WINDOW_MS) out = { left, resetsAt, source }
    else if (Math.abs(resetsAt - out.resetsAt) <= SAME_WINDOW_MS && left < out.left) out = { ...out, left }
  }
  const sc = o.screen
  if (!s && sc) out = { left: sc.left, resetsAt: null, source: 'screen' }
  if (sc?.exact && sc.resets) {
    const r = parseResetTime(sc.resets, o.now)
    if (r && r > o.now) later(sc.left, r, 'screen')
  }
  // Another account's window says nothing about this one.
  const k = o.known
  if (k?.account && k.resetsAt > o.now && k.account === s?.account) {
    later(Math.round(Math.max(0, 100 - k.used)), k.resetsAt, k.source)
  }
  return out
}

// Latest weekly window seen for a machine, from any source (rollout or
// `/status` on screen): its reset, usage and when it was observed. Kept in
// data/ (server/utils/codexStatus.ts) so that a restart of Codex (the
// `/status` read leaves its screen) or of wherdr does not bring back an older
// window whose rollouts still say "12 % left".
export interface KnownWeek { used: number, resetsAt: number, at: number, source: WeekWindow['source'], account?: string | null }

// `known` updated with a reading: a later window replaces it, an earlier one
// is stale and ignored; the same window keeps the higher usage (it only
// grows). An expired window is forgotten; a reading without a future reset
// teaches nothing. Only matching known fingerprints can reuse a previous window;
// an unidentified reading is kept on its own and is never reused later.
export function rememberWeek(known: KnownWeek | null | undefined, r: KnownWeek | null | undefined, now: number): KnownWeek | null {
  const k = known?.account && known.resetsAt > now ? known : null
  if (!r || !(r.resetsAt > now) || !Number.isFinite(r.used)) return k
  if (!k || !r.account || r.account !== k.account || r.resetsAt - k.resetsAt > SAME_WINDOW_MS) return { ...r }
  if (k.resetsAt - r.resetsAt > SAME_WINDOW_MS) return k
  const base = r.at >= k.at ? r : k
  return { ...base, used: Math.max(k.used, r.used), at: Math.max(k.at, r.at), account: base.account ?? k.account ?? r.account ?? null }
}

// A structured reading as a known window (null without a reset).
export function weekFromReading(w: WeekReading | null | undefined): KnownWeek | null {
  return w && w.resetsAt ? { used: w.used, resetsAt: w.resetsAt, at: w.at, source: 'rollout', account: w.account ?? null } : null
}

// A `/status` gauge on screen as a known window. Only a dated reset is kept:
// a bare time ("03:46") whose hour has already passed today is an old
// `/status` still in the scrollback, not tomorrow's reset.
export function weekFromScreen(w: CodexScreenWeekly | null | undefined, now: number, account: string | null = null): KnownWeek | null {
  if (!w?.exact || !w.resets) return null
  const r = parseResetTime(w.resets, now)
  if (!r || r <= now) return null
  if (!/\son\s/i.test(w.resets) && new Date(r).getDate() !== new Date(now).getDate()) return null
  return { used: 100 - w.left, resetsAt: r, at: now, source: 'screen', account }
}

// Known windows read back from data/ at startup: well-formed, still running.
export function loadKnownWeeks(raw: unknown, now: number): [string, KnownWeek][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: [string, KnownWeek][] = []
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = v as Partial<KnownWeek> | null
    if (!k || typeof k !== 'object' || typeof k.used !== 'number' || typeof k.resetsAt !== 'number' || typeof k.at !== 'number') continue
    if (k.resetsAt <= now || (k.source !== 'rollout' && k.source !== 'screen')) continue
    out.push([key, { used: Math.max(0, Math.min(100, k.used)), resetsAt: k.resetsAt, at: k.at, source: k.source, account: typeof k.account === 'string' ? k.account : null }])
  }
  return out
}

// Shell script of an update: the known command, then the new version.
// PATH completed for a non-interactive SSH shell (Homebrew, npm, ~/.local/bin).
export function updateScript(command: string): string {
  const known = knownUpdateCommand(command)
  if (!known) throw new Error('unknown update command')
  return [
    'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
    'set -e',
    known,
    'codex --version 2>/dev/null || true',
    '',
  ].join('\n')
}

// Update typed into the agent's terminal (method `terminal`): the known
// official command, then an end marker carrying its exit status, so the
// server knows when and how it ended. The marker as typed ("…_$?__") never
// matches its own pattern: only the shell's output does. POSIX shells and
// fish (`$status`); any other shell: null (copy the command instead).
export const DONE_MARK = '__WHERDR_DONE_'
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'busybox'])
export function terminalUpdateLine(command: string, nonce: string, shell: string | null | undefined): string | null {
  const known = knownUpdateCommand(command)
  if (!known) throw new Error('unknown update command')
  if (!/^[a-z0-9]{4,16}$/.test(nonce)) throw new Error('bad marker')
  const name = String(shell || '').replace(/^.*\//, '').replace(/^-/, '')
  const status = POSIX_SHELLS.has(name) ? '$?' : name === 'fish' ? '$status' : null
  if (!status) return null
  return `${known}; echo ${DONE_MARK}${nonce}_${status}"__"`
}

// End of a terminal update on screen: its exit status and the last line it
// printed (the error to show), or null while it runs.
export function terminalUpdateDone(text: string | null | undefined, nonce: string): { code: number, last: string | null } | null {
  const lines = String(text || '').split('\n')
  const re = new RegExp(`${DONE_MARK}${nonce}_(\\d{1,3})__`)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!)
    if (!m) continue
    let last: string | null = null
    for (let j = i - 1; j >= 0 && !last; j--) {
      const l = lines[j]!.trim()
      if (l.includes(DONE_MARK)) break // the typed command line: nothing printed
      if (l) last = l.slice(0, 300)
    }
    return { code: Number(m[1]), last }
  }
  return null
}

// Codex shows a selection menu (startup update prompt, folder trust,
// approval…) rather than its input field: typing `/exit` would pick an
// option, the update waits until it is answered.
export function codexMenuOpen(text: string | null | undefined): boolean {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-12)
  return lines.some(l => /^›\s*1\.\s/.test(l)) && lines.some(l => /\benter\b.*·.*\besc\b/i.test(l))
}
