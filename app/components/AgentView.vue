<script lang="ts">
// View that set `curPane` last (shared by all instances).
let curPaneOwner: symbol | null = null
</script>

<script setup lang="ts">
// Agent view: space tabs, header, then the pane (Conversation / Terminal
// selector, blocking prompt, key bar, input bar).
// Phone: no selector, a header icon (terminal `>_`)
// toggles the pane's presentation. Computer: small selector in
// the header (or in the cell's, side by side).
// Pane of a tab with several panes: mini-map of the tab in the header
// (back to the plan, or side-by-side view on a computer) and, on the phone,
// left / right swipe to the neighbours (Herdr's reading order).
// `cell`: cell of the side-by-side view (computer). All cells are
// live: the conversation, or the terminal. Only the active cell (`active`, a
// click in a cell activates it) receives keyboard input. Every terminal
// stays connected and fitted to its own cell regardless of focus.
import type { QueuedMessage } from '#shared/types'
import type { PaneViewMode } from '~/composables/useHerdr'
import { neighborPane } from '#shared/layout'
import { swipeAxis, swipeOffset, swipeStep } from '~/utils/swipe'
import { cellMode, showComposer, terminalAttachment } from '~/utils/viewMode'
import { carriesFiles, dragDepth } from '~/utils/fileDrop'
import { interactionWindowFor } from '~/utils/interactionWindow'
import { agentKeys, mergeKeys, replacementPane } from '~/utils/agentIdentity'

const props = defineProps<{ paneId: string, cell?: boolean, active?: boolean, grip?: boolean, embedded?: boolean, selectedMode?: PaneViewMode }>()
const emit = defineEmits<{ activate: [], 'update:selectedMode': [mode: PaneViewMode] }>()
const route = useRoute()
const router = useRouter()

// Pane being viewed (no notification for it, read as soon as it finishes): the active
// cell. Only the view that set it clears it (the next view of the same pane
// may mount before the previous one unmounts).
const live = computed(() => !props.cell || Boolean(props.active))
const me = Symbol('vue agent')
watch(live, (on) => {
  if (!on) return
  curPane.value = props.paneId
  curPaneOwner = me
}, { immediate: true })
onUnmounted(() => {
  if (curPaneOwner === me) curPane.value = null
})

const pane = computed(() => herdrState.value.panes.find(p => p.id === props.paneId))
const compactPhone = computed(() => !desk.value && !tablet.value && !props.cell)
const phoneKeysOpen = ref(false)
const terminalCopying = ref(false)
watch(() => props.paneId, () => { phoneKeysOpen.value = false })
// Remember this optional hint for the same agent on this device. A different
// agent in a reused pane gets its own choice; hiding it never hides errors.
const transcriptNoteKey = computed(() => {
  const p = pane.value
  if (!p?.agent) return ''
  const machine = p.id.includes('~') ? p.id.split('~')[0] : 'local'
  return `wherdr:transcript-note:hidden:${machine}:${p.agent}:${p.agentSession || p.id}`
})
const transcriptNoteHidden = ref(false)
watch(transcriptNoteKey, key => {
  transcriptNoteHidden.value = false
  if (!key || typeof window === 'undefined') return
  try { transcriptNoteHidden.value = localStorage.getItem(key) === '1' } catch { /* Storage may be disabled. */ }
}, { immediate: true })
function hideTranscriptNote() {
  transcriptNoteHidden.value = true
  try { if (transcriptNoteKey.value) localStorage.setItem(transcriptNoteKey.value, '1') } catch { /* Still hide it for this visit. */ }
}
const workspace = computed(() => herdrState.value.workspaces.find(w => w.id === pane.value?.workspace))
// Several panes in the tab (cell or full screen): each pane carries its
// own name; the space name stays in the tab header.
const ownTitle = computed(() => Boolean(props.cell || (tabEnt.value && tabEnt.value.panes.length > 1)))
const headTitle = computed(() => (pane.value ? (ownTitle.value ? paneTitle(pane.value) : spaceTitle(pane.value, workspace.value)) : '—'))
const subtitle = computed(() => {
  const s = pane.value ? conversationSubtitle(pane.value, workspace.value) : ''
  return s && s !== headTitle.value ? s : ''
})
const command = computed(() => (pane.value?.command && pane.value.command !== headTitle.value && pane.value.command !== subtitle.value ? pane.value.command : ''))
const tabName = computed(() => pane.value && herdrState.value.tabs?.filter(x => x.workspace === pane.value?.workspace).length! > 1 ? pane.value.tabLabel : '')
// Tab of this pane (each conversation keeps its own): the pane's remembered
// mode if there is one, otherwise the device default on a computer, the
// conversation on the phone. A change of the default applies at once to the
// panes without an explicit choice.
const viewMode = computed<PaneViewMode>({
  get: () => paneViewMode(props.paneId),
  set: m => setPaneViewMode(props.paneId, m),
})
// State not received yet (opened from a notification): we wait to
// know whether it is an agent, so as not to open the terminal for nothing.
// Cell: the pane's remembered mode (conversation or terminal), whether the cell
// has the focus or not; focus changes the border and keyboard routing.
const mode = computed<PaneViewMode | null>(() => {
  const p = pane.value
  if (!p) return null
  if (props.embedded && props.selectedMode) return props.selectedMode
  if (props.cell) return cellMode({ chat: hasChat(p), viewMode: viewMode.value, active: props.active })
  return hasChat(p) ? viewMode.value : 'term'
})

const banner = shallowRef<Banner | null>(null)
const ctl = createTerminal(props.paneId, {
  setBanner: (b) => { banner.value = b },
  hasBanner: () => Boolean(banner.value),
  fill: () => Boolean(props.cell),
  input: () => live.value && !terminalCopying.value,
})
const chatRef = ref<{ scrollToEnd: (force: boolean) => void, reload: () => void, focusSearch: () => void, gotoUnanswered: () => void } | null>(null)
// Questions of the agent's last message the draft does not answer yet (ChatView): the composer's reminder.
const unanswered = ref(0)
const composer = ref<{ focus: () => void, focusEnd: () => void, focusAnswer: (at: number) => void, blur: () => void, addImages: (files: File[]) => Promise<void>, addFiles: (files: File[]) => Promise<number>, stop: () => boolean } | null>(null)
const searchOpen = ref(typeof route.query.q === 'string' && typeof route.query.hit === 'string')

// Pane closed while being viewed. A pane just created may be missing
// from the first state received: we only conclude after seeing it, or after 4 s.
const seen = ref(Boolean(pane.value))
const graceOver = ref(false)
const graceTimer = setTimeout(() => { graceOver.value = true }, 4000)
onUnmounted(() => clearTimeout(graceTimer))
const closedBanner: Banner = { text: t('This pane has been closed.'), btn: t('Back'), fn: () => navigateTo('/') }
const closed = computed(() => !pane.value && herdrState.value.ok && (seen.value || graceOver.value) && !isClosing(props.paneId))
watch(pane, (p) => {
  if (!p) return
  seen.value = true
  if (banner.value === closedBanner) {
    banner.value = null
    if (mode.value === 'term' && !ctl.isConnected()) nextTick(() => ctl.connect(false))
  }
})
watch(closed, (c) => {
  if (c) banner.value = closedBanner
}, { immediate: true })

watch(mode, (m, old) => {
  if (m === 'chat' && old === 'term') {
    banner.value = closed.value ? banner.value : null
  }
}, { immediate: true })

function setMode(m: PaneViewMode) {
  if (props.embedded) emit('update:selectedMode', m)
  if (props.cell) emit('activate')
  viewMode.value = m
  if (desk.value && m === 'term') nextTick(() => ctl.focus())
  haptic()
}
// Header icon (phone): one tap shows the terminal, a second one goes back to the conversation.
function toggleMode(m: 'term') {
  setMode(toggleViewMode(mode.value, m))
}
function toggleSearch() {
  if (searchOpen.value) searchOpen.value = false
  else {
    searchOpen.value = true
    if (mode.value !== 'chat') viewMode.value = 'chat'
  }
}
// Keyboard (computer, composables/useShortcuts.ts). Mod+F: in the conversation only
// (the browser keeps its search in the terminal). Ctrl+`: the Conversation / Terminal
// selector. Escape: the Stop button, not while searching.
usePaneShortcuts(() => props.paneId, () => live.value, {
  searchChat() {
    if (!pane.value || !hasChat(pane.value) || mode.value !== 'chat') return false
    if (searchOpen.value) chatRef.value?.focusSearch()
    else searchOpen.value = true
    return true
  },
  toggleTerm() {
    if (!pane.value || !hasChat(pane.value) || !mode.value) return false
    const back = mode.value !== 'chat'
    setMode(back ? 'chat' : 'term')
    if (back) nextTick(() => composer.value?.focus())
    return true
  },
  stop: () => mode.value === 'chat' && Boolean(composer.value?.stop()),
})

const draft = useDraft(props.paneId)

// The same agent in another pane (utils/agentIdentity.ts). Herdr may close
// this pane and open a new one for the same agent (herdr-projects restarting
// a coordinator): the draft follows the agent, and the view moves to the new
// pane. The keys are gathered while the pane is open; the board's links say
// which coordinator or task it is.
const boardLinks = useBoardLinks()
// Seeded with the keys stored with the draft: after a reload on a pane already
// closed, they are all that says who it was.
const known = shallowRef<string[]>(draftOwnerKeys(props.paneId))
const liveIds = computed(() => (herdrState.value.ok ? herdrState.value.panes.map(p => p.id).join(' ') : ''))
watch([() => pane.value && agentKeys(pane.value, boardLinks.value).join(' '), liveIds], ([keys, ids]) => {
  if (!keys || !ids) return
  const add = keys.split(' ')
  known.value = mergeKeys(known.value, add)
  noteDraftOwner(props.paneId, add)
  // A draft left by this agent's closed pane comes into this field.
  if (adoptDrafts(props.paneId, add, new Set(ids.split(' ')))) {
    toast(tl('Draft from the closed pane restored', 'Brouillon du pane fermé récupéré'))
  }
}, { immediate: true })
const replacement = computed(() => (closed.value ? replacementPane(props.paneId, known.value, herdrState.value.panes, boardLinks.value) : null))
watch(replacement, (r) => {
  if (!r) return
  moveDraft(props.paneId, r.id)
  // A cell or the Board's panel follows its own layout: it offers the way.
  if (props.cell || props.embedded) return
  toast(tl('The agent restarted in a new pane: opened it', 'L’agent a redémarré dans un nouveau pane : il est ouvert'))
  router.replace(panePath(r.id))
}, { immediate: true })
// Closed with no replacement yet: the board names the new pane within seconds.
let linksTimer: ReturnType<typeof setInterval> | undefined
watch(() => closed.value && !replacement.value, (waiting) => {
  clearInterval(linksTimer)
  linksTimer = undefined
  if (!waiting) return
  refreshBoardLinks()
  let left = 20
  linksTimer = setInterval(() => {
    if (--left <= 0) { clearInterval(linksTimer); linksTimer = undefined }
    if (pageVisible.value) refreshBoardLinks()
  }, 3000)
}, { immediate: true })
onUnmounted(() => clearInterval(linksTimer))
const hasDraft = computed(() => draftFilled(draft))
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(draftAsText(draft))
    toast(tl('Draft copied', 'Brouillon copié'))
  } catch { toast(t('Copy failed'), true) }
}

// Messages just sent (or still sending), shown without waiting for the next
// state (see composables/useOutbox.ts).
const localQueued = computed(() => outboxFor(props.paneId))
function onSent(q: QueuedMessage | null) {
  if (q) outboxAdd(props.paneId, q)
  chatRef.value?.scrollToEnd(true)
  chatRef.value?.reload()
}
// As soon as the server knows them (or 10 s after its answer), the server state wins.
watch(pane, p => outboxPrune(props.paneId, p?.queued || []))

const prompt = computed(() => (pane.value && pane.value.status === 'blocked' && pane.value.prompt && pane.value.prompt.options ? pane.value.prompt : null))
const screen = computed(() => knownScreen(pane.value))
// Menu interactif de Claude Code ouvert (/resume…), agent au repos.
const menu = computed(() => (pane.value && pane.value.menu && pane.value.status !== 'working' && !prompt.value && !screen.value ? pane.value.menu : null))
watch(() => JSON.stringify([prompt.value, screen.value, menu.value]), () => nextTick(() => chatRef.value?.scrollToEnd(false)))

const where = computed(() => {
  const p = pane.value
  return p ? shortPath(p.cwd) : ''
})
// Several machines: the agent's, in its metadata.
const machine = computed(() => (multiMachine.value && pane.value ? machineInfo(pane.value.machine) : undefined))
const machineDown = computed(() => Boolean(machine.value && machine.value.status !== 'online'))
function onReview(text: string) {
  draft.text = draft.text ? `${draft.text}\n\n${text}` : text
  changesOpen.value = false
  setMode('chat')
  nextTick(() => composer.value?.focusEnd())
}
const changesOpen = ref(false)
const filesOpen = ref(false)
const attachInput = ref<HTMLInputElement | null>(null)
// Interactive menu open (conversation view): what would be typed would go into its
// search; the menu card has its own field.
// Terminal shown: the prompt, waiting screen or
// menu are already there, and the key bar answers them; no duplicate "Your turn" card.
const termShown = computed(() => mode.value === 'term')
const interactionWindow = interactionWindowFor(props.paneId)
const interactionOpen = ref(interactionWindow.resume(pane.value?.interaction || 'unknown'))
const interactionAvailable = computed(() => mode.value === 'chat' && eventsOpen.value && !offlineView.value && !machineDown.value && !paneStale(pane.value))
const interactive = computed(() => pane.value?.interaction === 'terminal')
// No polling: the window only changes with an observation (watchers below) or
// when a debounce ends, which gets a single timeout. A hidden page arms none
// and catches up when it comes back.
let interactionTimer: ReturnType<typeof setTimeout> | undefined
function syncInteraction() {
  clearTimeout(interactionTimer)
  interactionTimer = undefined
  const now = Date.now()
  interactionOpen.value = interactionWindow.update(pane.value?.interaction || 'unknown', now)
  const due = interactionWindow.deadline()
  if (due !== null && pageVisible.value) interactionTimer = setTimeout(syncInteraction, Math.max(0, due - now))
  // A late native card owns the interaction too: an earlier text snapshot
  // must never cover its controls or swallow its keyboard shortcuts.
  if ((interactive.value || interactionOpen.value || prompt.value || menu.value || screen.value)
    && commandResult.open && commandResult.pane === props.paneId) closeCommandResult(false)
}
watch([() => pane.value?.interaction, prompt, menu, screen, () => commandResult.open, () => commandResult.pane, pageVisible], syncInteraction, { immediate: true })
const unsubscribeInteraction = interactionWindow.subscribe(syncInteraction)
onUnmounted(() => {
  clearTimeout(interactionTimer)
  unsubscribeInteraction()
})
function closeInteraction() { interactionWindow.dismiss(); interactionOpen.value = false }
function reopenInteraction() {
  if (props.cell) emit('activate')
  interactionWindow.reopen()
  interactionOpen.value = true
}
// A modal window over the whole app: only the pane in use shows it, never under the
// lock screen. Another cell of a split keeps its "Open" button until it is activated.
const interactionShown = computed(() => interactionOpen.value && interactionAvailable.value && live.value && !locked.value)
const composerShown = computed(() => showComposer({ desk: desk.value, live: live.value, mode: mode.value, cell: Boolean(props.cell) }) && !(menu.value && mode.value !== 'term') && !(mode.value === 'chat' && interactionOpen.value))
const canAttachTerminal = computed(() => terminalAttachment({
  desk: desk.value, live: live.value, mode: mode.value,
  available: Boolean(pane.value && eventsOpen.value && !offlineView.value && !machineDown.value && !paneStale(pane.value)),
}))

function attachFile(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  sendFiles(files)
}
async function sendFiles(files: File[]) {
  if (!canAttachTerminal.value || !pane.value) return
  for (const file of files) {
    try {
      const ext = file.name.includes('.') ? file.name.split('.').pop() || '' : ''
      const r = await fetch(`/api/file?pane=${encodeURIComponent(props.paneId)}&ext=${encodeURIComponent(ext)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(data.error || `HTTP ${r.status}`))
      onSent(await sendMessage(pane.value, props.paneId, data.path))
      haptic()
    } catch (err) { toast(`${t('File upload failed')} : ${(err as Error).message}`, true) }
  }
}

// Files dragged from the Finder / file explorer: conversation → photos of the
// field (same path as the "+"); terminal → same send as "Attach a
// file…". Elsewhere (offline), nothing: app.vue only stops
// the browser from opening the file.
const dropTarget = computed<'chat' | 'term' | null>(() => {
  if (canAttachTerminal.value) return 'term'
  if (composerShown.value && !offlineView.value) return 'chat'
  return null
})
const dropDepth = ref(0)
function onDrag(e: DragEvent) {
  if (!carriesFiles(e.dataTransfer) || !dropTarget.value) return
  e.preventDefault()
  if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dropDepth.value = dragDepth(dropDepth.value, e.type)
}
function onDrop(e: DragEvent) {
  dropDepth.value = 0
  if (!carriesFiles(e.dataTransfer) || !dropTarget.value) return
  e.preventDefault()
  const files = [...(e.dataTransfer?.files || [])]
  if (!files.length) return
  if (dropTarget.value === 'term') return sendFiles(files)
  composer.value?.addFiles(files).then((n) => {
    if (!n) return
    composer.value?.focus()
    haptic()
  })
}
// What the message field accepts for this agent (drop overlay).
const dropHint = computed(() => pane.value?.agent === 'claude'
  ? t('Images, PDFs, text and code files')
  : t('Images, text and code files'))

// Agent menu: sheet on the phone, dropdown menu on a computer.
useNotificationClock()
const agentMenu = computed<MenuItem[]>(() => {
  const p = pane.value
  const items: MenuItem[] = p ? [notificationMenuItem(p)] : []
  if (compactPhone.value && hasChat(p)) {
    items.unshift(
      { label: t(mode.value === 'term' ? 'Conversation' : 'Terminal'), icon: mode.value === 'term' ? 'i-lucide-message-square' : 'i-lucide-square-terminal', run: () => toggleMode('term') },
      { label: t('Search'), icon: 'i-lucide-search', run: toggleSearch },
      { kind: 'separator' },
    )
  }
  if (compactPhone.value && inTab.value) items.push({ label: t('Tab overview'), icon: 'i-lucide-panels-top-left', run: openPlan })
  if (canAttachTerminal.value) items.push({ label: t('Attach a file…'), icon: 'i-lucide-paperclip', run: () => attachInput.value?.click() })
  if (p) items.push({ label: t('View changes'), icon: 'i-lucide-file-diff', run: () => { changesOpen.value = true } })
  if (p) items.push({ label: t('Browse files'), icon: 'i-lucide-folder-tree', run: () => { filesOpen.value = true } })
  // Current agent folder in its default editor, on the agent's Mac (Mod+Alt+O).
  if (p && canOpenOnMachine(p)) {
    items.push({
      label: t('Open in editor'), icon: 'i-lucide-external-link',
      kbds: live.value ? shortcutKbds('open-editor') : undefined, run: () => openFolderOnMachine(p),
    })
  }
  if (p) items.push({ label: t('Rename pane'), icon: 'i-lucide-pencil', run: () => { renameTarget.value = p.id } })
  // Split, move to another tab (never zoom or resize).
  if (p) items.push(...paneSpaceItems(p))
  if (p) items.push(copyPaneIdItem(p))
  // The machine's Herdr plugin actions that apply to a workspace / pane.
  if (p && agentPluginActions(p.machine).length) {
    items.push({ label: t('Plugin actions'), icon: 'i-lucide-puzzle', run: () => openPluginMenu({ pane: p }) })
  }
  items.push({
    label: t('Take control of this terminal'), icon: 'i-lucide-arrow-left-right',
    run: () => { banner.value = null; viewMode.value = 'term'; nextTick(() => ctl.connect(true)) },
  })
  // Relaunch Claude / Codex / omp in this pane, on the same conversation.
  if (p && canRestart(p) && !p.restart) items.push({ label: t('Restart agent'), icon: 'i-lucide-rotate-cw', run: () => restartAgent(p) })
  items.push({
    label: t('Reconnect'), icon: 'i-lucide-refresh-cw',
    run: () => { banner.value = null; viewMode.value = 'term'; nextTick(() => { ctl.reset(); ctl.connect(false) }) },
  })
  // Tab and space: long press (right click) on the tab, the space card
  // or its title; new tab: the "+" of the header or of the tabs.
  if (!props.cell) items.push(...settingsMenuItems())
  if (p) {
    items.push({ kind: 'separator' })
    items.push({
      label: p.agent ? tl(`Close this pane (stops ${kindLabel(p.agent)})`, `Fermer ce pane (arrête ${kindLabel(p.agent)})`) : t('Close this terminal'),
      icon: 'i-lucide-trash-2', danger: true, kbds: live.value ? shortcutKbds('close-pane') : undefined, run: () => closePane(p),
    })
    // Pane in a worktree: remove the checkout (and close its workspace).
    const ws = herdrState.value.workspaces.find(w => w.id === p.workspace)
    if (ws && ws.worktree) {
      items.push({ label: t('Delete this worktree'), icon: 'i-lucide-git-branch', danger: true, run: () => removeWorktreeOf(p.workspace) })
    }
  }
  return items
})
async function removeWorktreeOf(workspace: string) {
  await loadWorktrees()
  const w = (worktrees.value || []).find(x => x.workspace === workspace)
  if (!w) return toast(t('Worktree not found'), true)
  if (await removeWorktreeFlow(w)) navigateTo('/')
}
const dropdownItems = computed(() => toDropdown(agentMenu.value))
function openAgentMenu() { openMenu(agentMenu.value) }
watch(() => pane.value && (pane.value.machine || ''), (m) => { if (m !== undefined) loadPluginActions(m) }, { immediate: true })

// Conversation / Terminal selector (computer): in the pane header
// or in the side-by-side cell's.
// The icons replace the labels in a narrow cell (CSS).
const tabs = computed(() => [
  { label: t('Conversation'), value: 'chat', icon: 'i-lucide-message-square' },
  { label: t('Terminal'), value: 'term', icon: 'i-lucide-square-terminal' },
])
const tabsUi = { list: 'hw-tabs', trigger: 'hw-tab', indicator: 'hw-tab-ind', leadingIcon: 'hw-tab-icon', label: 'hw-tab-label' }
const tab = computed({
  get: () => (mode.value === 'term' ? 'term' : 'chat'),
  set: (v: string) => setMode(v === 'term' ? 'term' : 'chat'),
})
// Terminal keys: under the terminal, and in the active side-by-side cell on a
// touch screen (iPad without a hardware keyboard: Esc, arrows, ^C).
const keysAvailable = computed(() => Boolean(pane.value) && live.value && eventsOpen.value && !offlineView.value && !machineDown.value)
const keybarToggleShown = computed(() => compactPhone.value && keysAvailable.value && !interactionShown.value)
const keybarId = computed(() => `pane-keys-${encodeURIComponent(props.paneId)}`)
const keybarShown = computed(() => keysAvailable.value && (compactPhone.value ? phoneKeysOpen.value
  : mode.value === 'term' && (!props.cell || Boolean(coarse.value && props.active))))
watch(keybarToggleShown, on => { if (!on) phoneKeysOpen.value = false })
watch(phoneKeysOpen, on => { if (!on) ctl.clearVirtualModifiers() })
function togglePhoneKeys() {
  haptic()
  phoneKeysOpen.value = !phoneKeysOpen.value
}
const controls = computed(() => viewControls({ desk: desk.value, cell: Boolean(props.cell), chat: hasChat(pane.value), live: live.value }))
const headerAdd = computed(() => !props.cell && pane.value && spaceTabControls(spaceTabs(pane.value.workspace).length).headerAdd)

watch(fontSize, n => ctl.setFontSize(n))
watch(pageVisible, (v) => {
  ctl.setVisible(v)
})

// ------------------------------------------------------------ onglet
const tabEnt = computed(() => (pane.value ? tabOf(pane.value.tab) : null))
const inTab = computed(() => Boolean(tabEnt.value && tabEnt.value.panes.length > 1))
function openPlan() {
  if (!tabEnt.value) return
  if (desk.value) navigateTo({ path: tabPath(tabEnt.value.tab.id), query: { pane: props.paneId } })
  else backToTab(tabEnt.value.tab.id)
}
// Back: to the tab's plan or to the Board if we came from it, otherwise to the list.
function goBack() {
  const back = (history.state as { back?: string } | null)?.back
  if (back === '/board' || (tabEnt.value && back === tabPath(tabEnt.value.tab.id))) router.back()
  else navigateTo('/')
}

// Swipe (phone, conversation): the conversation follows the finger, damped,
// braked at the edge; far or fast enough, the neighbour replaces it (same
// history entry: back returns to the plan).
const enter = swipeDir.value
swipeDir.value = 0
const drag = ref(0)
const dragging = ref(false)
let sx = 0
let sy = 0
let st = 0
let axis: 'x' | 'y' | null | 'off' = 'off'
const neighbor = (step: 1 | -1) => (tabEnt.value ? neighborPane(tabEnt.value.layout, props.paneId, step) : null)
// Block that scrolls sideways itself (code, table): the gesture belongs to it.
function scrollsSideways(el: EventTarget | null, root: HTMLElement) {
  for (let n = el as HTMLElement | null; n && n !== root; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true
  }
  return false
}
// Gesture taken on the conversation, the agent's question or the terminal (which
// only scrolls vertically); not on the key bar or the input field.
function onSwipeStart(e: TouchEvent) {
  axis = 'off'
  // A cell (side by side, the Board's panel) never swipes to its neighbours.
  if (terminalCopying.value || props.cell || desk.value || !inTab.value || e.touches.length !== 1) return
  const zone = (e.target as HTMLElement | null)?.closest?.('.swipe-area, .choices, #termWrap') as HTMLElement | null
  if (!zone || scrollsSideways(e.target, zone)) return
  sx = e.touches[0]!.clientX
  sy = e.touches[0]!.clientY
  st = Date.now()
  axis = null
}
function onSwipeMove(e: TouchEvent) {
  if (axis === 'off' || axis === 'y') return
  const dx = e.touches[0]!.clientX - sx
  const dy = e.touches[0]!.clientY - sy
  if (axis === null) axis = swipeAxis(dx, dy)
  if (axis !== 'x') return
  e.preventDefault()
  dragging.value = true
  drag.value = swipeOffset(dx, Boolean(neighbor(dx < 0 ? 1 : -1)))
}
function onSwipeEnd(e: TouchEvent) {
  if (axis === 'x') {
    const dx = (e.changedTouches[0]?.clientX ?? sx) - sx
    const step = swipeStep(dx, Date.now() - st, window.innerWidth)
    const target = step ? neighbor(step) : null
    if (target) {
      haptic()
      swipeDir.value = step
      router.replace(panePath(target))
    }
  }
  axis = 'off'
  dragging.value = false
  drag.value = 0
}
const swipeStyle = computed(() => (inTab.value && !desk.value
  ? { transform: drag.value ? `translateX(${drag.value}px)` : undefined, transition: dragging.value ? 'none' : 'transform .18s ease' }
  : {}))

// Computer: give the keyboard to the interactive view on opening.
onMounted(() => {
  if (desk.value && live.value) setTimeout(() => (mode.value === 'term' ? ctl : composer.value)?.focus(), 50)
})
// Cell just activated by a click outside its content: we give it the keyboard.
watch(() => props.active, (a, was) => {
  if (a && !was && props.cell) setTimeout(() => { if (!document.activeElement?.closest('.cell-view.active')) (mode.value === 'term' ? ctl : composer.value)?.focus() }, 50)
})
// Click on the cell's header, outside its controls: nothing there takes the
// focus, which falls to the page and loses the next keystrokes. Back to the view.
function refocus(e: MouseEvent) {
  const el = e.target as Element | null
  if (!props.cell || !desk.value || !el?.closest?.('.agent-top') || el.closest('button, a, input, [role="tab"], .cell-grip')) return
  if (document.activeElement && document.activeElement !== document.body) return
  (mode.value === 'term' ? ctl : composer.value)?.focus()
}

// Keyboard open (iPhone): the view fits the visible part.
const viewStyle = computed(() => (kbOpen.value ? { height: `${vvHeight.value}px`, top: `${vvTop.value}px` } : {}))
</script>

<template>
  <section
    :id="cell ? undefined : 'agent'" :class="[cell ? ['cell-view', { active, gripped: grip }] : 'view', { 'phone-chrome': compactPhone }]" :style="cell ? undefined : viewStyle" :data-pane="cell ? paneId : undefined"
    @touchstart="onSwipeStart" @touchmove="onSwipeMove" @touchend="onSwipeEnd" @touchcancel="onSwipeEnd"
    @pointerdown.capture="cell && emit('activate')" @focusin="cell && emit('activate')" @click="refocus"
    @dragenter="onDrag" @dragover="onDrag" @dragleave="onDrag" @drop="onDrop"
  >
    <div v-if="dropDepth && dropTarget" class="file-drop" aria-hidden="true">
      <UIcon :name="dropTarget === 'term' ? 'i-lucide-paperclip' : 'i-lucide-file-plus'" class="file-drop-icon" />
      <span class="file-drop-label">{{ t('Drop to attach') }}</span>
      <small>{{ dropTarget === 'term' ? t('The file path is sent to the terminal') : dropHint }}</small>
    </div>
    <SpaceTabs v-if="!cell && pane && !compactPhone" :workspace="pane.workspace" :current="pane.tab" />
    <HeaderMenu v-if="!embedded" :items="() => agentMenu" :disabled="!pane">
      <header class="top bar agent-top">
        <span v-if="cell && grip" class="cell-grip" role="button" :aria-label="t('Drag to move the pane')" :title="t('Drag to move the pane')">
          <UIcon name="i-lucide-grip-vertical" />
        </span>
        <UButton
          v-if="!cell" id="btnBack" icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back"
          :aria-label="t('Back')" @click="goBack"
        />
        <PhoneIdentity v-if="compactPhone && pane" :pane="pane" :workspace="workspace" @overview="openPlan" />
        <div v-else class="agent-head">
          <div class="agent-title">{{ headTitle }} <UIcon v-if="pane && paneNotificationsMuted(pane)" name="i-lucide-bell-off" class="notification-muted" :title="t('Muted')" /></div>
          <div class="agent-meta">
            <StatusPill :pane="pane" kind :compact="compactPhone" />
            <span v-if="subtitle" class="agent-subtitle">{{ subtitle }}</span>
            <span v-if="command" class="agent-subtitle agent-command">{{ command }}</span>
            <span v-if="tabName" class="agent-subtitle">{{ tabName }}</span>
            <span v-if="machine" class="agent-machine" :class="machine.status" :title="machine.target ? `ssh ${machine.target}` : undefined">
              <UIcon :name="machine.local ? 'i-lucide-server' : 'i-lucide-laptop'" /><span class="machine-inline-name">{{ machineName(machine.key) }}</span><MachineLocalBadge v-if="machine.local" />
            </span>
            <span v-if="where" class="where">{{ where }}</span>
          </div>
        </div>
        <UTabs
          v-if="controls.selector === 'cell'" v-model="tab" :items="tabs" :content="false" color="neutral" variant="pill" size="xs"
          class="view-tabs" :ui="tabsUi"
        />
        <div class="agent-actions">
          <UTabs
            v-if="controls.selector === 'header'" v-model="tab" :items="tabs" :content="false" color="neutral" variant="pill" size="xs"
            class="view-tabs" :ui="tabsUi"
          />
          <UButton
            v-if="headerAdd && pane && !compactPhone" icon="i-lucide-plus" color="neutral" variant="ghost" size="lg" class="icon-btn"
            :aria-label="t('New tab')" :title="t('New tab')" :disabled="offlineView" @click="newTab(pane.workspace)"
          />
          <UTooltip v-if="cell" :text="t('Open alone')">
            <UButton icon="i-lucide-maximize-2" color="neutral" variant="ghost" size="md" class="icon-btn cell-extra" :aria-label="t('Open alone')" :to="panePath(paneId)" />
          </UTooltip>
          <UTooltip v-else-if="inTab && tabEnt && !compactPhone" :text="t('Side by side')" :disabled="!desk">
            <button type="button" class="map-btn" :aria-label="desk ? t('Side by side') : t('Tab overview')" @click="openPlan">
              <TabMap :layout="tabEnt.layout" :panes="tabEnt.panes" :current="paneId" />
            </button>
          </UTooltip>
          <UButton
            v-if="controls.term" icon="i-lucide-square-terminal" color="neutral" variant="ghost" size="lg" class="icon-btn mode-btn"
            :class="{ on: mode === 'term' }" :aria-label="t('Terminal')" :aria-pressed="mode === 'term'" @click="toggleMode('term')"
          />
          <UTooltip v-if="hasChat(pane) && (live || cell) && !compactPhone" :text="t('Search')" :kbds="mode === 'chat' ? shortcutKbds('search-chat') : undefined" :disabled="!desk">
            <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="lg" class="icon-btn cell-extra" :class="{ on: searchOpen }" :aria-label="t('Search')" @click="toggleSearch" />
          </UTooltip>
          <UDropdownMenu v-if="!sheetMenus" :items="dropdownItems" :content="{ align: 'end', sideOffset: 6 }" :ui="{ content: 'hw-dropdown' }">
            <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Options')" />
          </UDropdownMenu>
          <UButton v-else icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Options')" @click="openAgentMenu" />
        </div>
      </header>
    </HeaderMenu>

    <div class="agent-body">
    <div class="agent-main hw-backdrop-host">
    <GridBackdrop v-if="desk && !cell && backdrop === 'wherdr' && mode === 'chat'" />
    <div v-if="machineDown && machine" class="term-banner machine-banner">
      <UIcon name="i-lucide-unplug" class="term-banner-icon" />
      <span>{{ machine.status === 'connecting' ? tl(`${machineName(machine.key)} unreachable — reconnecting…`, `${machineName(machine.key)} injoignable — reconnexion…`) : tl(`${machineName(machine.key)} offline`, `${machineName(machine.key)} hors ligne`) }}<small v-if="machine.error">{{ t(machine.error) }}</small></span>
    </div>
    <div v-if="banner === closedBanner && replacement" class="term-banner closed-banner">
      <UIcon name="i-lucide-refresh-cw" class="term-banner-icon" />
      <span>{{ tl('This agent continues in a new pane.', 'Cet agent continue dans un nouveau pane.') }}</span>
      <UButton size="xs" color="warning" variant="outline" :to="panePath(replacement.id)">{{ tl('Open', 'Ouvrir') }}</UButton>
    </div>
    <div v-else-if="banner" class="term-banner" :class="{ 'closed-banner': banner === closedBanner }">
      <UIcon name="i-lucide-triangle-alert" class="term-banner-icon" />
      <span>{{ banner === closedBanner && hasDraft ? tl('This pane has been closed. Your draft is kept below.', 'Ce pane a été fermé. Ton brouillon est gardé ci-dessous.') : banner.text }}</span>
      <UButton v-if="banner === closedBanner && hasDraft" size="xs" color="warning" variant="outline" icon="i-lucide-copy" @click="copyDraft">{{ tl('Copy draft', 'Copier le brouillon') }}</UButton>
      <UButton size="xs" color="warning" variant="outline" @click="banner.fn()">{{ banner.btn }}</UButton>
    </div>

    <div
      v-if="pane && mode === 'chat'" class="swipe-area" :class="enter ? (enter > 0 ? 'enter-next' : 'enter-prev') : undefined" :style="swipeStyle"
    >
      <ChatView
        ref="chatRef" v-model:search="searchOpen" :pane="pane" :local-queued="localQueued"
        @goto-term="setMode('term')" @restored="composer?.focus()" @quote="composer?.focusEnd()" @answered="composer?.focusAnswer($event)" @unanswered="unanswered = $event" @sent="onSent"
      />
    </div>
    <div v-else-if="mode === 'term' && (!eventsOpen || offlineView || machineDown)" class="chat-empty offline-terminal"><UIcon name="i-lucide-wifi-off" class="chat-empty-icon" /><p>{{ t('Terminal unavailable offline') }}</p></div>
    <TerminalView
      v-else-if="mode === 'term'" :ctl="ctl" @copying="terminalCopying = $event" :class="enter ? (enter > 0 ? 'enter-next' : 'enter-prev') : undefined" :style="swipeStyle"
    />
    <div v-else class="chat" />
    <div v-if="pane?.agent && !hasChat(pane) && mode === 'term' && !cell && !transcriptNoteHidden" class="terminal-transcript-note dismissible-transcript-note">
      <span>{{ tl('Conversation unavailable for this agent · follow it in the terminal', 'Conversation non disponible pour cet agent · suivi dans le terminal') }}</span>
      <button type="button" :aria-label="t('Hide')" :title="t('Hide')" @click="hideTranscriptNote">×</button>
    </div>

    <InteractiveTerminal v-if="interactionShown" :pane-id="paneId" :active="live" :title="headTitle" @close="closeInteraction" />
    <button v-else-if="(interactive || interactionOpen) && interactionAvailable" type="button" class="interactive-terminal-reopen" @click="reopenInteraction">
      <UIcon name="i-lucide-square-terminal" />{{ tl('Open interactive terminal', 'Ouvrir le terminal interactif') }}
    </button>
    <ChoicesPanel v-if="(prompt || screen) && !interactionOpen && !interactive && !termShown && eventsOpen && !offlineView && !machineDown" :pane-id="paneId" :prompt="prompt" :screen="screen" :keys="live" />
    <MenuPanel v-else-if="menu && !interactionOpen && !interactive && !termShown && eventsOpen && !offlineView && !machineDown" :pane-id="paneId" :menu="menu" :keys="live" @terminal="setMode('term')" />
    <div v-if="keybarToggleShown" class="phone-keybar-controls" :inert="terminalCopying">
      <button type="button" class="phone-keybar-toggle" :class="{ on: phoneKeysOpen }" :aria-label="t('Show or hide terminal keys')" :aria-expanded="phoneKeysOpen" :aria-controls="keybarId"
        @pointerdown.prevent @mousedown.prevent @click.stop="togglePhoneKeys"><UIcon name="i-lucide-keyboard" /></button>
    </div>
    <Keybar v-if="keybarShown" :id="keybarId" :inert="terminalCopying" :ctl="ctl" :compact="compactPhone" />
    <Composer v-if="composerShown" ref="composer" :inert="terminalCopying" :pane="pane" :pane-id="paneId" :send-keys="ctl.sendKeys" :conversation="mode === 'chat'" :term-shown="termShown" :esc-stops="!searchOpen && !terminalCopying" :take-back="mode === 'chat'" :unanswered="mode === 'chat' ? unanswered : 0" @sent="onSent" @show-terminal="setMode('term')" @show-unanswered="chatRef?.gotoUnanswered()" />
    </div>
    </div>
    <AppSheet v-model:open="changesOpen" :title="t('Changes')" wide full screen>
      <ChangesView v-if="changesOpen && pane" :pane-id="paneId" @review="onReview" />
    </AppSheet>
    <AppSheet v-model:open="filesOpen" :title="t('Files')" wide full screen>
      <FilesView v-if="filesOpen && pane" :pane-id="paneId" />
    </AppSheet>
    <input ref="attachInput" type="file" multiple hidden @change="attachFile">
  </section>
</template>

<style scoped>
.dismissible-transcript-note { display: flex; flex: none; align-items: center; gap: 8px; padding: 0 4px 0 12px; }
.dismissible-transcript-note > span { flex: 1; padding: 7px 0; }
.dismissible-transcript-note > button { flex: none; align-self: stretch; min-width: 40px; min-height: 40px; color: var(--muted); font: 22px/1 var(--sans); border-radius: 6px; touch-action: manipulation; }
.dismissible-transcript-note > button:hover, .dismissible-transcript-note > button:focus-visible { color: var(--text); background: var(--line-soft); }
</style>
