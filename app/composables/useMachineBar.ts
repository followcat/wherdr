// Machine bar of the home list (utils/machineBar.ts): its settings and the
// current choice.
import { flag, syncedRef } from './useSyncedSettings'
import { readProjectTabs } from '#shared/settings'
import { BAR_ALL, groupedBarItems, barMachineSelection, barPick, readBarList, readBarPick, readMachineGroups } from '~/utils/machineBar'
import { projectOnTab, projectTabMachines } from '~/utils/projectTabs'
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
// Alfred is not in it: it shows on every tab.
export const projectTabPlaces = computed(() => new Map(projectCoordinators.value.map(c =>
  [c.project, projectTabMachines({ machines: c.machines ?? [], paused: c.paused, busy: c.busy }, projectTabs.value[c.project], machineGroups.value)])))
// The home tab picked shows this project (a project not loaded yet shows).
export const projectOnBar = (project: string) => {
  const m = projectTabPlaces.value.get(project)
  return m === undefined || projectOnTab(m, machineBarSelection.value)
}
// Where each running coordinator's conversation belongs (machineConversation.ts).
export const coordinatorPlaces = computed(() => projectCoordinators.value.flatMap(c =>
  c.terminal ? [{ terminal: c.terminal, tabMachines: projectTabPlaces.value.get(c.project) ?? null }] : []))
