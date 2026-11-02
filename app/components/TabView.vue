<script setup lang="ts">
const backToOrigin = useViewBack()
// Tab of a Herdr workspace, in its real proportions. Phone: plan of
// summary cards; tapping a cell opens the pane full screen (mini-map and
// swipe to the neighbours). Computer: the panes side by side, every cell live
// (conversation or terminal); the active cell (click) gets the keyboard. A
// terminal shown in a cell fits its pane to the cell, and each pane gets its
// size back when the tab is left (server/utils/paneSizes.ts). Herdr's focus and
// zoom are never changed: wherdr's active cell is not Herdr's focus. The layout,
// shared with the attached client, only changes on an explicit gesture:
// dragging a pane (header handle, long press on the phone) onto
// another, and dragging a divider to resize.
import { type Divider, type DropSide, type TabLayout, dividers, dropPreview, dropZone, neighborPane, paneBoxes, ratioAt, resizePreview } from '#shared/layout'
import { longPress } from '~/utils/longPress'
import { skipsPress } from '~/utils/headerMenu'
import { cellFocusStep } from '~/utils/viewMode'
import { tabRouteStatus } from '~/utils/tabRoute'

const props = defineProps<{ tabId: string }>()
const route = useRoute()
const router = useRouter()
// Plan (phone): no pane viewed. Side by side: the active cell handles it.
onMounted(() => { if (!desk.value) curPane.value = null })

const entry = computed(() => tabOf(props.tabId))
const headerAdd = computed(() => entry.value && spaceTabControls(spaceTabs(entry.value.tab.workspace).length).headerAdd)
const ws = computed(() => (entry.value ? herdrState.value.workspaces.find(w => w.id === entry.value!.tab.workspace) : undefined))
const byId = computed(() => new Map((entry.value?.panes || []).map(p => [p.id, p])))
// Preview while dragging a divider.
const preview = ref<TabLayout | null>(null)
const layout = computed(() => preview.value || entry.value?.layout || null)
const boxes = computed(() => (layout.value ? paneBoxes(layout.value).filter(b => byId.value.has(b.pane)) : []))
const draggable = computed(() => !offlineView.value && tabDraggable(props.tabId))
const divs = computed(() => (draggable.value && layout.value ? dividers(layout.value) : []))
const machine = computed(() => (multiMachine.value && entry.value ? machineInfo(entry.value.tab.machine) : undefined))
const tabLabel = (label: string, n: number) => label || String(n)

// Tab closed while being viewed (same grace period as the agent view).
const seen = ref(Boolean(entry.value))
const graceOver = ref(false)
const graceTimer = setTimeout(() => { graceOver.value = true }, 4000)
onUnmounted(() => clearTimeout(graceTimer))
watch(entry, (e) => { if (e) seen.value = true })
const closed = computed(() => tabRouteStatus(Boolean(entry.value), herdrState.value.ok, herdrState.value.ready !== false, graceOver.value, seen.value) === 'unavailable' && !isClosing(props.tabId))

// Active cell (computer): the requested one (?pane=, coming from the agent view or
// from a split, applied as soon as the pane appears in the state), otherwise the
// active pane in Herdr, otherwise the first; kept if it still exists.
const active = ref<string | null>(null)
const asked = computed(() => String(route.query.pane || ''))
watch([entry, asked], ([e, want], old) => {
  if (!e) return
  const ids = e.panes.map(p => p.id)
  if (want && ids.includes(want) && (want !== old?.[1] || !old?.[0]?.panes.some(p => p.id === want))) {
    active.value = want
    return
  }
  if (active.value && ids.includes(active.value)) return
  active.value = ids.includes(want) ? want : e.layout.focused && ids.includes(e.layout.focused) ? e.layout.focused : ids[0] || null
}, { immediate: true })
function activate(paneId: string) {
  if (active.value === paneId) return
  active.value = paneId
  router.replace({ query: { pane: paneId } })
}
// Keyboard: Ctrl/⌘ + Alt + arrow, neighbouring cell (caught before the terminal).
function onFocusKey(e: KeyboardEvent) {
  const step = desk.value && entry.value && active.value ? cellFocusStep(e) : 0
  if (!step) return
  // Consumed even without a neighbour that way: the terminal must not get the sequence.
  e.preventDefault()
  e.stopPropagation()
  const next = neighborPane(entry.value!.layout, active.value!, step)
  if (next) activate(next)
}
onMounted(() => window.addEventListener('keydown', onFocusKey, true))
onUnmounted(() => window.removeEventListener('keydown', onFocusKey, true))

// Header (right click, long press) and "…" button: the tab then its space.
const tabMenu = () => [...tabPlanItems(props.tabId), ...settingsMenuItems()]
const tabMenuTitle = computed(() => entry.value ? `${t('Tab')} ${tabLabel(entry.value.tab.label, entry.value.tab.number)}` : undefined)

// ---------- Drag a pane onto another ----------
// Computer: handle of the cell header (mouse or finger). Phone:
// long press on the plan cell. Drop zones: center = swap, edges =
// place beside (only if it changes the layout).
const area = ref<HTMLElement | null>(null)
interface Drag { pane: string, pointer: number, touch: boolean, x0: number, y0: number, x: number, y: number, started: boolean, over: string | null, side: DropSide | null }
const drag = ref<Drag | null>(null)
const ZONE_LABEL: Record<DropSide, string> = { center: 'Swap', left: 'Place left', right: 'Place right', up: 'Place above', down: 'Place below' }
// Position du pointeur en pourcentage de l'onglet.
function inArea(x: number, y: number) {
  const r = area.value?.getBoundingClientRect()
  return r && r.width > 0 && r.height > 0 ? { px: ((x - r.left) / r.width) * 100, py: ((y - r.top) / r.height) * 100 } : null
}
function startDrag(pane: string, e: PointerEvent, started: boolean) {
  if (!draggable.value) return
  drag.value = { pane, pointer: e.pointerId, touch: e.pointerType !== 'mouse', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started, over: null, side: null }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragCancel)
  // Capture: Escape cancels the drag before anything else reads it (Stop: useShortcuts).
  window.addEventListener('keydown', onDragKey, true)
}
function onDragMove(e: PointerEvent) {
  const d = drag.value
  if (!d || e.pointerId !== d.pointer) return
  d.x = e.clientX
  d.y = e.clientY
  if (!d.started && Math.hypot(d.x - d.x0, d.y - d.y0) > 5) d.started = true
  if (!d.started) return
  e.preventDefault()
  const at = inArea(d.x, d.y)
  const b = at && boxes.value.find(x => x.pane !== d.pane && at.px >= x.left && at.px <= x.left + x.width && at.py >= x.top && at.py <= x.top + x.height)
  const side = b && at ? dropZone(b, at.px, at.py) : null
  // Edge that would change nothing (already in that place): no zone.
  const ok = b && side && entry.value && dropPreview(entry.value.layout, d.pane, b.pane, side)
  if ((ok ? b.pane : null) !== d.over || (ok ? side : null) !== d.side) {
    d.over = ok ? b.pane : null
    d.side = ok ? side : null
  }
}
function stopDrag() {
  drag.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragCancel)
  window.removeEventListener('keydown', onDragKey, true)
}
function onDragEnd(e: PointerEvent) {
  const d = drag.value
  if (!d || e.pointerId !== d.pointer) return
  const p = byId.value.get(d.pane)
  if (d.touch) planPress.suppressClick()
  stopDrag()
  // Finger lifted without moving since the long press on the header: menu.
  if (d.touch && pressHead && Math.hypot(d.x - d.x0, d.y - d.y0) <= 5) return paneMenu(d.pane)
  if (d.started && p && d.over && d.side) dropPane(p, d.over, d.side)
}
function onDragCancel(e: PointerEvent) {
  if (drag.value && e.pointerId === drag.value.pointer) {
    if (drag.value.touch) planPress.suppressClick()
    stopDrag()
  }
}
function onDragKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  stopDrag()
}
onUnmounted(() => {
  stopDrag()
  stopResize()
})
// Hovered cell and zone: the highlighted rectangle (half the cell for an edge).
const dropBox = computed(() => {
  const d = drag.value
  const b = d?.started && d.over && d.side ? boxes.value.find(x => x.pane === d.over) : null
  if (!b || !d?.side) return null
  const { left, top, width, height } = b
  const half = { left: { width: width / 2 }, right: { left: left + width / 2, width: width / 2 }, up: { height: height / 2 }, down: { top: top + height / 2, height: height / 2 }, center: {} }[d.side]
  return { side: d.side, label: t(ZONE_LABEL[d.side]), style: Object.fromEntries(Object.entries({ left, top, width, height, ...half }).map(([k, v]) => [k, `${v}%`])) }
})
const ghost = computed(() => {
  const d = drag.value
  const p = d?.started ? byId.value.get(d.pane) : null
  // With a finger: above the finger, which would hide the label.
  if (!p || !d) return null
  const x = Math.max(4, Math.min(d.touch ? d.x - 20 : d.x + 12, window.innerWidth - 250))
  const y = Math.max(4, d.touch ? d.y - 56 : d.y + 14)
  return { title: paneTitle(p), style: { transform: `translate(${x}px, ${y}px)` } }
})

// Computer: the handle of a cell's header.
function gripDown(pane: string, e: PointerEvent) {
  if (e.button !== 0 || !(e.target as Element | null)?.closest?.('.cell-grip')) return
  e.preventDefault()
  startDrag(pane, e, false)
}
// Phone: long press on a plan cell, then the finger moves it.
let pressEv: PointerEvent | null = null
let pressPane = ''
// Long press on the cell header, finger lifted without moving: pane menu.
let pressHead = false
function paneMenu(paneId: string) {
  const p = byId.value.get(paneId)
  if (!p) return
  haptic()
  openMenu(paneItems(p), paneTitle(p))
}
const planPress = longPress({
  onPress: () => {
    if (!pressEv) return
    if (!draggable.value) return pressHead ? paneMenu(pressPane) : undefined
    haptic()
    startDrag(pressPane, pressEv, true)
  },
})
function planDown(pane: string, e: PointerEvent) {
  pressEv = e
  pressPane = pane
  pressHead = !!(e.target as Element | null)?.closest?.('.plan-cell-head') && !skipsPress(e.target as Element | null)
  planPress.down(e)
}
function planMove(e: PointerEvent) {
  planPress.move(e)
}

// ---------- Divider ----------
// Dragged: live preview, a single call to Herdr on release.
let resizing: { d: Divider, pointer: number, ratio: number, el: HTMLElement } | null = null
const resizingPath = ref<string | null>(null)
function resizeDown(d: Divider, e: PointerEvent) {
  if (e.button !== 0 || !entry.value) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  resizing = { d, pointer: e.pointerId, ratio: d.ratio, el }
  resizingPath.value = d.path
  el.addEventListener('pointermove', resizeMove)
  el.addEventListener('pointerup', resizeUp)
  el.addEventListener('pointercancel', stopResize)
}
function resizeMove(e: PointerEvent) {
  const r = resizing
  const at = inArea(e.clientX, e.clientY)
  if (!r || e.pointerId !== r.pointer || !at || !entry.value) return
  r.ratio = ratioAt(entry.value.layout, r.d, r.d.direction === 'right' ? at.px : at.py)
  preview.value = resizePreview(entry.value.layout, r.d.path, r.ratio)
}
function resizeUp(e: PointerEvent) {
  const r = resizing
  if (!r || e.pointerId !== r.pointer) return
  stopResize()
  if (Math.abs(r.ratio - r.d.ratio) >= 0.005) resizeSplit(props.tabId, r.d.path, r.ratio)
}
function stopResize() {
  const r = resizing
  resizing = null
  resizingPath.value = null
  preview.value = null
  if (!r) return
  r.el.removeEventListener('pointermove', resizeMove)
  r.el.removeEventListener('pointerup', resizeUp)
  r.el.removeEventListener('pointercancel', stopResize)
}
// Keyboard: arrows on the divider (5 % per press).
function resizeKey(d: Divider, e: KeyboardEvent) {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
  if (!step || !entry.value || (d.direction === 'right') !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
  e.preventDefault()
  const ratio = ratioAt(entry.value.layout, d, d.start + d.size * (d.ratio + step * 0.05))
  if (ratio !== d.ratio) resizeSplit(props.tabId, d.path, ratio)
}
// On-screen keyboard: the whole view (tabs, header, split) fits the visible
// area above it, as AgentView does; the split shrinks to what is left, so the
// active cell's message field stays above the keyboard.
const viewStyle = computed(() => (kbOpen.value ? { height: `${vvHeight.value}px`, top: `${vvTop.value}px` } : {}))
const divStyle = (d: Divider) => (d.direction === 'right'
  ? { left: `${d.at}%`, top: `${d.from}%`, height: `${d.span}%` }
  : { top: `${d.at}%`, left: `${d.from}%`, width: `${d.span}%` })

function open(paneId: string) {
  if (planPress.swallowClick()) return
  haptic()
  navigateTo(panePath(paneId))
}
</script>

<template>
  <section id="tabview" class="view" :style="viewStyle">
    <SpaceTabs v-if="entry" :workspace="entry.tab.workspace" :current="tabId" />
    <HeaderMenu :items="tabMenu" :title="tabMenuTitle" :disabled="!entry">
      <header class="top bar tab-top">
        <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back tab-back" :aria-label="t('Back')" @click="backToOrigin" />
        <div class="tab-head">
          <div class="tab-title">
            <UIcon v-if="ws?.worktree" name="i-lucide-git-branch" class="tab-title-branch" />{{ ws?.label || '—' }}
          </div>
          <div class="tab-meta">
            <span class="tab-meta-tab">{{ t('Tab') }} {{ entry ? tabLabel(entry.tab.label, entry.tab.number) : '' }}</span>
            <span v-if="entry">{{ `${entry.panes.length} pane${entry.panes.length > 1 ? 's' : ''}` }}</span>
            <span v-if="entry?.layout.zoomed" class="tab-meta-zoom" :title="t('A pane is zoomed in Herdr')">zoom</span>
            <span v-if="machine" class="tab-meta-machine" :class="machine.status"><UIcon :name="machine.local ? 'i-lucide-server' : 'i-lucide-laptop'" /><span class="machine-inline-name">{{ machineName(machine.key) }}</span><MachineLocalBadge v-if="machine.local" /></span>
          </div>
        </div>
        <UButton
          v-if="headerAdd && entry" icon="i-lucide-plus" color="neutral" variant="ghost" size="lg" class="icon-btn"
          :aria-label="t('New tab')" :title="t('New tab')" :disabled="offlineView" @click="newTab(entry.tab.workspace)"
        />
        <SpaceMenu v-if="entry" :items="tabMenu" size="lg" :title="tabMenuTitle" :label="t('Tab options')" />
      </header>
    </HeaderMenu>

    <OfflineNote v-if="!desk && (netDown || offlineView)" :label="offlineView ? t('Last known state') : undefined" :at="cachedAt" />
    <div v-if="closed" class="chat-empty">
      <UIcon name="i-lucide-layout-panel-left" class="chat-empty-icon" />
      <p>{{ t('This tab is unavailable.') }}</p>
      <UButton color="neutral" variant="outline" @click="backToOrigin">{{ t('Back') }}</UButton>
    </div>
    <div v-else-if="!entry" class="chat-empty">{{ t('Loading…') }}</div>
    <div v-else-if="entry && desk" ref="area" class="split" :class="{ dragging: drag?.started, resizing: resizingPath != null }">
      <div
        v-for="b in boxes" :key="b.pane" class="split-box" :class="{ 'drag-src': drag?.started && drag.pane === b.pane }"
        :style="{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }"
        @pointerdown="gripDown(b.pane, $event)"
      >
        <AgentView cell :grip="draggable" :pane-id="b.pane" :active="b.pane === active" @activate="activate(b.pane)" />
      </div>
      <div v-if="dropBox" class="drop-zone" :class="dropBox.side" :style="dropBox.style"><span>{{ dropBox.label }}</span></div>
      <div
        v-for="d in divs" :key="d.path" class="divider" :class="[d.direction, { on: resizingPath === d.path }]" :style="divStyle(d)"
        role="separator" tabindex="0" :aria-orientation="d.direction === 'right' ? 'vertical' : 'horizontal'" :aria-label="t('Resize')"
        :aria-valuenow="Math.round(d.ratio * 100)" aria-valuemin="5" aria-valuemax="95"
        @pointerdown="resizeDown(d, $event)" @keydown="resizeKey(d, $event)"
      />
    </div>
    <div v-else-if="entry" class="plan-wrap">
      <div ref="area" class="plan" :class="{ dragging: drag?.started, resizing: resizingPath != null, movable: draggable }">
        <div
          v-for="b in boxes" :key="b.pane" class="plan-box" :class="{ 'drag-src': drag?.started && drag.pane === b.pane }"
          :style="{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }"
          @pointerdown="planDown(b.pane, $event)" @pointermove="planMove" @pointerup="planPress.cancel" @pointercancel="planPress.cancel"
        >
          <PlanCell :pane="byId.get(b.pane)!" :focused="entry.layout.focused === b.pane && boxes.length > 1" :fresh="asked === b.pane" @open="open(b.pane)" />
        </div>
        <div v-if="dropBox" class="drop-zone" :class="dropBox.side" :style="dropBox.style"><span>{{ dropBox.label }}</span></div>
        <div
          v-for="d in divs" :key="d.path" class="divider" :class="[d.direction, { on: resizingPath === d.path }]" :style="divStyle(d)"
          role="separator" :aria-orientation="d.direction === 'right' ? 'vertical' : 'horizontal'" :aria-label="t('Resize')"
          @pointerdown="resizeDown(d, $event)"
        />
      </div>
    </div>
    <Teleport to="body">
      <div v-if="ghost" class="drag-ghost" :style="ghost.style">{{ ghost.title }}</div>
    </Teleport>
  </section>
</template>
