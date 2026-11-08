// The coordinators (GET /api/pm/coordinators: Alfred's, then each
// project's), shared by the sidebar, the board and the conversation view,
// which shows its coordinator bar on their panes.
import { sameAgent, type CoordinatorAgent, type CoordinatorView } from '#shared/pm/coordinator'
import type { AlfredProgram } from '#shared/pm/alfred'
import type { Pane } from '#shared/types'

export const coordinators = ref<CoordinatorView[]>([])
// The projects' own coordinators: Alfred (the main one) has its own row.
export const projectCoordinators = computed(() => coordinators.value.filter(c => !c.main))
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

// Alfred, wherdr's assistant (GET /api/alfred, with projects on or off): its
// name, the program the user chose (none before its first start), the one
// running, its conversation. No model: each harness runs its own default.
export interface AlfredView { name: string, program?: AlfredProgram, ran?: AlfredProgram, terminal?: string }
export const alfred = ref<AlfredView | null>(null)
export const loadAlfred = () => api<AlfredView>('/api/alfred').then((v) => { alfred.value = v }, () => {})
export const alfredPane = computed(() => (alfred.value?.terminal ? herdrState.value?.panes.find(p => p.coreAddress === alfred.value!.terminal) : undefined))

// The coordinator a pane is, by its herdr-core address.
export const coordinatorOf = (p?: Pane | null) => (p?.coreAddress ? coordinators.value.find(c => c.terminal === p.coreAddress) : undefined)
// A coordinator's name, as the sidebar shows it: Alfred's current name for the main one.
export const coordinatorName = (c: CoordinatorView) => (c.main ? alfred.value?.name || 'Alfred' : tl(`${c.project} coordinator`, `Coordinateur ${c.project}`))
// A coordinator's pane (Alfred's included, projects on or off) is titled by its name; '' for any other pane.
export function paneCoordinatorName(p?: Pane | null) {
  if (p?.coreAddress && p.coreAddress === alfred.value?.terminal) return alfred.value.name || 'Alfred'
  const c = coordinatorOf(p)
  return c ? coordinatorName(c) : ''
}
// The pane of a coordinator's kept conversation, while it runs.
export const coordinatorPane = (c: CoordinatorView) => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)

// Its kept conversation runs with another agent than its default, and the user did not choose to resume it.
export const coordinatorMismatch = (c: CoordinatorView) => !!coordinatorPane(c) && !!c.ran && !sameAgent(c.ran, coordinatorAgent(c)) && !resumedCoordinators.value.includes(c.terminal!)

// A new conversation (its default agent, or the user's first that can run it,
// unless one is given), then its pane once herdr-core shows it.
export async function launchCoordinator(project: string, agent?: CoordinatorAgent) {
  const c = coordinators.value.find(x => x.project === project)
  const { terminal } = await api<{ terminal: string }>('/api/pm/coordinator-start', { project, ...(agent ?? (c ? coordinatorAgent(c) : undefined)) })
  await loadCoordinators()
  for (let i = 0; i < 40; i++) {
    const p = herdrState.value?.panes.find(x => x.coreAddress === terminal)
    if (p) return p
    await new Promise(r => setTimeout(r, 250))
  }
  return undefined
}

// One tap: its conversation while it runs, else a new one with its default agent.
export async function openCoordinator(c: CoordinatorView) {
  const p = coordinatorPane(c) ?? await launchCoordinator(c.project, coordinatorAgent(c))
  if (p) await navigateTo(panePath(p.id))
}
