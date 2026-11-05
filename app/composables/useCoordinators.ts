// The project coordinators (GET /api/pm/coordinators), shared by the board
// and the conversation view, which shows its coordinator bar on their panes.
import type { CoordinatorAgent, CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

export const coordinators = ref<CoordinatorView[]>([])
let loading: Promise<void> | null = null
// Kept conversations of another agent the user chose to resume: no warning
// any more, also after a reload (this browser only).
const RESUMED_KEY = 'wherdr.coordinatorsResumed'
const readResumed = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(RESUMED_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] }
  catch { return [] }
}
export const resumedCoordinators = ref<string[]>(import.meta.client ? readResumed() : [])
export function resumeCoordinator(terminal: string) {
  resumedCoordinators.value = [...resumedCoordinators.value.filter(x => x !== terminal), terminal].slice(-20)
  try { localStorage.setItem(RESUMED_KEY, JSON.stringify(resumedCoordinators.value)) } catch {}
}

export function loadCoordinators() {
  return (loading ??= api<CoordinatorView[]>('/api/pm/coordinators')
    .then((v) => { coordinators.value = Array.isArray(v) ? v : [] }, () => {})
    .finally(() => { loading = null }))
}

// The coordinator a pane is, by its herdr-core address.
export const coordinatorOf = (p?: Pane | null) => (p?.coreAddress ? coordinators.value.find(c => c.terminal === p.coreAddress) : undefined)
// The pane of a coordinator's kept conversation, while it runs.
export const coordinatorPane = (c: CoordinatorView) => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)

// A new conversation (the project's default agent unless one is given), then
// its pane once herdr-core shows it.
export async function launchCoordinator(project: string, agent?: CoordinatorAgent) {
  const { terminal } = await api<{ terminal: string }>('/api/pm/coordinator-start', { project, ...agent })
  await loadCoordinators()
  for (let i = 0; i < 40; i++) {
    const p = herdrState.value?.panes.find(x => x.coreAddress === terminal)
    if (p) return p
    await new Promise(r => setTimeout(r, 250))
  }
  return undefined
}
