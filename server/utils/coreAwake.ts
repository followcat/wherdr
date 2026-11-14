// Keep a machine awake through herdr-core: the scripts of shared/awake.ts run on that
// machine with machine.exec (this core's own machine too), never over our own SSH.
import { HerdrError } from './herdr'
import { failure } from './coreInput'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { AWAKE_ERRORS, AWAKE_MODES, STATUS_SCRIPT, controlScript, parseAwakeStatus, parseControl, type AwakeMode } from '../../shared/awake'

async function run(deps: CoreAdminDeps, on: string | undefined, script: string, args: string[] = []) {
  const r = await deps.call<{ code: number | null, stdout: string, timed_out?: boolean }>('machine.exec',
    { argv: ['sh', '-c', script, 'sh', ...args], ...(on ? { on } : {}), timeout: 15 }, 20000).catch(failure)
  if (r.timed_out || r.code !== 0) throw new HerdrError('awake_command_failed', 'Keep-awake command failed')
  return Buffer.from(r.stdout || '', 'base64').toString('utf8')
}

export async function coreAwakeStatus(deps: CoreAdminDeps, key: unknown) {
  return parseAwakeStatus(await run(deps, machineOn(deps, key).on, STATUS_SCRIPT))
}

export async function coreSetAwake(deps: CoreAdminDeps, body: { key?: unknown, mode?: unknown }) {
  const mode = body.mode as AwakeMode | 'off'
  if (!AWAKE_MODES.includes(mode)) throw new HerdrError('bad_mode', AWAKE_ERRORS.bad_mode!)
  const { on } = machineOn(deps, body.key)
  const status = parseAwakeStatus(await run(deps, on, STATUS_SCRIPT))
  if (!status.supported) throw new HerdrError('awake_unsupported', AWAKE_ERRORS.no_tool!)
  const result = parseControl(await run(deps, on, controlScript(status.platform), [mode]))
  if ('error' in result) throw new HerdrError(`awake_${result.error}`, AWAKE_ERRORS[result.error] || 'Keep-awake command failed')
  // Read again in a new exec: the state shown is that of the process still running.
  const after = parseAwakeStatus(await run(deps, on, STATUS_SCRIPT))
  if (mode !== 'off' && !after.active) throw new HerdrError('awake_start_failed', AWAKE_ERRORS.start_failed!)
  return after
}
