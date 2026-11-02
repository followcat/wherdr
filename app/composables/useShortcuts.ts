// What the keyboard shortcuts of utils/shortcuts.ts do. Two listeners: window in
// the capture phase (chords caught before the terminal), document in the bubbling
// phase (fields, windows and cards that own a key mark it handled; their listeners
// may also run after this one, hence the state read at capture). The pane being viewed
// (`curPane`; side by side, the active cell) registers its own actions: search,
// conversation / terminal, Stop (usePaneShortcuts, AgentView).
import type { Ref } from 'vue'
import { type ShortcutContext, type ShortcutFocus, type ShortcutId, matchShortcut } from '~/utils/shortcuts'
import { openFolderOnMachine } from './useHerdr'
import { describeFocus } from '~/utils/cardKeys'

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

// The next or previous card of the sidebar, as shown, and what a click on it does.
// Collapsed machines, projects and repositories render no cards; the rail only hides them.
function stepAgent(step: 1 | -1): boolean {
  const cards = [...document.querySelectorAll<HTMLElement>('#home .card[data-pane]')]
  if (!cards.length) return false
  const at = cards.findIndex(c => c.classList.contains('sel'))
  // Nothing selected: from the top (↓) or the bottom (↑). At the ends: nothing, key still taken.
  const next = cards[at < 0 ? (step > 0 ? 0 : cards.length - 1) : at + step]
  next?.click()
  next?.scrollIntoView({ block: 'nearest' })
  return true
}

// The next or previous tab chip of the viewed space, as shown
// (AgentView header, or the TabView strip); the ends stop.
function stepTab(step: 1 | -1): boolean {
  const chips = [...document.querySelectorAll<HTMLElement>('.space-tabs .tab-chip[data-tab]')]
  if (!chips.length) return false
  const at = chips.findIndex(c => c.getAttribute('aria-current') === 'page')
  const next = chips[at < 0 ? (step > 0 ? 0 : chips.length - 1) : at + step]
  next?.click()
  return true
}

function run(id: Exclude<ShortcutId, 'search-all'>, overlay: boolean): boolean {
  // The view registered last wins: the next view of a pane mounts before the previous one leaves.
  let view: PaneShortcuts | undefined
  for (const x of panes) if (x.live() && x.pane() === curPane.value) view = x.run
  const p = herdrState.value.panes.find(x => x.id === curPane.value)
  // Same conditions as the buttons: nothing is created or closed offline.
  const writable = eventsOpen.value && !offlineView.value
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
    case 'new-tab':
      if (!writable || !p || paneStale(p)) return false
      newTab(p.workspace)
      return true
    case 'close-pane':
      // Confirmation first (closePane), as from the menu.
      if (!writable || !p || paneStale(p)) return false
      closePane(p)
      return true
    case 'open-editor': {
      // The agent's folder in its default editor, on the agent's machine: menu
      // entry "Open" with the folder path (openFolderOnMachine toasts errors).
      if (!p || !canOpenOnMachine(p)) return false
      haptic()
      openFolderOnMachine(p)
      return true
    }
    case 'settings':
      navigateTo('/settings')
      return true
    // On the Board already, the router ignores the identical navigation.
    case 'board':
      navigateTo('/board')
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
  function onBubble(e: KeyboardEvent) {
    if (!locked.value && swapShortcut(e)) return
    onKey(e, 'bubble')
  }
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
