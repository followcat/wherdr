// Machines of the quota readings on herdr-core: this machine's disk and each
// connected core machine through `machine.exec` (files read by small shell
// commands, like v2's SSH machines). Never writes outside the quota status line install.
import { HOME } from './env'
import { createShellFs, localFs } from './fsx'
import { coreShell } from './coreTranscripts'
import { uniqueBaseMachines, type CoreAdminDeps } from './coreCreate'
import type { QuotaMachine } from './quotas'

const homes = new Map<string, string>()

// This machine, then the core's remote machines (offline ones are listed with no home: skipped by the reader).
export async function coreQuotaMachines(deps: CoreAdminDeps): Promise<QuotaMachine[]> {
  return Promise.all(uniqueBaseMachines(deps.machines()).map(async (m): Promise<QuotaMachine> => {
    const baseKey = m.baseKey ?? m.key
    if (m.local) return { key: baseKey, label: m.label, local: true, status: 'online', home: HOME, fs: localFs, exec: null }
    const base = { key: baseKey, label: m.label, local: false, status: m.status }
    if (m.status !== 'online') return { ...base, home: '', fs: localFs, exec: null }
    const callFn = deps.callFor?.(m.key) ?? deps.call
    const exec = coreShell(callFn, m.label)
    let home = homes.get(m.key) || homes.get(m.label) || ''
    if (!home) {
      const r = await exec('printf %s "$HOME"')
      home = r.code === 0 ? r.stdout.toString('utf8').trim() : ''
      if (home) homes.set(m.key, home)
    }
    return { ...base, home, fs: createShellFs(exec), exec }
  }))
}
