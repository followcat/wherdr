<script setup lang="ts">
// Agent list, grouped by state; sidebar on a computer. Top to bottom: header
// buttons, the machine bar (hidden with a single tab), counters, quotas, the
// coordinators, the tasks to handle, then every agent of the machines shown,
// grouped by state (no section per machine; with several machines each card
// names its machine).
// A machine's actions live in its bar tab's menu (right click, long press);
// without a bar, in the machine chips (several machines) or the header "…"
// (a single machine: only what Settings and New do not already offer).
// One row per agent terminal (individualAgentRows), as in v2.5; rows without
// a status (plain shells) list as Ready.
import type { MachineInfo, Pane } from '#shared/types'
import { type ReadySort, type Row, type RowGroup, createRowReuse, paneGroup, readyLists, rowGroup, sortReady, spaceRows, urgency } from '#shared/spaces'
import { claudeApiShown, machineQuotaRows, quotaBlocks, quotaRows, tabQuotaRows } from '~/utils/quotas'
import { longPress } from '~/utils/longPress'
import { LIST_DEFAULT, LIST_MAX, LIST_MIN, LIST_RAIL, clampListWidth, listWidthCss, readListCollapsed, readListWidth, saveListCollapsed, saveListWidth } from '~/utils/sideWidth'
import { headerFold } from '~/utils/headerFold'
import { quietPeriodEnd } from '~/utils/quietPeriodEnd'
import { onceEvery } from '~/utils/onceEvery'
import { listMode } from '~/utils/layoutMode'
import { stateMachines } from '~/utils/homeGrouping'
import { BAR_ALL, barMachineSelection } from '~/utils/machineBar'
import { type CountGroup, countsTotal, tabCounts } from '~/utils/projectTabs'
import { individualAgentRows, individualAgentTitle, isIndividualAgentRow } from '~/utils/homeAgentRows'
import { boardEntry } from '~/utils/boardEntry'
import { groupTaskAgents } from '~/utils/taskAgentRow'
import type { PmOverview } from '#shared/pm/project'
const emit = defineEmits<{ search: [] }>()
onMounted(loadUpdate)
const homeRoute = useRoute()
// On the home page there is no agent to show: the list opens there.
const atHome = () => homeRoute.path === '/' || homeRoute.path === ''
// On the phone the list stays mounted (v-show in app.vue) under an agent's
// page: its quota poller waits while it is hidden and reads once when it
// shows again.
const homeShown = computed(() => desk.value || atHome())

const everOpen = ref(false)
watch(eventsOpen, (v) => { if (v) everOpen.value = true })

// Hidden under a conversation on the phone, the list keeps the state it last
// showed instead of re-rendering on every push, and catches up when it shows.
let shownState = herdrState.value
const st = computed(() => (homeShown.value ? (shownState = herdrState.value) : shownState))
const agents = computed(() => st.value.panes)
// Mounted only while the list is shown: mounting again reads at once.
const HomePollers = defineComponent({
  name: 'HomePollers',
  setup() {
    useQuotaLoader()
    useTaskAgentsLoader()
    return () => null
  },
})
// Ended timed mutes are dropped from the notification exceptions.
useNotificationRekey()
// Counters follow the selected machine or group; unreachable machines stay out.
const baseOfPane = (p: Pane) => { const m = machineInfo(p.machine); return m ? m.baseKey ?? m.key : p.machine || '' }
// First load (WHR-329, useHomeLoad): skeletons until every section's first read
// is in, then the whole list in one paint; never back to skeletons after. A
// short load shows none (useDelayedFlag); herdr-core down shows its notice. A
// failed read, or one pending past the deadline, shows an error and Try again.
// The state kept on this device lacks those sections: shown alone only while
// the network is down, without opening the gate.
watchEffect(() => { if (!homeListReady.value && st.value.ok && !offlineView.value && homeSectionsLoaded()) homeListReady.value = true })
const homeLate = ref(false)
let homeDeadline: ReturnType<typeof setTimeout> | undefined
const armHomeDeadline = () => { clearTimeout(homeDeadline); homeLate.value = false; homeDeadline = setTimeout(() => { homeLate.value = true }, HOME_LOAD_DEADLINE) }
// Counted from when the sections can read: herdr-core in, the list shown (its pollers mounted).
watch([() => st.value.ok, homeShown], ([ok, shown]) => { if (ok && shown && !homeListReady.value) armHomeDeadline() }, { immediate: true })
onBeforeUnmount(() => clearTimeout(homeDeadline))
const listShown = computed(() => homeListReady.value || (offlineView.value && netDown.value))
const homeLoadError = computed(() => !listShown.value && st.value.ok && (homeLoadFailed() || homeLate.value))
function retryHomeLoad() {
  resetHomeLoad()
  armHomeDeadline()
  const p = homeFirstLoad
  if (p.alfred !== 'ok') loadAlfred()
  if (p.coordinators !== 'ok') loadCoordinators()
  if (p.agents !== 'ok') loadTaskAgents()
  if (p.quotas !== 'ok') reloadQuotas()
  homeRetryTick.value++
}
const homeSkeleton = useDelayedFlag(computed(() => !listShown.value && !homeLoadError.value && !(linkShown.value && !st.value.ok && !!st.value.error)))
const counts = computed(() => tabCounts(countedRows.value, countedCoordinators.value, machineBarSelection.value))

const conn = computed(() => {
  if (offlineView.value) return { ok: false, text: t('offline'), idle: false }
  if (!linkShown.value) return { ok: false, text: everOpen.value ? t('offline — reconnecting…') : t('connecting…'), idle: !everOpen.value }
  if (!st.value.ok) return { ok: false, text: t('herdr-core unavailable'), idle: false }
  return { ok: true, text: 'wherdr v3', idle: false }
})

// "Dashboard"-style counters: always all three, zeros dimmed. Rows without a
// status (plain shells) count and list as Ready, as in v2.5.
const stats = computed(() => ([
  ['blocked', counts.value.blocked, t('your turn')],
  ['working', counts.value.working, t('working')],
  ['done', counts.value.ready, t('ready')],
] as [string, number, string][]).map(([s, n, label]) => ({ s, n, label })))

// Herdr's order stays that of each repository list. The Ready group may
// show unread before read, and be sorted differently (readySort).
function groupsOf(list: Row[], rawGroup = rowGroup) {
  const group = (r: Row) => { const g = rawGroup(r); return g === 'unknown' ? 'ready' : g }
  return ([
    { key: 'blocked', title: t('Your turn'), list: list.filter(r => group(r) === 'blocked') },
    { key: 'working', title: t('Working'), list: list.filter(r => group(r) === 'working') },
    { key: 'ready', title: tl('Ready', 'Prêts'), list: list.filter(r => group(r) === 'ready') },
  ] as const).filter(g => g.list.length).map(g => ({ ...g, lists: g.key === 'ready' ? readyLists(g.list, autoReorderReady.value).map(l => sortReady(l, readySort.value, rowTitle)) : [g.list] }))
}
const rowTitle = (r: Row) => isIndividualAgentRow(r) ? paneTaskTitle(r.lead) || individualAgentTitle(r.lead) : homeTitle(r.lead, st.value.workspaces.find(w => w.id === r.lead.workspace))
// Same row object for a card whose row did not change: it does not re-render.
const reuseRows = createRowReuse()
// Coordinators (Alfred and each project's) have their own rows above the list.
const coordinatorAddresses = computed(() => new Set([alfred.value?.terminal, ...coordinators.value.map(c => c.terminal)].filter((a): a is string => !!a)))
const isCoordinatorPane = (p: Pane) => !!p.coreAddress && coordinatorAddresses.value.has(p.coreAddress)
const standaloneRows = (rows: Row[]) => reuseRows(individualAgentRows(rows, coordinatorAddresses.value))
// Sort menu of the Ready group; sorted other than in the default order, the
// list can no longer be reordered manually.
const READY_SORT_LABELS: Record<ReadySort, [string, string]> = {
  herdr: ['Default order', 'i-lucide-grip-vertical'], recent: ['Recent activity', 'i-lucide-clock'], name: ['Name', 'i-lucide-arrow-down-a-z'],
}
const readySortItems = computed(() => [[
  { type: 'label' as const, label: t('Sort ready') },
  ...(Object.keys(READY_SORT_LABELS) as ReadySort[]).map(s => ({
    label: t(READY_SORT_LABELS[s][0]), icon: READY_SORT_LABELS[s][1], type: 'checkbox' as const,
    checked: readySort.value === s, onUpdateChecked: () => { readySort.value = s },
  })),
]])
// Rows of a machine: the state groups of its agents and shells, in Herdr's order.
const topQuotas = computed(() => (showQuotas.value ? quotaRows(homeQuotas.value, hiddenAgents.value) : []))
// Claude on API billing (no quota): a label instead of gauges.
const topApi = computed(() => showQuotas.value && claudeApiShown(homeQuotas.value, null, hiddenAgents.value))
const machineApi = (key: string) => showQuotas.value && claudeApiShown(homeQuotas.value, key, hiddenAgents.value)

// ------------------------------------------------------------ machines
const STATE_LABEL: Record<MachineInfo['status'], string> = { online: 'online', connecting: 'reconnecting…', offline: 'offline' }
// The list merges the online machines the bar selects. The bar's selected base
// keys also cover named sessions; iterating them preserves the selected group order.
const stateShown = computed(() => stateMachines(machines.value.length ? machines.value : [soloMachine.value], machineBarSelection.value))
// Each online machine's own quotas (a Claude account specific to it). No chip
// for them: the New sheet picks the machine, Settings › Machines the rest.
// Offline or reconnecting machines keep their state, last known agent count
// and Reconnect on one line at the bottom.
const onlineMachines = computed(() => stateShown.value.online.map(m => ({
  m, name: machineName(m.key) || m.label || t('This machine'),
  quotas: showQuotas.value ? machineQuotaRows(homeQuotas.value, baseKeyOf(m), hiddenAgents.value) : [],
  api: machineApi(baseKeyOf(m)),
})))
const stateAway = computed(() => stateShown.value.away.map(m => ({
  m, name: machineName(m.key) || m.label || t('This machine'), state: t(STATE_LABEL[m.status]),
  known: agents.value.filter(p => (p.machine || '') === m.key && !isCoordinatorPane(p)).length,
})))
// A machine label on each card only when the list mixes several machines.
const mixed = computed(() => stateShown.value.online.length > 1)
const stateCards = computed(() => stateShown.value.online.flatMap(m =>
  standaloneRows(spaceRows(st.value, m.key)).map(row => ({ row, machine: mixed.value ? machineName(m.key) || m.label : undefined }))))
// Agents of the same task share one row, in the group of the most urgent one.
const stateEntries = computed(() => groupTaskAgents(stateCards.value, c => (isIndividualAgentRow(c.row) ? taskAgentOf(c.row.lead)?.task : undefined), c => urgency(c.row.lead)))
const stateCardByKey = computed(() => new Map(stateEntries.value.map(e => [e.lead.row.key, {
  machine: e.lead.machine,
  agents: e.agents.length > 1 ? e.agents.map(c => ({ pane: c.row.lead, machine: c.machine })) : undefined,
}])))
const stateGroups = computed(() => groupsOf(stateEntries.value.map(e => e.lead.row)))
// Machine bar: "All", then each machine (a named session counts as its machine),
// with its state and the number of agents the list counts.
// A tab counts what it lists (the same helper as the counters): the rows of
// the list, not the terminals, and its running coordinators.
const countGroup = (g: RowGroup): CountGroup => (g === 'unknown' ? 'ready' : g)
const countedRows = computed(() => standaloneRows(spaceRows(st.value)).filter(r => !paneStale(r.lead))
  .map(r => ({ base: baseOfPane(r.lead), group: countGroup(rowGroup(r)) })))
const countedCoordinators = computed(() => [
  ...(alfredPane.value && !paneStale(alfredPane.value) ? [{ tabMachines: null, group: countGroup(paneGroup(alfredPane.value)) }] : []),
  ...projectCoordinators.value.flatMap((c) => {
    const p = coordinatorPane(c)
    return p && !paneStale(p)
      ? [{ tabMachines: projectTabPlaces.value.get(c.project) ?? null, group: c.proposal ? 'blocked' as const : countGroup(paneGroup(p)) }]
      : []
  }),
])
const barEntries = computed(() => machineBarShown.value.map((id) => {
  const n = countsTotal(tabCounts(countedRows.value, countedCoordinators.value, barMachineSelection(id, machineGroups.value)))
  if (id === BAR_ALL) return { id, label: t('All'), status: null, title: undefined, n }
  const group = machineGroups.value.find(g => g.id === id)
  if (group) return { id, label: group.name, status: null, title: group.name, n }
  // A single machine Herdr's state does not list: the one shown in the session row.
  const listed = machines.value.filter(m => baseKeyOf(m) === id)
  const mine = listed.length ? listed : id === soloMachine.value.key ? [soloMachine.value] : []
  const status: MachineInfo['status'] = mine.some(m => m.status === 'online') ? 'online' : mine.some(m => m.status === 'connecting') ? 'connecting' : 'offline'
  const label = (listed.length ? machineName(listed[0]!.key) : mine[0]?.label) || id || t('This machine')
  return { id, label, status, title: `${label} · ${t(STATE_LABEL[status])}`, n }
}))
// The machine a bar item stands for (a named session counts as its machine):
// the base machine itself when Herdr lists it, else its first session.
function barMachine(id: string): MachineInfo | null {
  if (id === BAR_ALL || machineGroups.value.some(g => g.id === id)) return null
  const listed = machines.value.filter(m => baseKeyOf(m) === id)
  return listed.find(m => m.key === id) ?? listed[0] ?? (id === soloMachine.value.key ? soloMachine.value : null)
}
// Right click (computer) or long press (phone) on a bar item: a machine's
// actions (those of its "…" menu), a group's settings. "All" has none.
function barMenuItems(id: string): MenuItem[] {
  const group = machineGroups.value.find(g => g.id === id)
  if (group) {
    return [
      { label: tl('Group settings', 'Réglages du groupe'), icon: 'i-lucide-settings-2', run: () => navigateTo({ path: '/settings', query: { section: 'appearance', group: group.id } }) },
    ]
  }
  const m = barMachine(id)
  return m ? machineMenuItems(m) : []
}
let barPressed: { id: string, label: string } | null = null
const barLp = longPress({
  onPress: () => {
    const items = barPressed ? barMenuItems(barPressed.id) : []
    if (!barPressed || !items.length) return
    haptic()
    openMenu(items, barPressed.label)
  },
})
// Touch or narrow screen only: otherwise the floating context menu handles it.
function onBarDown(e: PointerEvent, id: string, label: string) {
  if (!sheetMenus.value) return
  barPressed = { id, label }
  barLp.down(e)
}
// A single tab, or "All" and the only machine (the same list): no bar.
const barShown = computed(() => {
  const tabs = barEntries.value.filter(b => b.id !== BAR_ALL)
  return tabs.length > 1 || (tabs.length === 1 && barEntries.value.length > 1 && (machineBaseKeys.value.length > 1 || !barMachine(tabs[0]!.id)))
})
// One online machine: its own quotas join the shared ones at the top.
const oneMachine = computed(() => (onlineMachines.value.length === 1 ? onlineMachines.value[0]! : null))
const listQuotas = computed(() => (oneMachine.value ? tabQuotaRows(topQuotas.value, oneMachine.value.quotas) : topQuotas.value))
const listApi = computed(() => topApi.value || Boolean(oneMachine.value?.api))
// Several online machines: their quotas grouped by account.
const machineQuotaBlocks = computed(() => quotaBlocks(onlineMachines.value.map(c => ({ key: c.m.key, name: c.name, quotas: c.quotas, api: c.api }))))
const homeRoot = ref<HTMLElement | null>(null)
const homeScroll = ref<HTMLElement | null>(null)
const swipeDirection = useHomeSwipe(homeRoot, () => barEntries.value.map(b => b.id), () => machineBarPick.value, id => pickBar(id))
function retireHomeContent(el: Element) {
  ;(el as HTMLElement).inert = true
  el.setAttribute('aria-hidden', 'true')
}
const switchMachineConversation = useMachineConversation()
function pickBar(id: string, event?: MouseEvent) {
  if (barLp.swallowClick()) return
  if (id === machineBarPick.value) homeScroll.value?.scrollTo({ top: 0 })
  haptic()
  pickMachineBar(id)
  switchMachineConversation()
  const button = event?.currentTarget as HTMLElement | null
  requestAnimationFrame(() => (button ?? Array.from(homeRoot.value?.querySelectorAll<HTMLElement>('.machine-bar-item') ?? []).find(b => b.dataset.barId === id))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))
}
// A mouse wheel scrolls the bar sideways when it overflows (narrow sidebar).
function onBarWheel(e: WheelEvent) {
  const bar = e.currentTarget as HTMLElement
  if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || bar.scrollWidth <= bar.clientWidth) return
  e.preventDefault()
  bar.scrollLeft += e.deltaY
}
const soloMachine = computed<MachineInfo>(() => machines.value[0] || {
  key: '', label: hostLabel.value || 'herdr', local: true, status: st.value.ok ? 'online' : 'offline',
  error: null, session: st.value.session || 'default',
})
const baseKeyOf = (m: MachineInfo) => m.baseKey ?? m.key
function machineMenuItems(m: MachineInfo): MenuItem[] {
  // Only what herdr-core can do from here; rename and forget live in Settings › Agents.
  const items: MenuItem[] = []
  if (m.status === 'online') {
    items.push({ label: tl('New agent here', 'Nouvel agent ici'), icon: 'i-lucide-plus', run: () => {
      haptic()
      newAgentMachine.value = m.key
      newAgentOpen.value = true
    } })
    items.push({ label: t('Keep awake'), desc: awakeLabel(awakeByMachine.value[baseKeyOf(m)]) || undefined, icon: 'i-lucide-sun', run: () => openAwake({ key: baseKeyOf(m), label: m.label }) })
  }
  else if (!m.local) {
    items.push({ label: t('Reconnect'), icon: 'i-lucide-plug', run: () => reconnect(m) })
  }
  items.push({
    label: tl('Machine settings', 'Réglages des machines'),
    desc: m.local ? undefined : tl('Rename, forget', 'Renommer, oublier'),
    icon: 'i-lucide-settings',
    run: () => navigateTo({ path: '/settings', query: { section: 'agents' } }),
  })
  // Claude quota set-up lives in Settings › Agents only.
  return items
}
async function reconnect(m: MachineInfo) {
  try { await api('/api/machine/connect', { key: baseKeyOf(m) }) }
  catch (err) { toast(t((err as Error).message)) }
}
// Quiet mode active: no line in the list, an entry in the header "…" menu when it
// shows and a mark in the collapsed rail. Both open the notification settings.
const quietLabel = computed(() => tl('Notifications silenced — open settings', 'Notifications en silence — ouvrir les réglages'))
const quietSettings = '/settings?section=notifications'
const quietHint = computed(() => {
  const cur = quietCurrent.value
  if (!cur) return ''
  const end = quietPeriodEnd(cur.quiet, quietNow.value)
  if (end.kind === 'manual') return tl('Notifications silenced', 'Notifications en silence')
  const time = fmtTime(end.at)
  if (end.kind === 'today') return tl(`Notifications silenced until ${time}`, `Notifications en silence jusqu’à ${time}`)
  if (end.kind === 'tomorrow') return tl(`Notifications silenced until tomorrow ${time}`, `Notifications en silence jusqu’à demain ${time}`)
  const day = new Date(end.at).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  return tl(`Notifications silenced until ${day} ${time}`, `Notifications en silence jusqu’au ${day} ${time}`)
})
// Read only while the list shows (not under a conversation on the phone), at
// most once a minute when the page comes back or the list shows again.
const quietRead = onceEvery(60000)
const readQuiet = () => { if (homeShown.value && document.visibilityState === 'visible' && quietRead.take()) refreshQuiet() }
const onQuietVisible = () => readQuiet()
watch(homeShown, readQuiet)
onMounted(() => { if (homeShown.value) { quietRead.mark(); refreshQuiet() } document.addEventListener('visibilitychange', onQuietVisible) })
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onQuietVisible))
// Header buttons: when the list is too narrow, Search, then the Board
// move into a "…" menu; Settings always stays a button.
const titleRow = ref<HTMLElement | null>(null)
const titleRowWidth = ref(0)
let titleRowObserver: ResizeObserver | null = null
onMounted(() => {
  titleRowObserver = new ResizeObserver(([e]) => { titleRowWidth.value = e?.contentRect.width ?? 0 })
  if (titleRow.value) titleRowObserver.observe(titleRow.value)
})
onBeforeUnmount(() => titleRowObserver?.disconnect())
// First to fold first.
const headerFoldable = ['search', 'board']
const headerFolded = computed(() => {
  if (!titleRowWidth.value) return new Set<string>()
  const total = headerFoldable.length + 1 + (desk.value ? 1 : 0)
  return new Set(headerFoldable.slice(0, headerFold(titleRowWidth.value, total, headerFoldable.length)))
})
function headerMenuItems(): MenuItem[] {
  const f = headerFolded.value
  return [
    ...(f.has('search') ? [{ label: tl('Search'), icon: 'i-lucide-search', kbds: desk.value ? shortcutKbds('search-all') : undefined, run: openSearch }] : []),
    ...(quietCurrent.value ? [{ label: quietLabel.value, icon: 'i-lucide-bell-off', run: () => navigateTo(quietSettings) }] : []),
    ...(f.has('board') ? [{ label: tl('Board', 'Tableau'), icon: 'i-lucide-square-kanban', run: openBoard }] : []),
  ]
}
// Board: read whether project management is on and has a project at click time
// (it changes in Settings), and open the board or Settings › Projects.
async function openBoard() {
  const o = await api<PmOverview>('/api/pm/overview').catch(() => null)
  await navigateTo(boardEntry(o))
}
function newAgent() {
  haptic()
  newAgentOpen.value = true
}
function openSearch() { emit('search') }

// Sidebar width (computer): handle on its right edge
// (drag, keyboard arrows; double-click = default width), clamped,
// kept on the device. It sets --side, which the right-hand views follow.
// Collapsed, the list leaves a narrow column: show it, search, launch
// an agent and the state counters.
const listWidth = ref<number | null>(null)
const listDrag = ref(false)
const listCollapsed = ref(false)
// Tablet in portrait (slim): the list stays a narrow column; opened, it
// slides over the agent (drawer) and closes once a choice is made.
const drawerOpen = listDrawer
const mode = computed(() => listMode({ desk: desk.value, slim: slim.value, collapsed: listCollapsed.value, drawerOpen: drawerOpen.value }))
const rail = computed(() => mode.value === 'rail')
const drawer = computed(() => mode.value === 'drawer')
watch(() => homeRoute.fullPath, () => { drawerOpen.value = slim.value && atHome() }, { immediate: true })
watch(slim, (v) => { drawerOpen.value = v && atHome() })
function onDrawerKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && drawer.value) { e.preventDefault(); setListCollapsed(true) }
}
// The agent already open: no route change, close on the tap itself.
function onDrawerPick(e: MouseEvent) {
  if (drawer.value && (e.target as Element | null)?.closest('.card')) drawerOpen.value = false
}
onMounted(() => {
  listWidth.value = readListWidth()
  listCollapsed.value = readListCollapsed()
  window.addEventListener('keydown', onDrawerKey)
})
onUnmounted(() => window.removeEventListener('keydown', onDrawerKey))
watch([listWidth, rail, slim], ([w, r, narrow]) => {
  const root = document.documentElement.style
  if (r || narrow) root.setProperty('--side', `${LIST_RAIL}px`)
  else if (w === null) root.removeProperty('--side')
  else root.setProperty('--side', listWidthCss(w))
}, { immediate: import.meta.client })
// The original button disappears with its column: the focus goes to the opposite one.
function setListCollapsed(collapsed: boolean) {
  if (slim.value) drawerOpen.value = !collapsed
  else {
    listCollapsed.value = collapsed
    saveListCollapsed(collapsed)
  }
  nextTick(() => document.querySelector<HTMLElement>(`#home ${collapsed ? '.home-rail' : '.home-top'} .rail-toggle`)?.focus())
}
function listNow() { return document.getElementById('home')?.getBoundingClientRect().width || LIST_DEFAULT }
function onListGrab(e: PointerEvent) {
  if (e.button !== 0) return
  const handle = e.currentTarget as HTMLElement
  e.preventDefault()
  const x0 = e.clientX
  const w0 = listNow()
  handle.setPointerCapture(e.pointerId)
  listDrag.value = true
  const move = (ev: PointerEvent) => { listWidth.value = clampListWidth(w0 + ev.clientX - x0, window.innerWidth) }
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    listDrag.value = false
    saveListWidth(listWidth.value)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}
function onListKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16
  const d = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
  if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); return resetListWidth() }
  if (!d) return
  e.preventDefault()
  listWidth.value = clampListWidth(listNow() + d, window.innerWidth)
  saveListWidth(listWidth.value)
}
function resetListWidth() {
  listWidth.value = null
  saveListWidth(null)
}
</script>

<template>
  <section ref="homeRoot" id="home" data-wherdr="home-list" class="view" :class="{ resizing: listDrag, rail, drawer, 'list-compact': compactList }" @click.capture="onDrawerPick">
    <HomePollers v-if="homeShown" />
    <!-- Collapsed list (computer): narrow column, the rest of the list is hidden. -->
    <nav v-if="rail" class="home-rail" :aria-label="t('Agents')">
      <AppLogo class="home-logo" :class="conn.idle ? '' : conn.ok ? 'ok' : 'bad'" :title="conn.text" />
      <UTooltip :text="t('Show list')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-panel-left-open" color="neutral" variant="ghost" size="lg" class="icon-btn rail-toggle" :aria-label="t('Show list')" aria-expanded="false" aria-controls="home" @click="setListCollapsed(false)" />
      </UTooltip>
      <UTooltip :text="tl('Search agents and conversations', 'Rechercher agents et conversations')" :kbds="shortcutKbds('search-all')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')" @click="openSearch" />
      </UTooltip>
      <UTooltip :text="t('New')" :kbds="shortcutKbds('new-space')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('New')" :disabled="!linkShown || offlineView" @click="newAgent" />
      </UTooltip>
      <UTooltip :text="tl('Board', 'Tableau')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-square-kanban" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Board', 'Tableau')" @click="openBoard" />
      </UTooltip>
      <UTooltip :text="t('Settings')" :kbds="shortcutKbds('settings')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Settings')" to="/settings" />
      </UTooltip>
      <ul v-if="agents.length" class="rail-stats">
        <li v-for="c in stats" :key="c.s" class="rail-stat" :class="[c.s, { zero: !c.n }]" :title="`${c.n} ${c.label}`">
          <i aria-hidden="true" /><b>{{ c.n }}</b><span class="sr-only">{{ c.label }}</span>
        </li>
      </ul>
      <!-- Quiet mode: a small state mark under the counters, not a button among the
           rail's actions, so the rail keeps its shape. -->
      <UTooltip v-if="quietHint" :text="quietHint" :content="{ side: 'right' }">
        <NuxtLink :to="quietSettings" class="rail-quiet" :aria-label="quietLabel"><UIcon name="i-lucide-bell-off" /></NuxtLink>
      </UTooltip>
    </nav>
    <header class="home-top">
      <div ref="titleRow" class="home-title-row">
        <p class="eyebrow">
          <AppLogo class="home-logo" :class="conn.idle ? '' : conn.ok ? 'ok' : 'bad'" />
          <NuxtLink v-if="conn.ok" to="/settings?section=about" class="home-version" :title="t('About')">{{ conn.text }}</NuxtLink>
          <span v-else>{{ conn.text }}</span>
        </p>
        <h1 class="sr-only">{{ t('Agents') }}</h1>
        <div class="home-actions">
          <UTooltip v-if="!headerFolded.has('search')" :text="tl('Search agents and conversations', 'Rechercher agents et conversations')" :kbds="shortcutKbds('search-all')" :disabled="!desk">
            <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')" @click="openSearch" />
          </UTooltip>
          <UTooltip v-if="!headerFolded.has('board')" :text="tl('Board', 'Tableau')" :disabled="!desk">
            <UButton icon="i-lucide-square-kanban" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Board', 'Tableau')" data-testid="home-board" @click="openBoard" />
          </UTooltip>
          <UTooltip :text="t('Settings')" :kbds="shortcutKbds('settings')" :disabled="!desk">
            <UButton
              icon="i-lucide-settings-2" color="neutral" variant="ghost" size="lg" class="icon-btn"
              :aria-label="t('Settings')" to="/settings"
            />
          </UTooltip>
          <SpaceMenu v-if="headerFolded.size" :items="headerMenuItems" size="lg" :label="t('Options')" />
          <UTooltip v-if="desk" :text="t('Collapse list')">
            <UButton icon="i-lucide-panel-left-close" color="neutral" variant="ghost" size="lg" class="icon-btn rail-toggle" :aria-label="t('Collapse list')" aria-expanded="true" aria-controls="home" @click="setListCollapsed(true)" />
          </UTooltip>
        </div>
      </div>
    </header>

    <nav v-if="barShown" class="machine-bar" :aria-label="tl('Machines shown', 'Machines affichées')" @wheel="onBarWheel">
      <UContextMenu
        v-for="b in barEntries" :key="b.id" :disabled="sheetMenus || b.id === BAR_ALL"
        :items="sheetMenus || b.id === BAR_ALL ? [] : toDropdown(barMenuItems(b.id))" :ui="{ content: 'hw-dropdown' }"
      >
        <button
          type="button" class="machine-bar-item" :class="[b.status, { on: b.id === machineBarPick }]" :data-bar-id="b.id"
          :aria-pressed="b.id === machineBarPick" :title="b.title"
          @pointerdown="onBarDown($event, b.id, b.label)" @pointermove="barLp.move" @pointerup="barLp.cancel" @pointercancel="barLp.cancel"
          @contextmenu="sheetMenus && $event.preventDefault()" @click="pickBar(b.id, $event)"
        >
          <UIcon v-if="machineGroups.some(g => g.id === b.id)" name="i-lucide-group" class="machine-bar-group" aria-hidden="true" />
          <i v-if="b.status" class="machine-bar-state" aria-hidden="true" />
          <span class="machine-bar-label">{{ b.label }}</span>
          <b class="machine-bar-count">{{ b.n }}</b>
        </button>
      </UContextMenu>
      <span class="machine-bar-indicator" aria-hidden="true" />
    </nav>
    <div class="home-content">
    <Transition :name="swipeDirection < 0 ? 'home-next' : 'home-prev'" @before-leave="retireHomeContent">
    <div :key="machineBarPick ?? BAR_ALL" ref="homeScroll" class="scroll">
      <OfflineNote v-if="(offlineView && cachedAt) || netDown" class="home-offline" :label="offlineView && cachedAt ? t('Last known state') : undefined" :at="cachedAt" date-style="medium" />
      <div v-if="linkShown && !st.ok" class="notice">
        {{ t('herdr-core is not responding') }}{{ st.error ? tl(`: ${t(st.error)}`, ` : ${t(st.error)}`) : '' }}.<br>
        {{ t('Run hc server start for the configured core session.') }}
      </div>
      <div v-if="showCounters && agents.length" class="stats">
        <div v-for="c in stats" :key="c.s" class="stat" :class="[c.s, { zero: !c.n }]">
          <b v-if="listShown">{{ c.n }}</b><b v-else class="skel stat-skel" />
          <span><i />{{ c.label }}</span>
        </div>
      </div>
      <template v-if="listShown">
      <QuotaStrip :rows="listQuotas" :api="listApi" :class="{ 'after-stats': showCounters && agents.length }" />
      <MachineQuotaBlocks v-if="!oneMachine" :blocks="machineQuotaBlocks" />
      </template>

      <SettingsSkeleton v-if="homeLoadError" error="Part of the list did not load." @retry="retryHomeLoad" />
      <HomeSkeleton v-else-if="homeSkeleton" />
      <!-- Mounted while hidden: each section reads its data, shown once all have. -->
      <div v-show="listShown && !homeSkeleton" data-testid="home-sections">
      <!-- Reviews first: right under Alfred, above a long Coordinators section. -->
      <AlfredRow v-if="st.ok" />
      <ReviewCard v-if="st.ok" />
      <CoordinatorsSection v-if="st.ok" />

      <OpenNetworkBanner />
      <UpdateBanner v-if="updateBanner" :info="updateBanner" dismissible />

      <p v-if="machineBarSelection?.length === 0" class="machine-empty">{{ tl('No machines in this group.', 'Aucune machine dans ce groupe.') }}</p>
      <section v-for="g in stateGroups" :key="g.key" class="agent-group state-group" :class="g.key">
        <h2 class="group-title"><span>{{ g.title }}</span><span class="count">{{ g.list.length }}</span>
          <UDropdownMenu v-if="g.key === 'ready'" :items="readySortItems" :content="{ align: 'end' }" :ui="{ content: 'hw-dropdown' }">
            <UButton :icon="READY_SORT_LABELS[readySort][1]" color="neutral" variant="ghost" size="xs" class="group-sort" :aria-label="`${t('Sort ready')} : ${t(READY_SORT_LABELS[readySort][0])}`" />
          </UDropdownMenu>
        </h2>
        <template v-for="(cards, i) in g.lists" :key="i">
          <p v-if="g.key === 'ready' && g.lists.length > 1" class="ready-subgroup-label">{{ t(i === 0 ? 'Unread' : 'Read') }}</p>
          <div class="card-list">
            <AgentCard v-for="r in cards" :key="r.key" :pane="r.lead" :row="r" :machine-badge="stateCardByKey.get(r.key)?.machine" :agents="stateCardByKey.get(r.key)?.agents" />
          </div>
        </template>
      </section>
      <div v-if="st.ok && !agents.length" class="empty hw-grid">
        <div class="empty-box">
          <div class="empty-art">&gt;_</div>
          <p>{{ t('No agents yet.') }}</p>
          <p class="muted">{{ tl('Start one here, or with', 'Lance-en un ici, ou avec') }} <code>hc</code> {{ t('in a terminal.') }}</p>
        </div>
      </div>
      <p v-else-if="onlineMachines.length && !stateGroups.length" class="machine-empty state-empty">{{ t('No agents yet.') }}</p>
      <!-- No agent row (Alfred and coordinators have their own): the first project's setup, while there is none. -->
      <HomeSetupHint v-if="st.ok && !stateGroups.length" />
      </div>
      <div v-if="stateAway.length" class="state-away" role="group" :aria-label="tl('Machines not connected', 'Machines non connectées')">
        <div v-for="a in stateAway" :key="a.m.key" class="state-away-item" :class="a.m.status" :data-machine="a.m.key || 'local'"
          :title="[`${a.name} · ${a.state}`, a.known ? tl(`${a.known} known agents`, `${a.known} agents connus`) : '', a.m.error ? t(a.m.error) : ''].filter(Boolean).join(' — ')"
        >
          <i class="state-machine-dot" aria-hidden="true" />
          <span class="state-machine-name">{{ a.name }}</span>
          <span class="state-away-state">{{ a.state }}</span>
          <b v-if="a.known" class="state-away-known">{{ a.known }}</b>
          <button v-if="!a.m.local" type="button" class="state-away-reconnect" :aria-label="`${t('Reconnect')} : ${a.name}`" @click="reconnect(a.m)">{{ t('Reconnect') }}</button>
        </div>
      </div>
    </div>
    </Transition>
    </div>

    <div class="fab-wrap">
      <UButton class="fab hw-cta" icon="i-lucide-plus" color="primary" variant="solid" size="xl" :disabled="!linkShown || offlineView" @click="newAgent">
        {{ t('New') }}
      </UButton>
    </div>
    <Teleport to="body">
      <div
        v-if="desk && !rail && !slim" class="list-handle" :class="{ dragging: listDrag }" role="separator" aria-orientation="vertical" tabindex="0"
        :aria-label="t('List width')" :aria-valuenow="listWidth ?? LIST_DEFAULT" :aria-valuemin="LIST_MIN" :aria-valuemax="LIST_MAX"
        :title="t('Drag to resize · double-click: default width')"
        @pointerdown="onListGrab" @dblclick="resetListWidth" @keydown="onListKey"
      />
    </Teleport>
  </section>
</template>
