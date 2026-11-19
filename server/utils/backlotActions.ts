// The Studio view's actions run the `backlot` command line on the studio's
// machine through herdr-core: a validated argv, shell-quoted one by one, in a
// one-off terminal that leaves no pane behind.
import { CoreError } from './core'
import { buildBacklotCommand, validateBacklotAction } from '../../shared/backlot'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>

export interface BacklotActionDeps {
  call: Call
  clearDocs: () => void
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  waitMs?: number
  now?: () => number
}

export interface BacklotActionResult {
  ok: boolean
  output?: string
  error?: string
  status?: number
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

export async function runBacklotAction(deps: BacklotActionDeps, input: unknown): Promise<BacklotActionResult> {
  const action = validateBacklotAction(input)
  if (!action) return { ok: false, status: 400, error: 'Invalid action' }
  const args = buildBacklotCommand(action)
  const params = {
    line: backlotLine(args),
    ...(action.machine ? { on: action.machine } : {}),
    rm: true,
    no_parent: true,
    no_notify: true,
    labels: { [BACKLOT_LABEL]: '1' },
  }
  let address: string
  try {
    address = (await deps.call<{ address: string }>('terminal.run', params, 30000)).address
  } catch (e) {
    return { ok: false, status: 502, error: unreachable(e) ? BACKLOT_UNREACHABLE : BACKLOT_FAILED }
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = now() + (deps.waitMs ?? 8000)
  let finished = false
  let exit: number | null = null
  for (;;) {
    const t = await deps.call<{ state?: string, exit_code?: number | null }>('terminal.get', { terminal: address }, 3000).catch(() => null)
    if (!t) break
    if (t.state === 'finished') { finished = true; exit = t.exit_code ?? null; break }
    if (now() >= deadline) break
    await sleep(deps.pollMs ?? 250)
  }
  const output = concise(String((await deps.call<{ text?: string }>('terminal.read', { terminal: address, lines: 60 }, 3000).catch(() => null))?.text || ''))
  if (!finished) {
    await deps.call('terminal.rm', { terminal: address }, 3000).catch(() => {})
    return { ok: false, status: 502, error: BACKLOT_TIMEOUT }
  }
  if (exit !== 0) {
    return { ok: false, status: exit === 127 ? 400 : 502, error: exit === 127 ? BACKLOT_NOT_FOUND : BACKLOT_FAILED }
  }
  deps.clearDocs()
  return { ok: true, output }
}
