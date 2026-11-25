// Machine of an agent's file browser with herdr-core. The local core runs on this
// computer (local disk); a remote core machine is reached with `machine.exec`
// (same shell scripts as v2, through coreShell), its home folder read once.
import { coreCall } from './core'
import { HerdrError } from './herdr'
import { coreShell } from './coreTranscripts'
import { localMachine, type Machine } from './machines'
import { getPoolRuntime } from './corePool'
import { fmt } from '../../shared/message'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
const defaultCall: Call = (method, params, timeout) => coreCall(process.env.HC_SOCKET || '', method, params, timeout)

const homes = new Map<string, string>()

export async function coreFilesMachine(key: unknown, opts: { call?: Call, machines?: () => { key: string, label: string, status: string, local?: boolean }[] } = {}): Promise<Machine> {
  const k = String(key || '')
  if (!k) return localMachine
  const rt = getPoolRuntime()
  const info = (opts.machines?.() ?? rt?.getState().machines ?? []).find(m => m.key === k)
  if (!info) throw new HerdrError('bad_machine', 'unknown machine')
  if (info.local) {
    const status = info.status as Machine['status']
    return { ...localMachine, key: k, label: info.label || localMachine.label, status, info: () => ({ ...localMachine.info(), ...info, status }) }
  }
  if (info.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: info.label }))
  const call = opts.call ?? rt?.forMachine(k)?.call ?? (opts.machines ? defaultCall : undefined)
  if (!call) throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: info.label }))
  const exec = coreShell(call, info.label)
  let home = homes.get(k)
  if (!home) {
    home = (await exec('printf %s "$HOME"')).stdout.toString('utf8').trim()
    if (!home.startsWith('/')) throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: info.label }))
    homes.set(k, home)
  }
  return { ...localMachine, key: k, label: info.label, local: false, home, status: 'online', exec, spawnShell: undefined }
}
