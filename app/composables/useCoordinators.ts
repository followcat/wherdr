// The coordinators (GET /api/pm/coordinators: Alfred's, then each
// project's), shared by the sidebar, the board and the conversation view,
// which shows its coordinator bar on their panes.
import { MAIN, sameAgent, type CoordinatorAgent, type CoordinatorView } from '#shared/pm/coordinator'
import type { AlfredProgram } from '#shared/pm/alfred'
import { projectCoordinatorName } from '#shared/pm/project'
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

// Read once at least: until then a coordinator's pane shows its session title.
export const coordinatorsLoaded = ref(false)
export function loadCoordinators() {
  // A deadline: a read lost while the phone slept would otherwise hold
  // `loading`, and every later call would wait on it forever.
  return (loading ??= api<CoordinatorView[]>('/api/pm/coordinators', undefined, AbortSignal.timeout(8000))
    .then((v) => { coordinators.value = Array.isArray(v) ? v : []; coordinatorsLoaded.value = true }, () => {})
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
// A coordinator's name, as the sidebar shows it (after its key badge): Alfred's
// current name for the main one, else the one the user gave it or its project's.
export const coordinatorName = (c: CoordinatorView) => (c.main ? alfred.value?.name || 'Alfred' : projectCoordinatorName(c))
// Alfred's own pane: its header shows its emblem.
export const isAlfredPane = (p?: Pane | null) => Boolean(p?.coreAddress && p.coreAddress === alfred.value?.terminal)
// A pane's project key badge, in its header: a project coordinator's key (its
// title then reads its name), or a task agent's task id (shown key, WD-5).
export function paneBadge(p?: Pane | null): { text: string, color?: string, coordinator?: true } | null {
  const c = coordinatorOf(p)
  if (c) return c.main ? null : { text: c.label ?? c.project, color: c.color, coordinator: true }
  const i = p?.task?.lastIndexOf('-') ?? -1
  if (!p?.task || i < 1) return null
  const pc = projectCoordinators.value.find(x => x.project === p.task!.slice(0, i))
  return { text: `${pc?.label ?? p.task.slice(0, i)}${p.task.slice(i)}`, color: pc?.color }
}
// A coordinator's pane (Alfred's included, projects on or off) is titled by its name; '' for any other pane.
export function paneCoordinatorName(p?: Pane | null) {
  if (p?.coreAddress && p.coreAddress === alfred.value?.terminal) return alfred.value.name || 'Alfred'
  const c = coordinatorOf(p)
  return c ? coordinatorName(c) : ''
}
// The coordinator (its project key, MAIN for Alfred) running in this
// herdr-core terminal, if any, and its name as the sidebar shows it.
export function coordinatorAtAddress(address?: string | null): { project: string, name: string } | undefined {
  if (!address) return undefined
  if (address === alfred.value?.terminal) return { project: MAIN, name: alfred.value.name || 'Alfred' }
  const c = coordinators.value.find(x => x.terminal === address)
  return c ? { project: c.project, name: coordinatorName(c) } : undefined
}
// A coordinator's current name by its project key (MAIN: Alfred), '' when unknown.
export function coordinatorNameOf(project: string) {
  if (project === MAIN) return alfred.value?.name || coordinators.value.find(c => c.main)?.name || 'Alfred'
  const c = coordinators.value.find(x => x.project === project)
  return c ? coordinatorName(c) : ''
}
// The pane of a coordinator's kept conversation, while it runs.
export const coordinatorPane = (c: CoordinatorView) => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)
// Its conversation stopped (its terminal ended: its machine restarted, say):
// it can be resumed. Unknown until herdr-core's panes are read live (ok), and
// while the offline copy shows: a running one would look stopped.
export const coordinatorStopped = (c: CoordinatorView) => !!c.terminal && !!c.ran && herdrState.value.ok && !offlineView.value && !coordinatorPane(c)

// Its kept conversation runs with another agent than its default, and the user did not choose to resume it.
export const coordinatorMismatch = (c: CoordinatorView) => !!coordinatorPane(c) && !!c.ran && !sameAgent(c.ran, coordinatorAgent(c)) && !resumedCoordinators.value.includes(c.terminal!)

// A new conversation (its default agent, or the user's first that can run it,
// unless one is given), or its last one resumed, then its pane once herdr-core shows it.
export async function launchCoordinator(project: string, agent?: CoordinatorAgent | 'resume') {
  const c = coordinators.value.find(x => x.project === project)
  const how = agent === 'resume' ? { resume: true } : agent ?? (c ? coordinatorAgent(c) : undefined)
  const { terminal } = await api<{ terminal: string }>('/api/pm/coordinator-start', { project, ...how })
  await loadCoordinators()
  for (let i = 0; i < 40; i++) {
    const p = herdrState.value?.panes.find(x => x.coreAddress === terminal)
    if (p) return p
    await new Promise(r => setTimeout(r, 250))
  }
  return undefined
}

// Hands a request to Alfred: its conversation (started with its agent, else
// the first offered one), the request sent, then opened. The setup window and
// Home's empty state ask it to set up projects this way.
export const ALFRED_SETUP_PROMPT = 'Help me set up project management in wherdr, one question at a time: turn it on, add a project and start its coordinator, which then sets up how I work with me.'
export async function askAlfred(text: string) {
  await loadAlfred()
  const program = alfred.value?.program ?? offerCoordinators(appConfig.value.kinds)[0]
  const pane = alfredPane.value ?? (program ? await launchCoordinator(MAIN, { program }) : undefined)
  if (!pane) throw new Error('Alfred could not start: check Settings › Agents.')
  await sendMessage(pane, pane.id, text)
  await navigateTo(panePath(pane.id))
}

// The setup window's last step: the project's coordinator, started with the
// agent and model picked (kept as its default), then its conversation. Its
// first start on a project with no workflow proposes one (startCoordinator).
export async function meetCoordinator(project: string, agent?: CoordinatorAgent) {
  const c = coordinators.value.find(x => x.project === project)
  let pane = c ? coordinatorPane(c) : undefined
  if (!pane) {
    if (agent) await api('/api/pm/coordinator-agent', { project, ...agent })
    pane = await launchCoordinator(project, agent)
    if (!pane) throw new Error('The coordinator could not start: check Settings › Agents.')
  }
  await navigateTo(panePath(pane.id))
}

// One tap: its conversation while it runs, else a new one with its default agent.
// draft: a first message offered in its field, unless the user already wrote one.
export async function openCoordinator(c: CoordinatorView, draft?: string) {
  const p = coordinatorPane(c) ?? await launchCoordinator(c.project, coordinatorAgent(c))
  if (!p) return
  const d = draft ? useDraft(p.id) : null
  if (d && !d.text.trim()) d.text = draft!
  await navigateTo(panePath(p.id))
}
