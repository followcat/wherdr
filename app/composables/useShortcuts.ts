// What the keyboard shortcuts of utils/shortcuts.ts do. Two listeners: window in
// the capture phase (chords caught before the terminal), document in the bubbling
// phase (fields, windows and cards that own a key mark it handled; their listeners
// may also run after this one, hence the state read at capture). The pane being viewed
// (`curPane`; side by side, the active cell) registers its own actions: search,
// conversation / terminal, Stop (usePaneShortcuts, AgentView).
import type { Ref } from 'vue'
import { type ShortcutContext, type ShortcutFocus, type ShortcutId, matchShortcut } from '~/utils/shortcuts'
import { describeFocus } from '~/utils/cardKeys'
import { stepAgent, stepTab } from '~/utils/stepNav'

export interface PaneShortcuts {
  searchChat: () => boolean
  toggleTerm: () => boolean
  stop: () => boolean
}
const panes = new Set<{ pane: () => string, live: () => boolean, run: PaneShortcuts }>()
export function usePaneShortcuts(pane: () => string, live: () => boolean, run: PaneShortcuts) {
  const entry = { pane, live, run }
  onMounted(() => panes.add(entry))
  onBeforeUnmount(() => panes.delete(entry))
}

export const shortcutsOpen = ref(false)

function run(id: Exclude<ShortcutId, 'search-all'>, overlay: boolean): boolean {
  // The view registered last wins: the next view of a pane mounts before the previous one leaves.
  let view: PaneShortcuts | undefined
  for (const x of panes) if (x.live() && x.pane() === curPane.value) view = x.run
  const p = herdrState.value.panes.find(x => x.id === curPane.value)
  // Same conditions as the buttons: nothing is created or closed offline.
  const writable = eventsOpen.value && !offlineView.value
  // herdr-core (v3): no tab or editor opening yet; the other shortcuts work as in v2.
  if (id === 'new-tab' || id === 'open-editor') return false
  switch (id) {
    case 'search-chat': return view?.searchChat() ?? false
    case 'toggle-term': return view?.toggleTerm() ?? false
    case 'stop': return view?.stop() ?? false
    case 'prev-agent': return stepAgent(-1)
    case 'next-agent': return stepAgent(1)
    case 'prev-tab': return stepTab(-1)
    case 'next-tab': return stepTab(1)
    case 'new-space':
      if (!writable) return false
      haptic()
      newAgentOpen.value = true
      return true
    case 'close-pane':
      // Confirmation first (closePane), as from the menu.
      if (!writable || !p || paneStale(p)) return false
      closePane(p)
      return true
    case 'settings':
      navigateTo('/settings')
      return true
    case 'notes':
      toggleNotes()
      return true
    case 'help':
      // Over another window: no (the help only closes itself).
      if (overlay && !shortcutsOpen.value) return false
      shortcutsOpen.value = !shortcutsOpen.value
      return true
  }
}

type Layout = NonNullable<ShortcutContext['layout']>

export function useShortcuts(searchOpen: Ref<boolean>) {
  const mac = /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent)
  // Letters printed on the keys (Chromium): ⌘⌥W follows the layout on a Mac (W is KeyZ on
  // AZERTY). Read again when the window gets the focus: the layout may have changed.
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Layout> } }).keyboard
  let layout: Layout | null = null
  const loadLayout = () => { keyboard?.getLayoutMap?.().then((m) => { layout = m }, () => {}) }

  // Focus and windows as the keypress found them, read in the capture phase before any
  // listener changes them: the image viewer closes on Escape without marking it handled,
  // the composer blurs itself, a window state may already be false in the bubbling phase.
  let start: { e: KeyboardEvent, focus: ShortcutFocus } | null = null
  function focusNow(): ShortcutFocus {
    const el = document.activeElement
    const f = describeFocus(el)
    // By state as well as by focus: the global search has no focus trap.
    const overlay = f.overlay || anySheetOpen.value || searchOpen.value || shortcutsOpen.value
    return { editable: f.editable, empty: f.empty, overlay, terminal: Boolean(el?.closest('.xterm')) }
  }
  function onKey(e: KeyboardEvent, phase: 'capture' | 'bubble') {
    // Synthetic keys (HeaderMenu closes its menu with a fake Escape) are not the user's.
    if (!e.isTrusted) return
    const focus = phase === 'bubble' && start?.e === e ? start.focus : focusNow()
    if (phase === 'capture') start = { e, focus }
    const id = matchShortcut(e, focus, { mac, phase, desk: desk.value, layout })
    if (!id) return
    if (id === 'search-all') {
      // Taken even while locked, as before.
      e.preventDefault()
      if (!locked.value) searchOpen.value = !searchOpen.value
      return
    }
    if (locked.value || !run(id, focus.overlay)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onCapture = (e: KeyboardEvent) => onKey(e, 'capture')
  const onBubble = (e: KeyboardEvent) => onKey(e, 'bubble')
  onMounted(() => {
    loadLayout()
    window.addEventListener('focus', loadLayout)
    window.addEventListener('keydown', onCapture, true)
    document.addEventListener('keydown', onBubble)
  })
  onUnmounted(() => {
    window.removeEventListener('focus', loadLayout)
    window.removeEventListener('keydown', onCapture, true)
    document.removeEventListener('keydown', onBubble)
  })
}
