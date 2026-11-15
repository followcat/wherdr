<script setup lang="ts">
import type { Pane, Workspace } from '#shared/types'
import { leadPane } from '#shared/spaces'
import { parseOmpContext } from '#shared/ompStatus'

const props = defineProps<{ pane: Pane, workspace?: Workspace | null }>()
const emit = defineEmits<{ overview: [] }>()
const open = ref(false)
const entry = computed(() => tabOf(props.pane.tab))
const panes = computed(() => entry.value?.panes || [props.pane])
const tabs = computed(() => spaceTabs(props.pane.workspace))
const badge = computed(() => paneBadge(props.pane))
// Alfred's title is its name, never its session title (taken from its start message).
const title = computed(() => (badge.value?.coordinator || isAlfredPane(props.pane) ? paneCoordinatorName(props.pane) : props.pane.label || props.pane.name || paneOwnTitle(props.pane)))
const kind = computed(() => kindLabel(props.pane.agent))
// No " · omp" under a pane already titled "omp".
const context = computed(() => props.pane.agent === 'omp' ? parseOmpContext(props.pane.ompStatus?.meters) : null)
const showKind = computed(() => Boolean(props.pane.agent) && title.value.toLocaleLowerCase() !== kind.value.toLocaleLowerCase())
const position = computed(() => `${panes.value.findIndex(p => p.id === props.pane.id) + 1}/${panes.value.length}`)
const host = computed(() => machineInfo(props.pane.machine))
const hostLabel = computed(() => machineName(props.pane.machine) || props.pane.machine || t('This machine'))
const disconnected = computed(() => host.value && host.value.status !== 'online')
const stateLabel = computed(() => disconnected.value
  ? (host.value?.status === 'connecting' ? t('Reconnecting…') : t('Offline')) : statusLabel(props.pane))
const tone = computed(() => disconnected.value ? 'blocked' : statusKey(props.pane))
const label = computed(() => [
  tl('Panes and tabs', 'Panneaux et onglets'), badge.value?.text, title.value, showKind.value ? kind.value : null, stateLabel.value,
  context.value ? tl(`Context ${Math.round(context.value.pct)}%, about ${Math.round(context.value.estimated / 1000)}K tokens`, `Contexte ${Math.round(context.value.pct)} %, environ ${Math.round(context.value.estimated / 1000)}K tokens`) : null,
  ...(panes.value.length > 1 ? [`${t('Pane')} ${position.value}`] : []), props.workspace?.label, hostLabel.value,
].filter(Boolean).join(', '))
// Navigation lists only when there is somewhere to go; the actions are always
// there (a single pane can still be renamed or get a new tab).
const actions = computed<MenuItem[]>(() => [
  { kind: 'group', label: t('Current pane') },
  ...currentPaneItems(props.pane),
  { kind: 'group', label: t('Current tab') },
  ...currentTabItems(props.pane.tab, panes.value.length > 1
    ? { label: t('Tab overview'), icon: 'i-lucide-panels-top-left', desc: tl('All panes of this tab side by side', 'Tous les panneaux de cet onglet côte à côte'), run: () => emit('overview') }
    : undefined),
])
watch(() => props.pane.tab, id => noteTab(id), { immediate: true })
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
function tabStatus(e: typeof tabs.value[number]) {
  const lead = leadPane(e.panes)
  return lead ? statusLabel(lead) : t('Closed')
}
</script>

<template>
  <button type="button" class="phone-identity" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
    <span class="phone-identity-copy" aria-hidden="true">
      <span class="phone-identity-title"><AlfredEmblem v-if="isAlfredPane(pane)" class="head-emblem" /><ProjectBadge v-if="badge" class="head-badge" :text="badge.text" :color="badge.color" />{{ title }}</span>
      <span class="phone-identity-meta"><span v-if="stateLabel" class="pill" :class="tone"><i />{{ stateLabel }}</span><template v-if="showKind && !context"><span>·</span><span class="phone-identity-kind">{{ kind }}</span></template><template v-if="context"><span>·</span><OmpContext :pane="pane" variant="text" /></template></span>
    </span>
    <UIcon v-if="paneNotificationsMuted(pane)" name="i-lucide-bell-off" mode="svg" class="phone-identity-muted" aria-hidden="true" />
    <!-- Drawn like the header's .icon-btn (terminal button): the whole identity stays the one tap target.
         With several panes, the position (1/2) shares the chevron's box. -->
    <span class="phone-identity-toggle icon-btn" :class="{ on: open, 'has-position': panes.length > 1 }" aria-hidden="true"><span v-if="panes.length > 1" class="phone-identity-position">{{ position }}</span><UIcon name="i-lucide-chevron-down" mode="svg" class="phone-identity-chevron" /></span>
  </button>
  <AppSheet v-model:open="open" :title="tl('Panes and tabs', 'Panneaux et onglets')" hide-close>
    <div class="phone-identity-details">
      <p class="phone-identity-summary">{{ hostLabel }} · {{ workspace?.label || pane.workspace }}</p>
      <!-- A lone pane has no list to show it in: its full name and state stay readable here. -->
      <p v-if="panes.length <= 1" class="phone-identity-current">
        <span class="phone-identity-current-title">{{ title }}</span><span class="phone-identity-current-meta"><span v-if="stateLabel" class="pill" :class="tone"><i />{{ stateLabel }}</span><template v-if="showKind"> · {{ kind }}</template></span>
      </p>
      <div class="menu">
        <p v-if="panes.length > 1" class="menu-group">{{ tl('Panes in this tab', 'Panneaux de cet onglet') }}</p>
        <button v-for="(p, i) in panes.length > 1 ? panes : []" :key="p.id" type="button" :aria-current="p.id === pane.id ? 'page' : undefined" @click="visit(p)">
          <UIcon :name="p.id === pane.id ? 'i-lucide-check' : 'i-lucide-panel-top'" class="menu-icon" />
          <span class="menu-text"><span>{{ p.label || p.name || paneOwnTitle(p) }}</span><span class="menu-sub"><template v-if="statusLabel(p)"><span class="pill" :class="statusKey(p)"><i />{{ statusLabel(p) }}</span> · </template>{{ i + 1 }}/{{ panes.length }}</span></span>
        </button>
        <p v-if="tabs.length > 1" class="menu-group">{{ t('Tabs') }}</p>
        <button v-for="e in tabs.length > 1 ? tabs : []" :key="e.tab.id" type="button" :aria-current="e.tab.id === pane.tab ? 'page' : undefined" @click="pickTab(e.tab.id)">
          <UIcon :name="e.tab.id === pane.tab ? 'i-lucide-check' : 'i-lucide-layers'" class="menu-icon" />
          <span class="menu-text"><span>{{ e.tab.label || e.tab.number }}</span><span class="menu-sub"><template v-if="tabStatus(e)"><span class="pill" :class="leadPane(e.panes) ? statusKey(leadPane(e.panes)!) : 'inactive'"><i />{{ tabStatus(e) }}</span> · </template>{{ e.panes.length === 1 ? tl('1 pane', '1 panneau') : tl(`${e.panes.length} panes`, `${e.panes.length} panneaux`) }}</span></span>
        </button>
        <template v-for="(item, i) in actions" :key="i">
          <div v-if="item.kind === 'separator'" class="menu-sep" />
          <p v-else-if="item.kind === 'group'" class="menu-group">{{ item.label }}</p>
          <button v-else type="button" :class="{ danger: item.danger }" :disabled="item.disabled" @click="run(item)">
            <UIcon v-if="item.icon" :name="item.icon" class="menu-icon" />
            <span class="menu-text"><span>{{ item.label }}</span><span v-if="item.desc" class="menu-sub" :class="{ 'font-mono': item.mono }">{{ item.desc }}</span></span>
          </button>
        </template>
      </div>
    </div>
  </AppSheet>
</template>

<style scoped>
.phone-identity { grid-area: head; display: flex; align-items: center; gap: 6px; min-width: 0; width: 100%; height: 44px; padding: 0 0 0 3px; text-align: left; color: var(--text); border-radius: 0; }
.phone-identity:active { background: var(--bg-2); }
.phone-identity:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.phone-identity-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.head-badge { margin-right: var(--badge-gap); }
.head-emblem { display: inline-block; width: 16px; margin-right: var(--badge-gap); vertical-align: -1px; }
.phone-identity-title { font-size: 14px; font-weight: 700; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phone-identity-meta { display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; color: var(--muted); font: 500 11px/1.2 var(--mono); white-space: nowrap; }
/* omp's context percentage takes the kind's place (still in the panel and the label) and stays
   whole; short of room, the state is cut, never pushed under the chevron. */
.phone-identity-meta > .pill { flex: 0 1 auto; min-width: 0; overflow: hidden; }
.phone-identity-meta > * { flex: none; }
.phone-identity-meta .pill, .menu-sub .pill { font-size: 11px; }
.phone-identity-position { flex: none; font: 500 .625rem/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--muted); }
.phone-identity-muted { width: 12px; height: 12px; flex: none; color: var(--muted); }
.phone-identity-toggle { width: 44px; height: 44px; }
.phone-identity-toggle.has-position { width: auto; min-width: 44px; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 0 10px 0 9px; }
.phone-identity-chevron { width: 20px; height: 20px; flex: none; }
.phone-identity:active .phone-identity-toggle { background: var(--surface-3); }
@media (hover: hover) { .phone-identity:hover .phone-identity-toggle { background: var(--surface-2); color: var(--text); } }
.phone-identity-summary { margin: 0 8px 12px; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phone-identity-details .menu-text > span { overflow-wrap: anywhere; }
.phone-identity-current { display: flex; flex-direction: column; gap: 3px; margin: -4px 8px 12px; }
.phone-identity-current-title { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.phone-identity-current-meta { color: var(--text-3); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.phone-identity-current-meta .pill { font-size: 11px; }
.phone-identity-details button[aria-current="page"] { color: var(--accent); }
@container phone-header (max-width: 22em) { .phone-identity { gap: 4px; } }
@container phone-header (max-width: 18em) { .phone-identity-position { display: none; } }
</style>
