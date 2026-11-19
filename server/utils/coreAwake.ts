// Keep a machine awake through herdr-core: the scripts of shared/awake.ts run on that
// machine with machine.exec (this core's own machine too), never over our own SSH.
import { CoreError } from './core'
import { HerdrError } from './herdr'
import { failure } from './coreInput'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { fmt } from '../../shared/message'
import { AWAKE_ERRORS, AWAKE_MODES, STATUS_SCRIPT, parseAwakeStatus, parseControl, setScript, type AwakeMode } from '../../shared/awake'

// The status read answers in well under a second on a machine that is awake: a
// short wait, so an unreachable one says so quickly. Starting an inhibitor waits
// up to 6 s on the machine (controlScript).
const READ_S = 8
const SET_S = 15

// Why it failed, in herdr-core's words: the reason the app shows after "Could not reach <machine>:".
async function run(deps: CoreAdminDeps, on: string | undefined, script: string, args: string[], timeout: number) {
  const r = await deps.call<{ code: number | null, stdout: string, stderr?: string, timed_out?: boolean }>('machine.exec',
    { argv: ['sh', '-c', script, 'sh', ...args], ...(on ? { on } : {}), timeout }, (timeout + 5) * 1000)
    .catch((e: unknown) => {
      if (!(e instanceof CoreError)) return failure(e)
      throw new HerdrError('awake_unreachable', e.kind === 'timeout' ? fmt('no answer in {s} s', { s: timeout + 5 }) : `herdr-core: ${e.message || e.kind}`)
    })
  if (r.timed_out) throw new HerdrError('awake_unreachable', fmt('no answer in {s} s', { s: timeout }))
  if (r.code !== 0) {
    const err = Buffer.from(r.stderr || '', 'base64').toString('utf8').trim().split('\n').pop()
    throw new HerdrError('awake_command_failed', fmt('the keep-awake command failed (exit {code}){err}', { code: String(r.code), err: err ? `: ${err}` : '' }))
  }
  return Buffer.from(r.stdout || '', 'base64').toString('utf8')
}

export async function coreAwakeStatus(deps: CoreAdminDeps, key: unknown) {
  const { m, on } = machineOn(deps, key)
  try { return parseAwakeStatus(await run(deps, on, STATUS_SCRIPT, [], READ_S)) }
  catch (e) {
    console.warn(`[awake] ${m.label}: status read failed: ${(e as Error).message}`)
    throw e
  }
}

// Two execs: the change (its own platform and tool check), then a new read, so the
// state shown is that of the inhibitor still running once the first exec has ended.
export async function coreSetAwake(deps: CoreAdminDeps, body: { key?: unknown, mode?: unknown }) {
  const mode = body.mode as AwakeMode | 'off'
  if (!AWAKE_MODES.includes(mode)) throw new HerdrError('bad_mode', AWAKE_ERRORS.bad_mode!)
  const { on } = machineOn(deps, body.key)
  const result = parseControl(await run(deps, on, setScript(), [mode], SET_S))
  if ('error' in result) throw new HerdrError(`awake_${result.error}`, AWAKE_ERRORS[result.error] || 'Keep-awake command failed')
  const after = parseAwakeStatus(await run(deps, on, STATUS_SCRIPT, [], READ_S))
  if (mode !== 'off' && !after.active) throw new HerdrError('awake_start_failed', AWAKE_ERRORS.start_failed!)
  return after
}
