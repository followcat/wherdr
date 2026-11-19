// The Studio view's actions run the `backlot` command line on the studio's
// machine through herdr-core: a validated argv, shell-quoted one by one, in a
// one-off terminal that leaves no pane behind.
import { CoreError } from './core'
import { buildBacklotCommand, validateBacklotAction } from '../../shared/backlot'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>

export interface BacklotActionDeps {
  call: Call
  clearDocs: () => void
  // How long terminal.run waits for the command (default 8 s).
  waitMs?: number
}

export interface BacklotActionResult {
  ok: boolean
  output?: string
  error?: string
  status?: number
}

// herdr-core's terminal.run answer (RunResult in tests/fixtures/core-0.1.17.json).
// With `wait`, `wait` tells how the wait ended and `output` holds the screen.
export interface BacklotRunResult {
  address: string
  state?: string
  exit_code?: number | null
  output?: string | null
  wait?: { ended: boolean, exit_code?: number | null } | null
}

export const BACKLOT_LABEL = 'backlot.web_action'
export const BACKLOT_NOT_FOUND = 'The backlot command is not installed on that machine.'
export const BACKLOT_FAILED = 'The backlot command failed.'
export const BACKLOT_TIMEOUT = 'The backlot command did not finish in time.'
export const BACKLOT_UNREACHABLE = 'The machine could not run the backlot command.'

// Single-quote escaping for POSIX sh: no argument can break out of its quotes.
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const LOCATE = [
  'b=$(command -v backlot 2>/dev/null || true)',
  `if [ -z "$b" ]; then b=$(sh -lc 'command -v backlot' 2>/dev/null || true); fi`,
  'if [ -z "$b" ]; then for p in "$HOME/.local/bin/backlot"; do if [ -x "$p" ]; then b=$p; break; fi; done; fi',
  '[ -n "$b" ] || exit 127',
  'exec "$b"',
].join('; ')

export function backlotLine(args: string[]): string {
  return `${LOCATE} ${args.map(shellQuote).join(' ')}`
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const concise = (text: string) => text.replace(ANSI, '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-20).join('\n').slice(-4000)

const unreachable = (e: unknown) => e instanceof CoreError && ['unavailable', 'disconnected', 'unreachable', 'timeout', 'protocol'].includes(e.kind)
const missing = (code: number | null) => code === 126 || code === 127

export async function runBacklotAction(deps: BacklotActionDeps, input: unknown): Promise<BacklotActionResult> {
  const action = validateBacklotAction(input)
  if (!action) return { ok: false, status: 400, error: 'Invalid action' }
  const args = buildBacklotCommand(action)
  const params = {
    line: backlotLine(args),
    ...(action.machine ? { on: action.machine } : {}),
    // `rm` reaps the terminal only once a waiting parent has its exit code:
    // without `wait`, a fast command vanishes before we can read its result.
    wait: true,
    timeout: Math.max(1, Math.ceil((deps.waitMs ?? 8000) / 1000)),
    rm: true,
    no_parent: true,
    no_notify: true,
    labels: { [BACKLOT_LABEL]: '1' },
  }
  let r: BacklotRunResult
  try {
    r = await deps.call<BacklotRunResult>('terminal.run', params, 30000)
  } catch (e) {
    return { ok: false, status: 502, error: unreachable(e) ? BACKLOT_UNREACHABLE : BACKLOT_FAILED }
  }

  // Older cores answered without `wait`: the terminal's state then says how it ended.
  const ended = r.wait ? r.wait.ended : r.state === 'finished'
  const exitCode = r.wait?.exit_code ?? r.exit_code ?? null
  const output = concise(r.output ?? '')

  if (!ended) {
    await deps.call('terminal.kill', { terminal: r.address }, 3000).catch(() => {})
    await deps.call('terminal.rm', { terminal: r.address }, 3000).catch(() => {})
    return { ok: false, status: 502, error: BACKLOT_TIMEOUT }
  }
  if (exitCode !== 0) {
    const first = output.split('\n')[0]?.trim() || ''
    return {
      ok: false,
      status: missing(exitCode) ? 400 : 502,
      error: missing(exitCode) ? BACKLOT_NOT_FOUND : first || BACKLOT_FAILED,
      ...(output ? { output } : {}),
    }
  }
  // A core too old to report `wait` did not necessarily reap the terminal after `rm`.
  if (!r.wait) await deps.call('terminal.rm', { terminal: r.address }, 3000).catch(() => {})
  deps.clearDocs()
  return { ok: true, output }
}
