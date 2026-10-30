<script setup lang="ts">
import type { Pane, Workspace } from '#shared/types'
import { phoneHeaderTitle } from '#shared/displayTitles'
import { leadPane } from '#shared/spaces'

const props = defineProps<{ pane: Pane, workspace?: Workspace | null }>()
const emit = defineEmits<{ overview: [] }>()
const open = ref(false)
const entry = computed(() => tabOf(props.pane.tab))
const panes = computed(() => entry.value?.panes || [props.pane])
const tabs = computed(() => spaceTabs(props.pane.workspace))
const title = computed(() => phoneHeaderTitle(props.pane, props.workspace, entry.value?.tab.label, panes.value.length))
const kind = computed(() => kindLabel(props.pane.agent))
const position = computed(() => `${panes.value.findIndex(p => p.id === props.pane.id) + 1}/${panes.value.length}`)
const host = computed(() => machineInfo(props.pane.machine))
const hostLabel = computed(() => machineName(props.pane.machine) || props.pane.machine || t('This machine'))
const disconnected = computed(() => host.value && host.value.status !== 'online')
const stateLabel = computed(() => disconnected.value
  ? (host.value?.status === 'connecting' ? t('Reconnecting…') : t('Offline')) : statusLabel(props.pane))
const tone = computed(() => disconnected.value ? 'blocked' : statusKey(props.pane))
const icons: Record<string, string> = {
  working: 'i-lucide-loader-circle', blocked: 'i-lucide-circle-alert', done: 'i-lucide-circle-check',
  idle: 'i-lucide-circle', inactive: 'i-lucide-circle-pause', unknown: 'i-lucide-circle-help', shell: 'i-lucide-square',
}
const label = computed(() => [
  tl('Switch pane or tab', 'Changer de panneau ou d’onglet'), title.value, kind.value, stateLabel.value,
  ...(panes.value.length > 1 ? [`${t('Pane')} ${position.value}`] : []), props.workspace?.label, hostLabel.value,
].filter(Boolean).join(', '))
const actions = computed(() => tabItems(props.pane.tab))
watch(() => props.pane.id, () => { open.value = false })

function visit(p: Pane) {
  open.value = false
  if (p.id !== props.pane.id) navigateTo(panePath(p.id))
}
function pickTab(id: string) {
  open.value = false
  if (id !== props.pane.tab) switchSpaceTab(id)
}
function run(item: MenuItem) {
  if (item.disabled) return
  open.value = false
  item.run?.()
}
function overview() { open.value = false; emit('overview') }
function tabStatus(e: typeof tabs.value[number]) {
  const lead = leadPane(e.panes)
  return lead ? statusLabel(lead) : t('Closed')
}
</script>

<template>
  <button type="button" class="phone-identity" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
    <UIcon :name="icons[tone] || icons.unknown!" mode="svg" class="phone-identity-state" :class="tone" aria-hidden="true" />
    <span class="phone-identity-kind" aria-hidden="true">{{ kind }}</span>
    <span class="phone-identity-title" aria-hidden="true">{{ title }}</span>
    <UIcon v-if="paneNotificationsMuted(pane)" name="i-lucide-bell-off" mode="svg" class="phone-identity-muted" aria-hidden="true" />
    <span v-if="panes.length > 1" class="phone-identity-position" aria-hidden="true">{{ position }}</span>
    <UIcon name="i-lucide-chevron-down" mode="svg" class="phone-identity-chevron" aria-hidden="true" />
  </button>
  <AppSheet v-model:open="open" :title="tl('Panes and tabs', 'Panneaux et onglets')">
    <div class="phone-identity-details">
      <dl class="phone-identity-summary">
        <dt>{{ t('Machine') }}</dt><dd>{{ hostLabel }}<span v-if="host"> · {{ host.status }}</span></dd>
        <dt>{{ t('Space') }}</dt><dd>{{ workspace?.label || pane.workspace }}</dd>
        <dt>{{ t('Tab') }}</dt><dd>{{ entry?.tab.label || entry?.tab.number || pane.tab }}</dd>
        <dt>{{ t('Pane') }}</dt><dd>{{ paneTitle(pane) }}<span v-if="panes.length > 1"> · {{ position }}</span></dd>
        <dt>{{ t('Agent') }}</dt><dd>{{ kind }} · {{ stateLabel }}</dd>
      </dl>
      <div class="menu">
        <template v-if="panes.length > 1">
          <p class="menu-group">{{ tl('Panes in this tab', 'Panneaux de cet onglet') }}</p>
          <button v-for="(p, i) in panes" :key="p.id" type="button" :aria-current="p.id === pane.id ? 'page' : undefined" @click="visit(p)">
            <UIcon :name="p.id === pane.id ? 'i-lucide-check' : 'i-lucide-panel-top'" class="menu-icon" />
            <span class="menu-text"><span>{{ paneTitle(p) }}</span><span class="menu-sub">{{ i + 1 }}/{{ panes.length }} · {{ kindLabel(p.agent) }} · {{ statusLabel(p) }}</span></span>
          </button>
          <button type="button" @click="overview"><UIcon name="i-lucide-panels-top-left" class="menu-icon" />{{ t('Tab overview') }}</button>
        </template>
        <p class="menu-group">{{ t('Tabs') }}</p>
        <button v-for="e in tabs" :key="e.tab.id" type="button" :aria-current="e.tab.id === pane.tab ? 'page' : undefined" @click="pickTab(e.tab.id)">
          <UIcon :name="e.tab.id === pane.tab ? 'i-lucide-check' : 'i-lucide-layers'" class="menu-icon" />
          <span class="menu-text"><span>{{ e.tab.label || e.tab.number }}</span><span class="menu-sub">{{ e.panes.length }} · {{ t('Panes') }} · {{ tabStatus(e) }}</span></span>
        </button>
        <div class="menu-sep" />
        <template v-for="(item, i) in actions" :key="i">
          <div v-if="item.kind === 'separator'" class="menu-sep" />
          <button v-else type="button" :class="{ danger: item.danger }" :disabled="item.disabled" @click="run(item)">
            <UIcon v-if="item.icon" :name="item.icon" class="menu-icon" />
            <span class="menu-text"><span>{{ item.label }}</span><span v-if="item.desc" class="menu-sub">{{ item.desc }}</span></span>
          </button>
        </template>
      </div>
    </div>
  </AppSheet>
</template>

<style scoped>
.phone-identity { grid-area: head; display: flex; align-items: center; gap: 6px; min-width: 0; width: 100%; height: 44px; padding: 0 3px; text-align: left; color: var(--text); border-radius: 4px; }
.phone-identity:active { background: var(--bg-2); }
.phone-identity:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.phone-identity-state { width: 13px; height: 13px; flex: none; color: var(--dim); }
.phone-identity-state.working { color: var(--working); }
.phone-identity-state.blocked { color: var(--blocked); }
.phone-identity-state.done { color: var(--done); }
.phone-identity-state.idle { color: var(--idle); }
.phone-identity-kind { flex: none; color: var(--text-2); font: 500 .6875rem/1.2 var(--mono); white-space: nowrap; }
.phone-identity-title { flex: 1; min-width: 0; font-size: .875rem; font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phone-identity-position { flex: none; font: 500 .625rem/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--muted); }
.phone-identity-chevron, .phone-identity-muted { width: 12px; height: 12px; flex: none; color: var(--muted); }
.phone-identity-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 12px; margin: 0 8px 10px; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); font-size: 13px; line-height: 1.4; }
.phone-identity-summary dt { color: var(--muted); }
.phone-identity-summary dd { margin: 0; overflow-wrap: anywhere; color: var(--text); }
.phone-identity-details .menu-text > span { overflow-wrap: anywhere; }
.phone-identity-details button[aria-current="page"] { color: var(--accent); }
@container phone-header (max-width: 22em) { .phone-identity { gap: 4px; } }
@container phone-header (max-width: 18em) { .phone-identity-position { display: none; } }
@container phone-header (max-width: 15em) { .phone-identity-chevron { display: none; } }
</style>
