<script lang="ts">
import { choicesArmed, createListShown } from '~/utils/compactCard'

// A card mounted once the list is on screen (an agent that starts waiting moves
// to another group) opens its answers with the transition; the first render
// does not, each time the list comes back on screen.
const list = createListShown()
</script>

<script setup lang="ts">
// Dense home row: avatar, title and state. Normal mode adds one activity
// line; a waiting agent keeps its one-tap answers.
// Space with several tabs or panes (`row`): a single card, named after the space,
// with its mini-map, the number of tabs / panes, and the state, preview and
// answers of its most urgent pane (`pane`). Tapping it opens the space.
import type { Pane } from '#shared/types'
import type { Row } from '#shared/spaces'
import { tabStates } from '#shared/spaces'
import { homeTitle } from '#shared/displayTitles'
import type { MenuItem } from '~/composables/useUi'
import { longPress } from '~/utils/longPress'
import { chatHoverIntent } from '~/utils/chatIntent'
import { interactionWindowFor } from '~/utils/interactionWindow'
import { individualAgentTitle, isIndividualAgentRow } from '~/utils/homeAgentRows'

// `machineBadge`: the machine's name on a card of the State grouping.
const props = defineProps<{ pane: Pane, row?: Row | null, machineBadge?: string }>()
const space = computed(() => (props.row && props.row.kind === 'space' ? props.row : null))
// Pane whose state the card shows.
const statePane = computed(() => props.pane)
const cardStatus = computed(() => statusKey(statePane.value))
// Compact list: one line (avatar, title, tab dots or pane count, state dot);
// while the agent waits for an answer, its question and one-tap answers open below.
const compact = computed(() => compactMeta({ tabs: space.value?.tabs.length, panes: space.value?.panes.length }))
const compactDots = computed(() => (compact.value.dots && space.value ? tabStates(space.value) : []))
const stateTitle = computed(() => [statusLabel(statePane.value), counts.value].filter(Boolean).join(' · '))
const busy = ref(false)
const card = ref<HTMLElement | null>(null)
let pointerType = ''
let touchMenuOpenedAt = 0

const ws = computed(() => herdrState.value.workspaces.find(w => w.id === props.pane.workspace))
const branch = computed(() => ws.value?.branch || null)
const title = computed(() => isIndividualAgentRow(props.row) ? individualAgentTitle(props.pane) : homeTitle(props.pane, ws.value))
// Normal mode: the current activity on a second line, unless the answers show below.
const activityLine = computed(() => !compactList.value && !more.value ? preview.value || '' : '')
const subtitle = computed(() => conversationSubtitle(props.pane, ws.value))
// Selection (computer): the pane being viewed, or for a space one of its panes / tabs.
const route = useRoute()
const selected = computed(() => {
  if (!space.value) return props.pane.id === curPane.value
  const tab = route.path.startsWith('/t/') ? String(route.params.tab || '') : null
  return space.value.panes.some(p => p.id === curPane.value || p.tab === tab)
})
const counts = computed(() => {
  const s = space.value
  if (!s) return ''
  const tabs = s.tabs.length > 1 ? tl(`${s.tabs.length} tabs`, `${s.tabs.length} onglets`) : ''
  return [tabs, tl(`${s.panes.length} panes`, `${s.panes.length} panes`)].filter(Boolean).join(' · ')
})
const where = computed(() => {
  const p = props.pane
  // Space: the pane the state and preview come from (and its tab if there are several).
  if (space.value) {
    const s = space.value
    return [s.tabs.length > 1 ? `${t('Tab')} ${s.leadTab.tab.label || s.leadTab.tab.number}` : '', subtitle.value].filter(Boolean).join(' · ')
  }
  return [subtitle.value, branch.value || shortPath(p.cwd)].filter(Boolean).join(' · ')
})
const prompt = computed(() => (props.pane.status === 'blocked' ? props.pane.prompt : undefined))
const quick = computed(() => quickChoices(prompt.value, 4))
const interactive = computed(() => props.pane.interaction === 'terminal' && props.pane.status === 'blocked' && !prompt.value && !props.pane.menu && !props.pane.screen)
// Recognized waiting screen (Codex hooks…): its title says better what is expected.
const screen = computed(() => knownScreen(props.pane))
const preview = computed(() => props.pane.usageLimit ? tl('Provider quota reached', 'Quota fournisseur atteint') : interactive.value ? tl('Interactive agent screen', 'Écran interactif de l’agent') : (screen.value && screenSummary(screen.value)) || (props.pane.menu && props.pane.status !== 'working' && menuSummary(props.pane.menu)) || (prompt.value ? prompt.value.kind === 'self-update' ? t(prompt.value.question || '') : prompt.value.question : props.pane.preview))
const more = computed(() => compactOpen({ status: props.pane.status, preview: preview.value, detail: prompt.value?.detail, choices: quick.value.length }))
// Read / unread: only for an agent that has finished (ready).
const unread = computed(() => (space.value ? space.value.panes.filter(p => p.agent && p.status === 'done') : []))
const readItem = computed(() => {
  if (space.value) return unread.value.length ? { label: t('Mark as read'), icon: 'i-lucide-mail-open', run: () => readAll() } : null
  const p = props.pane
  if (!p.agent || (p.status !== 'done' && p.status !== 'idle')) return null
  return p.status === 'done'
    ? { label: t('Mark as read'), icon: 'i-lucide-mail-open', run: () => setRead(true) }
    : { label: t('Mark as unread'), icon: 'i-lucide-mail', run: () => setRead(false) }
})
async function readAll() {
  try {
    await Promise.all(unread.value.map(p => api('/api/seen', { pane_id: p.id, read: true })))
    haptic()
  } catch (err) { toast((err as Error).message, true) }
}
async function setRead(read: boolean) {
  try {
    await api('/api/seen', { pane_id: props.pane.id, read })
    haptic()
    // Unread while it is open alongside (computer): we close it,
    // otherwise it would immediately go back to "read".
    if (!read && curPane.value === props.pane.id) navigateTo('/')
  } catch (err) { toast((err as Error).message, true) }
}
useNotificationClock()
const menuItems = computed<MenuItem[]>(() => space.value ? [
  notificationMenuItem(props.pane, true),
  ...(readItem.value ? [readItem.value, { kind: 'separator' as const }] : []),
  ...workspaceItems(space.value.workspace.id),
] : [
  notificationMenuItem(props.pane, true),
  ...(readItem.value ? [readItem.value, { kind: 'separator' as const }] : []),
  ...paneWorkspaceItems(props.pane),
  { kind: 'separator' },
  copyPaneIdItem(props.pane),
  { kind: 'separator' },
  {
    label: props.pane.agent
      ? tl(`Close this pane (stops ${kindLabel(props.pane.agent)})`, `Fermer ce pane (arrête ${kindLabel(props.pane.agent)})`)
      : t('Close this terminal'),
    icon: 'i-lucide-trash-2', danger: true, run: () => closePane(props.pane),
  },
])
const contextItems = computed(() => (sheetMenus.value ? [] : toDropdown(menuItems.value)))

// Touch or narrow screen: a still long press opens the card's menu as the
// bottom sheet.
const lp = longPress({
  delay: 700,
  onPress: () => {
    haptic()
    openMenu(menuItems.value, title.value)
  },
})
const chatIntent = useChatIntent()
const intent = chatHoverIntent(() => {
  // Space cards have their own destination; only warm direct opens.
  if (!space.value && !selected.value) chatIntent.preload(props.pane)
})
onUnmounted(intent.cancel)
function hover(e: PointerEvent) {
  if (!(e.target as Element | null)?.closest?.('button, a')) intent.enter(e.pointerType)
}
function down(e: PointerEvent) {
  if (e.button === 0 && !(e.target as Element | null)?.closest?.('button, a')) intent.down()
  pointerType = e.pointerType
  if (!sheetMenus.value || (e.target as Element | null)?.closest?.('button, a')) return
  lp.down(e)
}
// Right click with a mouse (narrow window, tablet trackpad): the same sheet. A
// finger's contextmenu (Android long press) is left to the long press.
function onContext(e: MouseEvent) {
  intent.cancel()
  if (!sheetMenus.value) return
  e.preventDefault()
  if (pointerType === 'mouse') openMenu(menuItems.value, title.value)
}

function onContextOpen(open: boolean) {
  if (open && (pointerType === 'touch' || pointerType === 'pen')) touchMenuOpenedAt = Date.now()
}
function recentTouchMenu() { return Date.now() - touchMenuOpenedAt < 1000 || lp.swallowClick() }
function open() {
  if (recentTouchMenu()) return
  if (space.value) return openSpace(space.value.workspace.id, space.value.leadTab.tab.id)
  haptic()
  navigateTo(`/a/${encodeURIComponent(props.pane.id)}`)
}
// When the answers shown appeared (see choicesArmed): a tap that lands on them
// right then was aimed at what they pushed away.
// Answers that come with the list itself (first render) pushed nothing.
const shownChoices = () => (more.value ? quick.value.map(o => `${o.i}:${o.label}`).join('\n') : '')
let choicesAt = list.shown() && shownChoices() ? Date.now() : 0
watch(shownChoices, (shown) => { if (shown) choicesAt = Date.now() }, { flush: 'sync' })
async function pick(i: number, label: string) {
  if (recentTouchMenu() || !choicesArmed(choicesAt, Date.now())) return
  busy.value = true
  const ok = await choose(props.pane.id, i, label, props.pane.prompt?.identity)
  // Success: the buttons disappear with the question on the next state.
  if (!ok) busy.value = false
}
function openInteraction() {
  if (recentTouchMenu()) return
  interactionWindowFor(props.pane.id).reopen()
  haptic()
  navigateTo(panePath(props.pane.id))
}
watch(() => props.pane.prompt, () => { busy.value = false })
const appear = list.shown()
onMounted(list.mount)
onUnmounted(list.unmount)
</script>

<template>
  <UContextMenu :disabled="sheetMenus" :items="contextItems" :press-open-delay="700" :ui="{ content: 'hw-dropdown' }" @update:open="onContextOpen">
    <div
      ref="card" class="card" :class="[cardStatus, { sel: selected, stale: paneStale(pane), 'space-card': space, compact: true, open: more, 'home-task-two': activityLine }]" :data-pane="pane.id" :data-space="space?.workspace.id" :data-ws="pane.workspace"
      role="button" tabindex="0" @pointerenter="hover" @pointerleave="intent.cancel" @pointerdown="down" @pointermove="lp.move" @pointerup="lp.cancel" @pointercancel="lp.cancel(); intent.cancel()"
      @contextmenu="onContext" @selectstart.prevent @click="open" @keydown.enter.self="open"
    >
      <AgentAvatar :agent="pane.agent" />
      <span class="card-title">{{ title }}</span>
      <span v-if="machineBadge" class="card-tag card-origin" :title="machineBadge">{{ machineBadge }}</span>
      <span v-if="statePane.usageLimit" class="card-tag quota-limit" :title="stateTitle">{{ tl('Quota', 'Quota') }}</span>
      <span v-if="compactDots.length" class="card-tab-dots" :title="counts" :aria-label="tl('Tab states', 'États des onglets')"><i v-for="(d, i) in compactDots" :key="i" :class="d" /></span>
      <span v-else-if="compact.panes" class="card-panes" :title="counts">{{ compact.panes }}</span>
      <span class="card-state" :class="statusKey(statePane)" :title="stateTitle" role="img" :aria-label="stateTitle"><i /></span>
      <span v-if="activityLine" class="home-task-line" :title="activityLine">{{ activityLine }}</span>
      <OmpContext v-if="statePane.agent === 'omp'" :pane="statePane" variant="bar" />
      <Transition name="card-more" :appear="appear">
        <div v-if="more" class="card-more">
          <div class="card-more-in">
            <!-- Space with several panes: the one that asks, on the mini-map and by name. -->
            <div v-if="space && space.panes.length > 1" class="card-where">
              <TabMap :layout="space.leadTab.layout" :panes="space.leadTab.panes" :current="pane.id" /><span class="card-where-text">{{ where || kindLabel(pane.agent) }}</span>
            </div>
            <div v-if="prompt?.detail" class="card-detail" :title="detailLine(prompt.detail)">
              <span class="card-detail-tool">{{ prompt.detail.tool }}</span><code>{{ detailLine(prompt.detail) }}</code>
            </div>
            <div v-if="preview" class="card-preview">{{ preview }}</div>
            <div v-if="interactive" class="card-choices">
              <button type="button" :disabled="!eventsOpen || offlineView || paneStale(pane)" @click.stop="openInteraction">
                <UIcon name="i-lucide-square-terminal" /><span class="l">{{ tl('Open interactive terminal', 'Ouvrir le terminal interactif') }}</span>
              </button>
            </div>
            <div v-else-if="quick.length" class="card-choices">
              <button
                v-for="o in quick" :key="o.i" type="button" :disabled="busy || prompt?.unavailable || !eventsOpen || offlineView || paneStale(pane)"
                @click.stop="pick(o.i, o.label)"
              >
                <span class="n">{{ o.i + 1 }}</span><span class="l">{{ prompt?.kind === 'self-update' ? t(o.label) : o.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </UContextMenu>
</template>

<style scoped>
.card.compact .quota-limit { color: var(--ochre); border-color: currentColor; }
</style>
