<script setup lang="ts">
// Settings › Appearance › Machine tabs: show the tabs or not, their order
// (drag the ⠿ handle, or arrow keys on it) and which ones show. A machine
// taken off the tabs still shows under "All". Kept on the server, so
// they follow the user across devices (composables/useMachineBar.ts).
import type { MachineGroup } from '~/utils/machineBar'
import type { MachineInfo } from '#shared/types'
import { BAR_ALL, moveBarItem, setBarItemShown } from '~/utils/machineBar'

const barOn = machineBarOn
const editing = ref<MachineGroup | null>(null)
const draftOrder = ref<string[]>([])
const machineLabel = (id: string) => machineName(machines.value.find(m => (m.baseKey ?? m.key) === id)?.key ?? id) || id || hostLabel.value || 'herdr'
function editGroup(group?: MachineGroup) {
  editing.value = group ? { ...group, machines: [...group.machines] } : { id: `*group:${crypto.randomUUID()}`, name: '', machines: [] }
  draftOrder.value = [...new Set([...editing.value.machines, ...(machineBaseKeys.value.length ? machineBaseKeys.value : [''])])]
}
// Home › a group tab's menu › Group settings: `?group=<id>` opens its editor,
// scrolled into view. The query goes once read, so Back or a reload keeps the list.
const route = useRoute()
const root = ref<HTMLElement | null>(null)
// Groups kept on the server may arrive after the page opens.
watch(() => [route.query.group, machineGroups.value.length] as const, ([id]) => {
  const group = typeof id === 'string' ? machineGroups.value.find(g => g.id === id) : undefined
  if (!group) return
  editGroup(group)
  const { group: _, ...query } = route.query
  navigateTo({ path: route.path, query }, { replace: true })
  nextTick(() => root.value?.scrollIntoView?.({ block: 'start' }))
}, { immediate: true })
function saveGroup() {
  const draft = editing.value
  if (!draft?.name.trim()) return
  const group = { ...draft, name: draft.name.trim(), machines: draftOrder.value.filter(id => draft.machines.includes(id)) }
  machineGroups.value = machineGroups.value.some(g => g.id === group.id)
    ? machineGroups.value.map(g => g.id === group.id ? group : g)
    : [...machineGroups.value, group]
  editing.value = null
}
function deleteGroup() {
  const id = editing.value!.id
  machineGroups.value = machineGroups.value.filter(g => g.id !== id)
  machineBarOrder.value = machineBarOrder.value.filter(x => x !== id)
  machineBarHidden.value = machineBarHidden.value.filter(x => x !== id)
  if (machineBarSaved.value === id) machineBarSaved.value = BAR_ALL
  // Projects shown in it go back to Automatic.
  if (Object.values(projectTabs.value).includes(id)) projectTabs.value = Object.fromEntries(Object.entries(projectTabs.value).filter(([, v]) => v !== id))
  editing.value = null
}
const list = ref<HTMLElement | null>(null)
// While dragging: the item, how far the pointer went, where it would land and
// each row's height (the others make room by that much).
const drag = ref<{ id: string, from: number, dy: number, to: number, h: number } | null>(null)

const STATE: Record<MachineInfo['status'], string> = { online: 'online', connecting: 'reconnecting…', offline: 'offline' }
function statusOf(id: string): MachineInfo['status'] {
  const mine = machines.value.filter(m => (m.baseKey ?? m.key) === id)
  // A single machine Herdr's state does not list: online while Herdr answers.
  if (!mine.length) return id === '' && herdrState.value.ok ? 'online' : 'offline'
  return mine.some(m => m.status === 'online') ? 'online' : mine.some(m => m.status === 'connecting') ? 'connecting' : 'offline'
}
const rows = computed(() => {
  if (editing.value) return draftOrder.value.map(id => ({ id, label: machineLabel(id), shown: editing.value!.machines.includes(id), status: statusOf(id) }))
  return machineBarItems.value.map(x => ({
    ...x,
    label: x.id === BAR_ALL ? t('All') : machineGroups.value.find(g => g.id === x.id)?.name || machineLabel(x.id),
    status: x.id === BAR_ALL || machineGroups.value.some(g => g.id === x.id) ? null : statusOf(x.id),
  }))
})
const ids = () => rows.value.map(x => x.id)
const isDefault = computed(() => !machineBarOrder.value.length && !machineBarHidden.value.length)

function setShown(id: string, shown: boolean) {
  if (editing.value) {
    editing.value.machines = shown ? [...editing.value.machines, id] : editing.value.machines.filter(x => x !== id)
    return
  }
  machineBarHidden.value = setBarItemShown(machineBarHidden.value, id, shown)
}
function move(id: string, to: number) {
  const next = moveBarItem(ids(), id, to)
  if (editing.value) draftOrder.value = next
  else if (next.join('\n') !== ids().join('\n')) machineBarOrder.value = next
}
function onKey(id: string, e: KeyboardEvent) {
  const at = ids().indexOf(id)
  if (e.key === 'ArrowUp' && at > 0) move(id, at - 1)
  else if (e.key === 'ArrowDown' && at < ids().length - 1) move(id, at + 2)
  else return
  e.preventDefault()
  haptic()
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-bar-id="${CSS.escape(id)}"] .bar-pref-grip`)?.focus())
}

// Drag by the handle (mouse, finger, pen): the row follows the pointer, the
// others make room, and the order is saved on release. The rows keep their
// place in the page until then (transforms only).
function shift(i: number) {
  const d = drag.value
  if (!d) return undefined
  if (i === d.from) return `translateY(${d.dy}px)`
  if (d.from < i && i <= d.to) return `translateY(${-d.h}px)`
  if (d.to <= i && i < d.from) return `translateY(${d.h}px)`
  return undefined
}
function blockScroll(e: TouchEvent) { if (drag.value) e.preventDefault() }
let release: (() => void) | null = null
onBeforeUnmount(() => release?.())
function onGrab(id: string, e: PointerEvent) {
  if (drag.value || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  e.preventDefault()
  const els = [...(list.value?.querySelectorAll<HTMLElement>('[data-bar-id]') || [])]
  const from = els.findIndex(el => el.dataset.barId === id)
  if (from < 0) return
  // Middles of the rows where they stand now.
  const mids = els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 })
  const h = els[from]!.getBoundingClientRect().height
  const y0 = e.clientY
  drag.value = { id, from, dy: 0, to: from, h }
  haptic()
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId || !drag.value) return
    const dy = ev.clientY - y0
    const y = mids[from]! + dy
    // Final place: the number of other rows whose middle is above the row's middle.
    const to = mids.filter((m, i) => i !== from && m < y).length
    if (to !== drag.value.to) haptic()
    drag.value = { ...drag.value, dy, to }
  }
  const end = (save: boolean) => (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return
    const d = drag.value
    release?.()
    if (save && d && d.to !== d.from) move(id, d.to > d.from ? d.to + 1 : d.to)
  }
  release = () => {
    release = null
    drag.value = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    document.removeEventListener('touchmove', blockScroll)
  }
  const up = end(true)
  const cancel = end(false)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  // iOS: the page stays still while the row moves.
  document.addEventListener('touchmove', blockScroll, { passive: false })
}
</script>

<template>
  <!-- Inside the Home screen group (Settings › Appearance › Home screen). -->
  <div ref="root" class="machine-bar-settings">
    <h4 class="theme-section-title bar-pref-title">{{ tl('Machine tabs') }}</h4>
    <label v-if="!editing" class="settings-toggle">
      <span><b>{{ tl('Show the machine tabs') }}</b><small>{{ tl('At the top of the home screen: “All”, then one tab per machine. A tap shows that machine only.') }}</small></span>
      <USwitch v-model="barOn" size="xl" />
    </label>
    <template v-if="barOn">
      <template v-if="!editing">
        <h4 class="bar-pref-head">{{ tl('Groups', 'Groupes') }}</h4>
        <ul class="machine-group-list">
          <li v-for="g in machineGroups" :key="g.id">
            <button type="button" @click="editGroup(g)">
              <UIcon name="i-lucide-group" />
              <span class="machine-group-summary"><b>{{ g.name }}</b><small>{{ g.machines.map(machineLabel).join(' · ') || tl('No machines', 'Aucune machine') }}</small></span>
              <UIcon name="i-lucide-chevron-right" />
            </button>
          </li>
        </ul>
        <UButton class="new-machine-group" color="neutral" variant="outline" icon="i-lucide-plus" @click="editGroup()">{{ tl('New group', 'Nouveau groupe') }}</UButton>
      </template>
      <template v-else>
        <UButton color="neutral" variant="ghost" icon="i-lucide-arrow-left" @click="editing = null">{{ t('Cancel') }}</UButton>
        <label class="machine-group-name">{{ tl('Group name', 'Nom du groupe') }}<input v-model="editing.name" type="text" maxlength="100" /></label>
        <p class="muted settings-hint">{{ tl('Check the machines to include. Drag the handles to set their order.', 'Cochez les machines à inclure. Glissez les poignées pour définir leur ordre.') }}</p>
      </template>
      <p v-if="!editing" class="bar-pref-head">{{ tl('Order and display', 'Ordre et affichage') }}</p>
      <ul ref="list" class="bar-pref-list" :class="{ dragging: drag }">
        <li v-for="(r, i) in rows" :key="r.id" class="bar-pref-row" :class="{ moving: drag?.id === r.id, off: !r.shown }" :style="{ transform: shift(i) }" :data-bar-id="r.id">
          <button
            type="button" class="bar-pref-grip" :aria-label="tl(`Move ${r.label} — up and down arrows`, `Déplacer ${r.label} — flèches haut et bas`)"
            :title="t('Drag to reorder')" @pointerdown="onGrab(r.id, $event)" @keydown="onKey(r.id, $event)"
          >⠿</button>
          <label class="bar-pref-label">
            <input class="agent-pref-check" type="checkbox" :checked="r.shown" @change="setShown(r.id, ($event.target as HTMLInputElement).checked)">
            <UIcon v-if="!editing && machineGroups.some(g => g.id === r.id)" name="i-lucide-group" aria-hidden="true" />
            <i v-if="r.status" class="bar-pref-state" :class="r.status" :title="t(STATE[r.status])" aria-hidden="true" />
            <span>{{ r.label }}</span>
            <small v-if="r.status && r.status !== 'online'">{{ t(STATE[r.status]) }}</small>
          </label>
        </li>
      </ul>
      <UButton v-if="!editing" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" class="bar-pref-reset" :disabled="isDefault" @click="resetMachineBar">
        {{ machineGroups.length ? tl('Reset: All + groups + machines', 'Rétablir : Toutes + groupes + machines') : tl('Reset: All + every machine', 'Rétablir : Toutes + toutes les machines') }}
      </UButton>
      <div v-if="editing" class="machine-group-actions">
        <UButton v-if="machineGroups.some(g => g.id === editing!.id)" class="delete-machine-group" color="error" variant="outline" @click="deleteGroup">{{ t('Delete') }}</UButton>
        <UButton class="save-machine-group" color="neutral" :disabled="!editing.name.trim()" @click="saveGroup">{{ t('Save') }}</UButton>
      </div>
    </template>
    <p class="muted settings-hint">{{ t('Choices follow you on every device.') }}</p>
  </div>
</template>
