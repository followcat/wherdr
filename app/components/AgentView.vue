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
import type { Pane, QueuedMessage } from '#shared/types'
import { coreAgentMenu } from '~/utils/coreAgentMenu'
import type { PaneViewMode } from '~/composables/useHerdr'
import { neighborPane } from '#shared/layout'
import { spaceMapLayout } from '#shared/coreTabMap'
import { swipeAxis, swipeOffset, swipeStep } from '~/utils/swipe'
import { cellMode, showComposer, terminalAttachment } from '~/utils/viewMode'
import { carriesFiles, dragDepth } from '~/utils/fileDrop'
import { interactionWindowFor } from '~/utils/interactionWindow'
import { agentKeys, mergeKeys, replacementPane } from '~/utils/agentIdentity'
import { uiOpenPanel } from '~/utils/settingsPanel'
import type { UiOpenEvent } from '#shared/uiOpen'
import type { UiShowEvent } from '#shared/uiShow'

const props = defineProps<{ paneId: string, cell?: boolean, active?: boolean, embedded?: boolean, selectedMode?: PaneViewMode }>()
const emit = defineEmits<{ activate: [], 'update:selectedMode': [mode: PaneViewMode] }>()
const core = useRuntimeConfig().public.core
const paneChat = (p: Pane | null | undefined) => hasChat(p)
const route = useRoute()
const router = useRouter()
// An agent's `ui open` for this conversation (shared/uiOpen.ts), sent to this
// device only when the user uses it: Settings beside it on a computer
// (`show: 'panel'`, when the window has room), else the card the agent ends
// its reply with. A bar above the message field stands in for that card only
// when the reply is over without it. It never moves the user away: the card
// waits for their tap.
const uiCard = ref<UiOpenEvent | null>(null)
const turnOpens = ref<string[]>([])
watch([uiCard, turnOpens], ([e, opens]) => { if (e && opens.includes(e.link)) uiCard.value = null })
const uiBar = computed(() => pane.value?.status === 'working' ? null : uiCard.value)
watch(uiOpenRequest, (e) => {
  if (!e || e.pane !== props.paneId) return
  uiOpenRequest.value = null
  const panel = e.show === 'card' ? null : uiOpenPanel(e.link, route, sidePanelRoom.value)
  if (!panel) { uiCard.value = e; return }
  uiCard.value = null
  uiOpenedBy.value = { by: e.by, section: panel.query.section }
  router.push(panel)
})
// An agent's `ui show` (shared/uiShow.ts): beside the conversation when the
// window has room, else a card that opens it in a sheet (UiShowPanel.vue).
const showCard = ref<UiShowEvent | null>(null)
watch(uiShowRequest, (e) => {
  if (!e || e.pane !== props.paneId) return
  uiShowRequest.value = null
  if (sidePanelRoom.value) { showCard.value = null; uiShown.value = e } else showCard.value = e
})

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
// herdr-core: a coordinator's pane shows its header button (autopilot, agent, template change).
const coord = computed(() => coordinatorOf(pane.value))
let coordTimer: ReturnType<typeof setInterval> | undefined
// Not read yet (failed while the app woke up): asked again, and as soon as the server is back.
onMounted(() => { if (core) { loadCoordinators(); coordTimer = setInterval(() => { if (coord.value || !coordinatorsLoaded.value) loadCoordinators() }, 15_000) } })
watch(eventsOpen, (open) => { if (core && open && !coordinatorsLoaded.value) loadCoordinators() })
onUnmounted(() => clearInterval(coordTimer))
// herdr-core: opening a finished agent reads it (herdr.seen), once per turn, while the page is visible.
const pageVisible = ref(true)
const syncVisible = () => { pageVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => { syncVisible(); document.addEventListener('visibilitychange', syncVisible) })
onUnmounted(() => document.removeEventListener('visibilitychange', syncVisible))
watch(() => (core && live.value && pageVisible.value && pane.value?.agent && pane.value.status === 'done' ? pane.value.id : null), (id) => {
  if (id) api('/api/seen', { pane_id: id, read: true }).catch(() => {})
}, { immediate: true })
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
// A coordinator's conversation is titled by its name, a task agent's by its task
// (read once here when the list never showed); the session title stays the subtitle.
onMounted(() => { if (!Object.keys(taskAgents.value).length) loadTaskAgents() })
const badge = computed(() => paneBadge(pane.value))
const headTitle = computed(() => (pane.value ? paneCoordinatorName(pane.value) || paneTaskTitle(pane.value, !badge.value) || desktopHeaderTitle(pane.value, workspace.value, ownTitle.value) : herdrState.value.ok ? '—' : ''))
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
  if (props.cell) return cellMode({ chat: paneChat(p), viewMode: viewMode.value, active: props.active })
  return paneChat(p) ? viewMode.value : 'term'
})

const banner = shallowRef<Banner | null>(null)
// The one input predicate, shared with the terminal-drop path below: input
// (data, keys, paste, mouse, files) is refused while the surface is frozen.
const inputAllowed = () => live.value && !terminalCopying.value
// Setup-owned lifecycle flag: every async continuation of a drop checks it —
// a parked upload or send never outlives the view.
const dead = ref(false)
onUnmounted(() => { dead.value = true })
const ctl = createTerminal(props.paneId, {
  setBanner: (b) => { banner.value = b },
  hasBanner: () => Boolean(banner.value),
  fill: () => Boolean(props.cell),
  input: inputAllowed,
})
const chatRef = ref<{ scrollToEnd: (force: boolean) => void, reload: () => void, focusSearch: () => void, gotoUnanswered: () => void } | null>(null)
// Questions of the agent's last message the draft does not answer yet (ChatView): the composer's reminder.
const unanswered = ref(0)
const composer = ref<{ focus: () => void, focusEnd: () => void, focusAnswer: (at: number) => void, blur: () => void, addImages: (files: File[]) => Promise<void>, addFiles: (files: File[]) => Promise<number>, stop: () => boolean, sendText: (text: string) => Promise<void> } | null>(null)
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
    if (!pane.value || !paneChat(pane.value) || mode.value !== 'chat') return false
    if (searchOpen.value) chatRef.value?.focusSearch()
    else searchOpen.value = true
    return true
  },
  toggleTerm() {
    if (!pane.value || !paneChat(pane.value) || !mode.value) return false
    const back = mode.value !== 'chat'
    setMode(back ? 'chat' : 'term')
    if (back) nextTick(() => composer.value?.focus())
    return true
  },
  stop: () => mode.value === 'chat' && Boolean(composer.value?.stop()),
})

const draft = useDraft(props.paneId)

// The same agent in another pane (utils/agentIdentity.ts): the draft follows
// the agent, and the view moves to the new pane. The keys are gathered while
// the pane is open.
// Seeded with the keys stored with the draft: after a reload on a pane already
// closed, they are all that says who it was.
const known = shallowRef<string[]>(draftOwnerKeys(props.paneId))
const liveIds = computed(() => (herdrState.value.ok ? herdrState.value.panes.map(p => p.id).join(' ') : ''))
watch([() => pane.value && agentKeys(pane.value).join(' '), liveIds], ([keys, ids]) => {
  if (!keys || !ids) return
  const add = keys.split(' ')
  known.value = mergeKeys(known.value, add)
  noteDraftOwner(props.paneId, add)
  // A draft left by this agent's closed pane comes into this field.
  if (adoptDrafts(props.paneId, add, new Set(ids.split(' ')))) {
    toast(tl('Draft from the closed pane restored', 'Brouillon du pane fermé récupéré'))
  }
}, { immediate: true })
const replacement = computed(() => (closed.value ? replacementPane(props.paneId, known.value, herdrState.value.panes) : null))
watch(replacement, (r) => {
  if (!r) return
  moveDraft(props.paneId, r.id)
  // A cell or the Board's panel follows its own layout: it offers the way.
  if (props.cell || props.embedded) return
  toast(tl('The agent restarted in a new pane: opened it', 'L’agent a redémarré dans un nouveau pane : il est ouvert'))
  router.replace(panePath(r.id))
}, { immediate: true })
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
// As soon as the server lists them, the server state wins; once taken, they stay
// until the transcript is read again (see utils/outbox.ts prune).
watch(pane, p => outboxSync(props.paneId, p, herdrState.value.ok))

const prompt = computed(() => (pane.value && pane.value.status === 'blocked' && pane.value.prompt && pane.value.prompt.options ? pane.value.prompt : null))
watch(() => JSON.stringify(prompt.value), () => nextTick(() => chatRef.value?.scrollToEnd(false)))

const where = computed(() => {
  const p = pane.value
  return p ? shortPath(p.cwd) : ''
})
// Several machines: the agent's, in its metadata.
const machine = computed(() => (multiMachine.value && pane.value ? machineInfo(pane.value.machine) : undefined))
const machineDown = computed(() => Boolean(machine.value && machine.value.status !== 'online'))
const filesOpen = ref(false)
// Terminal shown: the prompt is already there, and the key bar answers it;
// no duplicate "Your turn" card.
const termShown = computed(() => mode.value === 'term')
const interactionWindow = interactionWindowFor(props.paneId)
const interactionOpen = ref(interactionWindow.resume(pane.value?.interaction || 'unknown'))
const interactionAvailable = computed(() => mode.value === 'chat' && linkShown.value && !offlineView.value && !machineDown.value && !paneStale(pane.value))
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
}
watch([() => pane.value?.interaction, pageVisible], syncInteraction, { immediate: true })
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
// herdr-core on a computer: the composer stays under the terminal of an agent.
const coreDeskComposer = computed(() => core && desk.value && live.value && !props.cell && Boolean(pane.value?.agent))
// OpenCode's conversation is read-only for now: no composer over it.
const composerShown = computed(() => (coreDeskComposer.value || showComposer({ desk: desk.value, live: live.value, mode: mode.value, cell: Boolean(props.cell) })) && !(mode.value === 'chat' && interactionOpen.value) && !(mode.value === 'chat' && pane.value?.agent === 'opencode'))
const canAttachTerminal = computed(() => terminalAttachment({
  desk: desk.value, live: live.value, mode: mode.value,
  available: Boolean(pane.value && linkShown.value && !offlineView.value && !machineDown.value && !paneStale(pane.value)),
}))

// Resolves once the shared input gate is open for the same target pane —
// false when the pane left the state, the view switched panes or unmounted
// first, so nothing stale is ever sent.
function inputOpen(target: string): Promise<boolean> {
  const bad = () => dead.value || props.paneId !== target || !pane.value
  if (!bad() && inputAllowed()) return Promise.resolve(true)
  if (bad()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const stop = watch([inputAllowed, () => props.paneId, () => dead.value, () => !pane.value], () => {
      if (bad()) { stop(); resolve(false) }
      else if (inputAllowed()) { stop(); resolve(true) }
    })
  })
}

async function sendFiles(files: File[]) {
  const target = props.paneId
  if (!canAttachTerminal.value || !pane.value) return
  // A drop on the frozen surface is refused before any upload starts, like a
  // file given to the inert composer (onDrop guards the same refusal).
  if (!inputAllowed()) return toast(t('Finish copying before dropping files'), true)
  const bad = () => dead.value || props.paneId !== target || !pane.value
  for (const file of files) {
    // Every file re-waits on the gate and the target pane before uploading —
    // and re-checks them live in the same synchronous continuation that calls
    // fetch: a resolved wait is only a snapshot, so a gate that closed in
    // between must keep waiting, never upload into the freeze.
    for (;;) {
      if (!(await inputOpen(target)) || bad()) return
      if (inputAllowed() && !bad()) break
    }
    try {
      const ext = file.name.includes('.') ? file.name.split('.').pop() || '' : ''
      const r = await fetch(`/api/file?pane=${encodeURIComponent(target)}&ext=${encodeURIComponent(ext)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(data.error || `HTTP ${r.status}`))
      // Same live check immediately before sendMessage, again in the same
      // synchronous continuation: an upload that finishes mid-freeze keeps
      // its result parked until Done (the drop already asked to send, like a
      // Composer attachment kept for a later send) — it is only abandoned
      // when the view or the target pane is gone.
      for (;;) {
        if (!(await inputOpen(target)) || bad()) return
        if (inputAllowed() && !bad()) break
      }
      if (!pane.value) return
      onSent(await sendMessage(pane.value, target, data.path))
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
  // Both drop routes share the freeze refusal: the composer is inert while
  // copying, so a programmatic addFiles must be refused the same way. The
  // browser's own open-the-file default stays suppressed above either way.
  if (terminalCopying.value) return toast(t('Finish copying before dropping files'), true)
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
// herdr-core: using the composer (tap or key, not its automatic focus) makes this screen's size the terminal's.
function takeTerminalControl() { if (core) ctl.takeControl() }
// herdr-core: Esc in the empty composer stops the agent here as well, so that it also works
// without the app shortcuts (phone layout); stopPropagation keeps the v2 shortcut from stopping twice.
function onComposerKey(e: KeyboardEvent) {
  takeTerminalControl()
  if (!core || e.key !== 'Escape' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const field = e.target as HTMLTextAreaElement | null
  if (field?.value) return
  if (composer.value?.stop() !== false) { e.preventDefault(); e.stopPropagation() }
}
// "Keep after restart" (terminal.keep): read when the pane changes, flipped from the menu.
const kept = ref<boolean | null>(null)
watch(() => (core ? pane.value?.id : undefined), async (id) => {
  kept.value = null
  if (!id) return
  try { const r = await api<{ keep: boolean }>(`/api/keep?pane=${encodeURIComponent(id)}`); if (pane.value?.id === id) kept.value = r.keep } catch { /* the item stays hidden */ }
}, { immediate: true })
async function toggleKeep(p: Pane) {
  const keep = !kept.value
  try { kept.value = (await api<{ keep: boolean }>('/api/keep', { pane_id: p.id, keep })).keep } catch (err) { toast((err as Error).message, true) }
}
function coreMenuItems(p: Pane | undefined): MenuItem[] {
  return coreAgentMenu({
    pane: p,
    keep: p && kept.value !== null ? { on: kept.value, toggle: () => toggleKeep(p) } : undefined,
    takeControl: () => { banner.value = null; viewMode.value = 'term'; nextTick(() => ctl.connect(true)) },
    rename: (id) => { renameTarget.value = id },
    reconnect: () => { banner.value = null; viewMode.value = 'term'; nextTick(() => { ctl.reset(); ctl.connect(false) }) },
    browseFiles: () => { filesOpen.value = true },
    settings: props.cell ? [] : settingsMenuItems(),
    close: p && !compactPhone.value ? closePaneItem(p, live.value ? shortcutKbds('close-pane') : undefined) : undefined,
  })
}
const agentMenu = computed<MenuItem[]>(() => coreMenuItems(pane.value))
const dropdownItems = computed(() => toDropdown(agentMenu.value))
function openAgentMenu() { openMenu(agentMenu.value) }

// Terminal keys: under the terminal, and in the active side-by-side cell on a
// touch screen (iPad without a hardware keyboard: Esc, arrows, ^C).
const keysAvailable = computed(() => Boolean(pane.value) && live.value && linkShown.value && !offlineView.value && !machineDown.value)
const keybarToggleShown = computed(() => compactPhone.value && keysAvailable.value && !interactionShown.value)
const keybarId = computed(() => `pane-keys-${encodeURIComponent(props.paneId)}`)
const keybarShown = computed(() => keysAvailable.value && (compactPhone.value ? phoneKeysOpen.value
  : mode.value === 'term' && (!props.cell || Boolean(coarse.value && props.active))))
watch(keybarToggleShown, on => { if (!on) phoneKeysOpen.value = false })
watch(phoneKeysOpen, on => { if (!on) ctl.clearVirtualModifiers() })
function toggleComposerKeyboard() {
  if (document.activeElement?.matches('.composer textarea')) composer.value?.blur()
  else composer.value?.focus()
}
function togglePhoneKeys() {
  haptic()
  phoneKeysOpen.value = !phoneKeysOpen.value
}
const controls = computed(() => viewControls({ desk: desk.value, cell: Boolean(props.cell), chat: paneChat(pane.value), live: live.value }))
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
// herdr-core: map of the space's terminals (each one a tab, no layout) -> list to switch.
const spaceMap = computed(() => {
  if (!core || props.cell || !pane.value) return null
  const tabs = spaceTabs(pane.value.workspace)
  if (tabs.length < 2) return null
  const panes = tabs.map(e => e.panes[0]!)
  return { layout: spaceMapLayout(pane.value.workspace, panes.map(p => p.id)), panes, tabs }
})
function openSpaceMap() {
  const m = spaceMap.value
  if (!m || !pane.value) return
  const ws = pane.value.workspace
  openMenu([
    ...m.tabs.map(e => ({ label: e.tab.label || String(e.tab.number), icon: e.panes[0]!.id === props.paneId ? 'i-lucide-check' : 'i-lucide-square-terminal', desc: paneTitle(e.panes[0]!), run: () => switchSpaceTab(e.tab.id) })),
    { kind: 'separator' as const },
    newTabItem(ws),
  ], t('Tabs of this space'))
}
// Header and browser back share the same history entry.
const goBack = useViewBack()

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
  // A cell (side by side, the Board's panel) never swipes to its neighbours;
  // nor does a finger held on the frozen screen.
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
  if (!props.cell || !desk.value || !el?.closest?.('.agent-top') || el.closest('button, a, input, [role="tab"]')) return
  if (document.activeElement && document.activeElement !== document.body) return
  (mode.value === 'term' ? ctl : composer.value)?.focus()
}

// Keyboard open (iPhone): the view fits the visible part.
const viewStyle = computed(() => (kbOpen.value ? { height: `${vvHeight.value}px`, top: `${vvTop.value}px` } : {}))
</script>

<template>
  <section
    :id="cell ? undefined : 'agent'" :class="[cell ? ['cell-view', { active }] : 'view', { 'phone-chrome': compactPhone }]" :style="cell ? undefined : viewStyle" :data-pane="cell ? paneId : undefined"
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
        <UButton
          v-if="!cell" id="btnBack" icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back"
          :aria-label="t('Back')" @click="goBack"
        />
        <PhoneIdentity v-if="compactPhone && pane" :pane="pane" :workspace="workspace" @overview="openPlan" />
        <div v-else class="agent-head">
          <div class="agent-title"><AlfredEmblem v-if="isAlfredPane(pane)" class="head-emblem" /><ProjectBadge v-if="badge" class="head-badge" :text="badge.text" :color="badge.color" />{{ headTitle }} <UIcon v-if="pane && paneNotificationsMuted(pane)" name="i-lucide-bell-off" class="notification-muted" :title="t('Muted')" /></div>
          <div class="agent-meta">
            <!-- No state known yet (startup): nothing rather than "closed". -->
            <StatusPill v-if="pane || herdrState.ok" :pane="pane" kind />
            <OmpContext v-if="pane?.agent === 'omp'" :pane="pane" variant="head" />
            <span v-if="subtitle" class="agent-subtitle">{{ subtitle }}</span>
            <span v-if="command" class="agent-subtitle agent-command">{{ command }}</span>
            <span v-if="tabName" class="agent-subtitle">{{ tabName }}</span>
            <span v-if="machine" class="agent-machine" :class="machine.status" :title="machine.target ? `ssh ${machine.target}` : undefined">
              <UIcon :name="machine.local ? 'i-lucide-server' : 'i-lucide-laptop'" /><span class="machine-inline-name">{{ machineName(machine.key) }}</span><MachineLocalBadge v-if="machine.local" />
            </span>
            <span v-if="where" class="where">{{ where }}</span>
          </div>
        </div>
        <ViewToggle v-if="controls.selector === 'cell'" :mode="mode" @toggle="toggleMode('term')" />
        <div class="agent-actions">
          <ViewToggle v-if="controls.selector === 'header'" :mode="mode" @toggle="toggleMode('term')" />
          <UButton
            v-if="headerAdd && pane && !compactPhone" icon="i-lucide-plus" color="neutral" variant="ghost" size="lg" class="icon-btn"
            :aria-label="t('New tab')" :title="t('New tab')" :disabled="offlineView" @click="newTab(pane.workspace)"
          />
          <button v-if="spaceMap" type="button" class="map-btn" data-testid="space-map" :aria-label="t('Tab map')" :title="t('Tab map')" @click="openSpaceMap">
            <TabMap :layout="spaceMap.layout" :panes="spaceMap.panes" :current="paneId" />
          </button>
          <UTooltip v-if="cell" :text="t('Open alone')">
            <UButton icon="i-lucide-maximize-2" color="neutral" variant="ghost" size="md" class="icon-btn cell-extra" :aria-label="t('Open alone')" :to="panePath(paneId)" />
          </UTooltip>
          <UTooltip v-else-if="inTab && tabEnt && !compactPhone" :text="t('Side by side')" :disabled="!desk">
            <button type="button" class="map-btn" :aria-label="desk ? t('Side by side') : t('Tab overview')" @click="openPlan">
              <TabMap :layout="tabEnt.layout" :panes="tabEnt.panes" :current="paneId" />
            </button>
          </UTooltip>
          <CoordinatorButton v-if="coord && !cell" :c="coord" />
          <UButton
            v-if="controls.term" icon="i-lucide-square-terminal" color="neutral" variant="ghost" size="lg" class="icon-btn mode-btn"
            :class="{ on: mode === 'term' }" :aria-label="t('Terminal')" :aria-pressed="mode === 'term'" @click="toggleMode('term')"
          />
          <UTooltip v-if="paneChat(pane) && (live || cell) && !compactPhone" :text="t('Search')" :kbds="mode === 'chat' ? shortcutKbds('search-chat') : undefined" :disabled="!desk">
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
        @goto-term="setMode('term')" @restored="composer?.focus()" @quote="composer?.focusEnd()" @answered="composer?.focusAnswer($event)" @choose="composer?.sendText($event)" @unanswered="unanswered = $event" @opens="turnOpens = $event" @sent="onSent"
      />
    </div>
    <div v-else-if="mode === 'term' && (!linkShown || offlineView || machineDown)" class="chat-empty offline-terminal"><UIcon name="i-lucide-wifi-off" class="chat-empty-icon" /><p>{{ t('Terminal unavailable offline') }}</p></div>
    <TerminalView
      v-else-if="mode === 'term'" :ctl="ctl" @copying="terminalCopying = $event" :class="enter ? (enter > 0 ? 'enter-next' : 'enter-prev') : undefined" :style="swipeStyle"
    />
    <div v-else class="chat" />
    <div v-if="pane?.agent && !paneChat(pane) && mode === 'term' && !cell && !transcriptNoteHidden" class="terminal-transcript-note dismissible-transcript-note">
      <span>{{ tl('Conversation unavailable for this agent · follow it in the terminal', 'Conversation non disponible pour cet agent · suivi dans le terminal') }}</span>
      <button type="button" :aria-label="t('Hide')" :title="t('Hide')" @click="hideTranscriptNote">×</button>
    </div>

    <InteractiveTerminal v-if="interactionShown" :pane-id="paneId" :active="live" :title="headTitle" @close="closeInteraction" />
    <button v-else-if="(interactive || interactionOpen) && interactionAvailable" type="button" class="interactive-terminal-reopen" @click="reopenInteraction">
      <UIcon name="i-lucide-square-terminal" />{{ tl('Open interactive terminal', 'Ouvrir le terminal interactif') }}
    </button>
    <ChoicesPanel v-if="prompt && !interactionOpen && !interactive && !termShown && linkShown && !offlineView && !machineDown" :pane-id="paneId" :prompt="prompt" :keys="live" />
    <div v-if="keybarToggleShown" class="phone-keybar-controls" :inert="terminalCopying">
      <button type="button" class="phone-keybar-toggle" :class="{ on: phoneKeysOpen }" :aria-label="t('Show or hide terminal keys')" :aria-expanded="phoneKeysOpen" :aria-controls="keybarId"
        @pointerdown.prevent @mousedown.prevent @click.stop="togglePhoneKeys"><UIcon :name="phoneKeysOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" /></button>
    </div>
    <Keybar v-if="keybarShown" :id="keybarId" :inert="terminalCopying" :ctl="ctl" :compact="compactPhone" :terminal="termShown" @keyboard="toggleComposerKeyboard" />
    <UiOpenCard v-if="uiBar" :event="uiBar" @close="uiCard = null" />
    <UiShowCard v-if="showCard" :event="showCard" @close="showCard = null" />
    <Composer v-if="composerShown" ref="composer" :inert="terminalCopying" :pane="pane" :pane-id="paneId" :send-keys="ctl.sendKeys" :conversation="mode === 'chat'" :term-shown="termShown" :esc-stops="!searchOpen && !terminalCopying" :take-back="mode === 'chat'" :unanswered="mode === 'chat' ? unanswered : 0" @sent="onSent" @pointerdown="takeTerminalControl" @keydown="onComposerKey" @show-terminal="setMode('term')" @show-unanswered="chatRef?.gotoUnanswered()" />
    </div>
    </div>
    <AppSheet v-model:open="filesOpen" :title="t('Files')" wide full screen>
      <FilesView v-if="filesOpen && pane" :pane-id="paneId" />
    </AppSheet>
  </section>
</template>

<style scoped>
.dismissible-transcript-note { display: flex; flex: none; align-items: center; gap: 8px; padding: 0 4px 0 12px; }
.dismissible-transcript-note > span { flex: 1; padding: 7px 0; }
.dismissible-transcript-note > button { flex: none; align-self: stretch; min-width: 40px; min-height: 40px; color: var(--muted); font: 22px/1 var(--sans); border-radius: 6px; touch-action: manipulation; }
.dismissible-transcript-note > button:hover, .dismissible-transcript-note > button:focus-visible { color: var(--text); background: var(--line-soft); }
.head-badge { margin-right: var(--badge-gap); }
.head-emblem { display: inline-block; width: 18px; margin-right: var(--badge-gap); vertical-align: -1px; }
</style>
