// A terminal that simply exited is removed from herdr-core at once: a shell or
// an interactive agent leaves no `finished` entry behind. Only `exited` counts:
// `killed`, `signaled`, `holder_lost`, `server_stop`, `host_shutdown` and
// `stopped_by_restart` records stay, and so do PM workers, reviewers and
// coordinators (their wherdr.run / wherdr.task / wherdr.coordinator labels): a
// finished state is how the engine reads a step's end.
export interface ReapCandidate {
  address?: string
  state?: string
  reason?: string | null
  exit_code?: number | null
  created_ms?: number
  labels?: Record<string, string>
}

const PM_LABELS = ['wherdr.run', 'wherdr.task', 'wherdr.coordinator']
// A wherdr launch that failed may still be read by coreCreate's launchFailure
// (it calls terminal.rm itself): leave the entry for this long after creation.
const LAUNCH_READ_MS = 5000

export function shouldReapExited(t: ReapCandidate, nowMs = Date.now()): boolean {
  if (t.state !== 'finished' || t.reason !== 'exited') return false
  const labels = t.labels ?? {}
  if (PM_LABELS.some(l => labels[l] !== undefined)) return false
  if (labels['wherdr-request'] !== undefined && (t.exit_code ?? 0) !== 0 && typeof t.created_ms === 'number' && nowMs - t.created_ms < LAUNCH_READ_MS) return false
  return true
}

export type ReapCall = <T>(method: string, params: object, timeout: number) => Promise<T>

// terminal.rm for reaped terminals, one in-flight call per address: a burst of
// `finished` facts for the same terminal does not spam core.
export function createCoreReaper({ call }: { call: ReapCall }) {
  const inflight = new Set<string>()
  return {
    maybeReap(t: ReapCandidate, nowMs = Date.now()): Promise<void> | undefined {
      const address = t.address
      if (!address || inflight.has(address) || !shouldReapExited(t, nowMs)) return undefined
      inflight.add(address)
      const done = () => { inflight.delete(address) }
      return call('terminal.rm', { terminal: address }, 5000).then(done, done)
    },
  }
}
