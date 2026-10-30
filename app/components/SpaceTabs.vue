<script setup lang="ts">
// Tabs of a space, above the header when there are several.
// The "+" of a single tab is in its view's header. Mini-map for
// a tab with several panes, otherwise state dot of the most urgent pane.
// The open tab is remembered for the space. Long press (phone) or right
// click (computer) on a tab: its options (rename, new tab, close).
import { leadPane } from '#shared/spaces'
import { longPress } from '~/utils/longPress'

const props = defineProps<{ workspace: string, current: string, compact?: boolean }>()
const tabs = computed(() => spaceTabs(props.workspace).map((e) => {
  const lead = leadPane(e.panes)
  return {
    ...e,
    label: e.tab.label || String(e.tab.number),
    tone: lead && lead.agent ? statusKey(lead) : '',
    title: e.panes.map(p => paneTitle(p)).join(' · '),
  }
}))
watch(() => props.current, (id) => { if (id) noteTab(id) }, { immediate: true })

const menuTitle = (label: string) => `${t('Tab')} ${label}`
let pressed: { id: string, label: string } | null = null
const lp = longPress({
  onPress: () => {
    if (!pressed) return
    haptic()
    openMenu(tabItems(pressed.id), menuTitle(pressed.label))
  },
})
// Touch or narrow screen only: otherwise the floating context menu handles it.
function down(e: PointerEvent, id: string, label: string) {
  if (!sheetMenus.value) return
  pressed = { id, label }
  lp.down(e)
}
function pick(id: string) {
  if (lp.swallowClick() || id === props.current) return
  switchSpaceTab(id)
}
const currentLabel = computed(() => tabs.value.find(e => e.tab.id === props.current)?.label || t('Tabs'))
function openPicker() {
  openMenu([
    ...tabs.value.map(e => ({ label: e.label, icon: e.tab.id === props.current ? 'i-lucide-check' : 'i-lucide-layers', run: () => pick(e.tab.id) })),
    { kind: 'separator' },
    ...tabItems(props.current),
  ], t('Tabs'))
}
</script>

<template>
  <button v-if="compact" type="button" class="space-tab-picker" :aria-label="`${t('Tabs')}: ${currentLabel}`" aria-haspopup="dialog" @click="openPicker">
    <span>{{ currentLabel }}</span><UIcon name="i-lucide-chevron-down" />
  </button>
  <nav v-else-if="spaceTabControls(tabs.length).row" class="tab-chips space-tabs" :aria-label="t('Tabs')">
    <UContextMenu v-for="e in tabs" :key="e.tab.id" :disabled="sheetMenus" :items="sheetMenus ? [] : toDropdown(tabItems(e.tab.id))" :ui="{ content: 'hw-dropdown' }">
      <button
        type="button" class="tab-chip" :class="e.tone" :title="e.title" :data-tab="e.tab.id"
        :aria-current="e.tab.id === current ? 'page' : undefined"
        @pointerdown="down($event, e.tab.id, e.label)" @pointermove="lp.move" @pointerup="lp.cancel" @pointercancel="lp.cancel"
        @contextmenu="sheetMenus && $event.preventDefault()" @click="pick(e.tab.id)"
      >
        <TabMap v-if="e.panes.length > 1" :layout="e.layout" :panes="e.panes" />
        <i v-else class="tab-chip-dot" />
        <span class="tab-chip-label">{{ e.label }}</span>
      </button>
    </UContextMenu>
    <button type="button" class="tab-chip tab-add" :title="t('New tab')" :aria-label="t('New tab')" :disabled="offlineView" @click="newTab(workspace)">
      <UIcon name="i-lucide-plus" />
    </button>
  </nav>
</template>
