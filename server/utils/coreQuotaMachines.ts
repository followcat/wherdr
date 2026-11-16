// Machines of the quota readings on herdr-core: this machine's disk and each
// connected core machine through `machine.exec` (files read by small shell
// commands, like v2's SSH machines). Never writes outside the quota status line install.
import { HOME } from './env'
import { createShellFs, localFs } from './fsx'
import { coreShell } from './coreTranscripts'
import type { CoreAdminDeps } from './coreCreate'
import type { QuotaMachine } from './quotas'

const homes = new Map<string, string>()

// This machine, then the core's remote machines (offline ones are listed with no home: skipped by the reader).
export async function coreQuotaMachines(deps: CoreAdminDeps): Promise<QuotaMachine[]> {
  return Promise.all(deps.machines().map(async (m): Promise<QuotaMachine> => {
    if (m.local) return { key: m.key, label: m.label, local: true, status: 'online', home: HOME, fs: localFs, exec: null }
    const base = { key: m.key, label: m.label, local: false, status: m.status }
    if (m.status !== 'online') return { ...base, home: '', fs: localFs, exec: null }
    const exec = coreShell(deps.call, m.label)
    let home = homes.get(m.label) || ''
    if (!home) {
      const r = await exec('printf %s "$HOME"')
      home = r.code === 0 ? r.stdout.toString('utf8').trim() : ''
      if (home) homes.set(m.label, home)
    }
    return { ...base, home, fs: createShellFs(exec), exec }
  }))
}
