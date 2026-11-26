// The Studio view's data: the backlot summary of each machine, polled lazily
// while the home list is visible (never part of the home first load), and the
// validated actions run on a studio's machine.
import type { BacklotAction, BacklotMachineView, BacklotStudio } from '#shared/backlot'
import { api, netDown, offlineView, sessionTabPick } from './useHerdr'

export interface BacklotStudioView {
  machine: string
  label: string
  stageRunning: boolean
  doc: BacklotMachineView
  studio: BacklotStudio
}

export function filterBacklotBySession(machines: readonly BacklotMachineView[], sessionKey: string): BacklotMachineView[] {
  return machines.filter(m => (m.session ?? '') === sessionKey)
}

export const allBacklotMachines = shallowRef<BacklotMachineView[]>([])
export const backlotMachines = computed<BacklotMachineView[]>(() => filterBacklotBySession(allBacklotMachines.value, sessionTabPick.value))
export const backlotError = ref('')
export const backlotLoaded = ref(false)
export const backlotStudios = computed<BacklotStudioView[]>(() => backlotMachines.value.flatMap(doc =>
  doc.summary.studios.map(studio => ({ machine: doc.machine, label: doc.label, stageRunning: doc.stageRunning, doc, studio }))))

const POLL_MS = 5000
let timer: ReturnType<typeof setTimeout> | null = null
let started = 0
let inFlight: Promise<void> | null = null

export function refreshBacklot(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const r = await api<{ ok: boolean, machines: BacklotMachineView[], error?: string }>('/api/backlot')
      if (r.ok) {
        allBacklotMachines.value = Array.isArray(r.machines) ? r.machines : []
        backlotError.value = ''
      } else {
        backlotError.value = r.error || 'Backlot unavailable'
        allBacklotMachines.value = []
      }
    } catch (e) {
      // A read that fails keeps the last known studios: the home list does not change around it.
      backlotError.value = (e as Error).message
    } finally {
      backlotLoaded.value = true
      inFlight = null
    }
  })()
  return inFlight
}

// The next poll: paused while the page is hidden or the server is offline.
function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(run, POLL_MS)
}
async function run() {
  timer = null
  if (typeof document === 'undefined' || document.hidden || netDown.value || offlineView.value) { schedule(); return }
  await refreshBacklot()
  schedule()
}
function onVisible() {
  if (document.hidden) return
  void refreshBacklot()
  schedule()
}

export function startBacklotPolling() {
  if (started++) return
  void refreshBacklot()
  schedule()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
}

export function stopBacklotPolling() {
  if (!started || --started) return
  if (timer) clearTimeout(timer)
  timer = null
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
}

// Runs one action; a success refreshes the studios before the sheet shows it.
export async function runBacklotAction(action: BacklotAction) {
  const r = await api<{ ok: boolean, output?: string, error?: string }>('/api/backlot/action', action)
  if (r.ok) await refreshBacklot()
  return r
}

export function useBacklot() {
  onMounted(startBacklotPolling)
  onUnmounted(stopBacklotPolling)
  return { backlotMachines, allBacklotMachines, backlotStudios, backlotError, refreshBacklot, runBacklotAction }
}
