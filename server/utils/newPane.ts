// Pane just created by "Split" or "New tab": wherdr's pane list may not have
// seen it yet. Fresh polls of its machine, for a bounded time, before saying
// it does not exist.
export const NEW_PANE_WAIT_MS = 2000
const STEP_MS = 250

export interface NewPaneDeps<P> {
  find: (id: string) => P | undefined
  refresh: () => Promise<void>
  sleep: (ms: number) => Promise<unknown>
  now?: () => number
}

export async function findNewPane<P>(id: string, d: NewPaneDeps<P>, waitMs = NEW_PANE_WAIT_MS): Promise<P | undefined> {
  const now = d.now || Date.now
  const end = now() + waitMs
  for (;;) {
    const p = d.find(id)
    if (p) return p
    await d.refresh()
    const q = d.find(id)
    if (q) return q
    if (now() >= end) return undefined
    await d.sleep(STEP_MS)
  }
}
