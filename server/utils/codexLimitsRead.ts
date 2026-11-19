// Refresh of a stale Codex "limit reached" (WHR-445). Codex only writes its
// limits into a conversation while an agent works, so with no Codex agent
// running an old "limit reached" stayed, even after the provider had reset the
// account early. The Codex app-server answers `account/rateLimits/read`: a
// read of the account's current limits, no model turn, no quota spent. It runs
// on a machine with Codex when that machine's reading is stale and says
// limited, at most once per 15 minutes per account.
import { USER_PATH_SETUP } from './agentAvailability'
import type { ExecResult } from './fsx'

export const REFRESH_EVERY_MS = 15 * 60_000

// Ask a short-lived app-server for the limits, print its answer (id 2), quit.
// Its standard input stays open until the answer is there (20 s at most).
export const CODEX_LIMITS_SCRIPT = `${USER_PATH_SETUP}
command -v codex >/dev/null 2>&1 || exit 3
out=$(mktemp) || exit 4
{
  printf '%s\\n' '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"wherdr","version":"0"}}}' '{"method":"initialized"}' '{"method":"account/rateLimits/read","id":2,"params":{"excludeResetCreditDetails":true}}'
  i=0; while [ $i -lt 40 ] && ! grep -q '"id":2' "$out"; do sleep 0.5; i=$((i+1)); done
} | DISABLE_AUTOUPDATER=1 codex app-server 2>/dev/null > "$out"
grep '"id":2' "$out"; rm -f "$out"
`

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const snake = (w: Json | null | undefined) => (w ? { used_percent: w.usedPercent, resets_at: w.resetsAt, window_minutes: w.windowDurationMins } : null)

// The answer as the line a conversation would carry (`event_msg` with
// `rate_limits`), so one parser (lastCodexLimits) reads both. null: no answer.
export function codexLimitsLine(stdout: string, at: number): string | null {
  for (const l of stdout.split('\n')) {
    try {
      const rl = (JSON.parse(l) as Json).result?.rateLimits
      if (!rl || !(rl.primary || rl.secondary)) continue
      const c = rl.credits
      return JSON.stringify({ timestamp: new Date(at).toISOString(), payload: { rate_limits: {
        primary: snake(rl.primary), secondary: snake(rl.secondary), rate_limit_reached_type: rl.rateLimitReachedType ?? null,
        ...(c ? { credits: { has_credits: c.hasCredits, unlimited: c.unlimited, balance: c.balance } } : {}),
      } } })
    } catch { /* another line */ }
  }
  return null
}

// When each account (or machine, unidentified) was last asked.
const asked = new Map<string, number>()
export function mayRefresh(key: string, now: number) {
  const last = asked.get(key)
  if (last !== undefined && now - last < REFRESH_EVERY_MS) return false
  asked.set(key, now)
  return true
}

export const runCodexLimits = (run: (script: string) => Promise<ExecResult>) =>
  run(CODEX_LIMITS_SCRIPT).then(r => (r.code === 0 ? r.stdout.toString('utf8') : ''), () => '')
