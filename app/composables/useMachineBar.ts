// Machine bar of the home list (utils/machineBar.ts): its settings and the
// current choice.
import { flag, syncedRef } from './useSyncedSettings'
import { readProjectTabs } from '#shared/settings'
import { BAR_ALL, groupedBarItems, barMachineSelection, barPick, readBarList, readBarPick, readMachineGroups } from '~/utils/machineBar'
import { projectTabMachines, tabHolds } from '~/utils/projectTabs'
import { projectCoordinators } from './useCoordinators'

const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}

// The bar's settings and the groups follow the user across devices (kept on
// the server, useSyncedSettings.ts); the item last tapped stays on the device.
export const machineBarOn = syncedRef('machineBar', flag.read(true), flag.write)
export const machineBarOrder = syncedRef<string[]>('machineBarOrder', readBarList, v => JSON.stringify(v), { deep: true })
export const machineBarHidden = syncedRef<string[]>('machineBarHidden', readBarList, v => JSON.stringify(v), { deep: true })
// The item last tapped (BAR_ALL, a group's ID, or a machine's base key).
export const machineBarSaved = ref<string | null>(readBarPick(store.get('machineBarPick')))
watch(machineBarSaved, (v) => { store.set('machineBarPick', JSON.stringify(v)) })

export const machineGroups = syncedRef('machineGroups', readMachineGroups, v => JSON.stringify(v), { deep: true })

// Base keys of the machines (a named session counts as its machine).
export const machineBaseKeys = computed(() => [...new Set(machines.value.map(m => m.baseKey ?? m.key))])
// The machines the bar offers: with a single machine Herdr's state may list
// none, and that machine is the local one ('').
const barMachines = computed(() => (machineBaseKeys.value.length ? machineBaseKeys.value : ['']))

// ------------------------------------------------------------ the bar
// Settings list: every item, in order, with whether the bar shows it.
export const machineBarItems = computed(() => groupedBarItems(machineBarOrder.value, barMachines.value, machineGroups.value)
  .map(id => ({ id, shown: !machineBarHidden.value.includes(id) })))
// The bar shows by default, a single machine included ("All", then that machine).
export const machineBarShown = computed(() => (machineBarOn.value
  ? machineBarItems.value.filter(x => x.shown).map(x => x.id)
  : []))
export const machineBarPick = computed(() => barPick(machineBarSaved.value, machineBarShown.value))
// Ordered base keys shown by the selection, or null for every machine.
export const machineBarSelection = computed(() => barMachineSelection(machineBarPick.value, machineGroups.value))
export function pickMachineBar(id: string) {
  machineBarSaved.value = id
}
export function resetMachineBar() {
  machineBarOrder.value = []
  machineBarHidden.value = []
  machineBarSaved.value = BAR_ALL
}

// Which home tab shows each project (utils/projectTabs.ts): fixed project key -> group id or '*'.
export const projectTabs = syncedRef('projectTabs', readProjectTabs, v => JSON.stringify(v), { deep: true })

// Each project's tab machines (utils/projectTabs.ts), by its fixed key.
// Alfred is not in it: it shows on every tab. A workspace not pinned shows
// under its tab group; its members (no coordinator of their own) show where it does.
export const projectTabPlaces = computed(() => new Map(projectCoordinators.value.flatMap((c) => {
  const place = projectTabMachines({ machines: c.machines ?? [], paused: c.paused, busy: c.busy }, projectTabs.value[c.project] ?? c.workspace?.group, machineGroups.value)
  return [[c.project, place] as const, ...(c.workspace?.members ?? []).map(m => [m.key, place] as const)]
})))
// The home tab picked shows this project (a project not loaded yet shows).
export const projectOnBar = (project: string) => tabHolds(projectTabPlaces.value.get(project), machineBarSelection.value)
// Whether a bar item (its id) holds a project.
export const projectOnBarItem = (project: string, id: string) => tabHolds(projectTabPlaces.value.get(project), barMachineSelection(id, machineGroups.value))
// A bar item's name: All, a group's name, or its machine's.
export function barItemLabel(id: string) {
  if (id === BAR_ALL) return t('All')
  const group = machineGroups.value.find(g => g.id === id)
  const m = machines.value.find(x => (x.baseKey ?? x.key) === id)
  return group?.name || (m && machineName(m.key)) || id || t('This machine')
}
// Where each running coordinator's conversation belongs (machineConversation.ts).
export const coordinatorPlaces = computed(() => projectCoordinators.value.flatMap(c =>
  c.terminal ? [{ terminal: c.terminal, tabMachines: projectTabPlaces.value.get(c.project) ?? null }] : []))
