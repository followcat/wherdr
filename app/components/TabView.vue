<script setup lang="ts">
const backToOrigin = useViewBack()
// Tab of a Herdr workspace, in its real proportions. Phone: plan of
// summary cards; tapping a cell opens the pane full screen (mini-map and
// swipe to the neighbours). Computer: the panes side by side, every cell live
// (conversation or terminal); the active cell (click) gets the keyboard. A
// terminal shown in a cell fits its pane to the cell, and each pane gets its
// size back when the tab is left (server/utils/paneSizes.ts). Herdr's focus and
// zoom are never changed: wherdr's active cell is not Herdr's focus. herdr-core
// keeps the layout in herdr-app's document: wherdr never changes it; a tab drawn
// from wherdr's own split tree gets dividers to drag (computer only).
import { neighborPane, paneBoxes } from '#shared/layout'
import { setRatio, treeDividers, treeLayout } from '#shared/splitTree'
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
// A divider being dragged: the cells follow it, the tree is written on release.
const preview = ref<{ path: string, ratio: number } | null>(null)
const layout = computed(() => {
  const e = entry.value
  if (!e?.tree || !preview.value) return e?.layout || null
  const paneOf = new Map(e.panes.map(p => [p.coreAddress, p.id]))
  return treeLayout(e.tab, setRatio(e.tree, preview.value.path, preview.value.ratio), leaf => paneOf.get(leaf)!)
})
const dividers = computed(() => (entry.value?.tree && !offlineView.value && layout.value ? treeDividers(layout.value) : []))
const onPreview = (path: string, ratio: number | null) => { preview.value = ratio == null ? null : { path, ratio } }
const boxes = computed(() => (layout.value ? paneBoxes(layout.value).filter(b => byId.value.has(b.pane)) : []))
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

// Phone: long press on a plan cell header, finger lifted without moving: pane menu.
let pressPane = ''
let pressHead = false
function paneMenu(paneId: string) {
  const p = byId.value.get(paneId)
  if (!p) return
  haptic()
  openMenu(paneItems(p), paneTitle(p))
}
const planPress = longPress({
  onPress: () => { if (pressHead) paneMenu(pressPane) },
})
function planDown(pane: string, e: PointerEvent) {
  pressPane = pane
  pressHead = !!(e.target as Element | null)?.closest?.('.plan-cell-head') && !skipsPress(e.target as Element | null)
  planPress.down(e)
}
function planMove(e: PointerEvent) {
  planPress.move(e)
}

// On-screen keyboard: the whole view (tabs, header, split) fits the visible
// area above it, as AgentView does; the split shrinks to what is left, so the
// active cell's message field stays above the keyboard.
const viewStyle = computed(() => (kbOpen.value ? { height: `${vvHeight.value}px`, top: `${vvTop.value}px` } : {}))

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
    <div v-else-if="entry && desk" class="split" :class="{ resizing: preview }">
      <div
        v-for="b in boxes" :key="b.pane" class="split-box"
        :style="{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }"
      >
        <AgentView cell :pane-id="b.pane" :active="b.pane === active" @activate="activate(b.pane)" />
      </div>
      <SplitDividers :dividers="dividers" @preview="onPreview" @resize="(path, ratio) => resizeSplit(tabId, path, ratio)" />
    </div>
    <div v-else-if="entry" class="plan-wrap">
      <div class="plan">
        <div
          v-for="b in boxes" :key="b.pane" class="plan-box"
          :style="{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }"
          @pointerdown="planDown(b.pane, $event)" @pointermove="planMove" @pointerup="planPress.cancel" @pointercancel="planPress.cancel"
        >
          <PlanCell :pane="byId.get(b.pane)!" :focused="entry.layout.focused === b.pane && boxes.length > 1" :fresh="asked === b.pane" @open="open(b.pane)" />
        </div>
      </div>
    </div>
  </section>
</template>
