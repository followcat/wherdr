import type { ScreenInteraction } from '#shared/interactiveScreen'

// One episode lasts until work starts or a stable return to the message field. Cursor motion,
// transient native prompts and missed reads cannot undo a manual dismissal.
export function createInteractionWindow() {
  let kind: ScreenInteraction = 'unknown'
  let since = 0
  let open = false
  let dismissed = false
  const listeners = new Set<() => void>()
  const changed = () => { for (const fn of [...listeners]) fn() }
  return {
    // Re-entry with a field already observed: never mount a stale terminal.
    resume(next: ScreenInteraction) {
      if (next !== 'terminal') open = false
      if (next === 'input' || next === 'working') dismissed = false
      kind = 'unknown'
      return open
    },
    update(next: ScreenInteraction, now: number) {
      if (next !== kind) { kind = next; since = now }
      // A server-owned operation or recovery card must never share input with
      // the TUI. It does not end an episode or undo a manual dismissal.
      if (next === 'managed' || next === 'native' || next === 'working') open = false
      if (next === 'working') dismissed = false
      if (next === 'input' && now - since >= 900) { open = false; dismissed = false }
      if (next === 'unknown' && now - since >= 900) open = false
      if (next === 'terminal' && now - since >= 500 && !dismissed) open = true
      return open
    },
    // When `update` would next answer differently with nothing new observed
    // (the end of a debounce); null: only a new observation can change it.
    deadline(): number | null {
      if (kind === 'terminal' && !open && !dismissed) return since + 500
      if (kind === 'input' && (open || dismissed)) return since + 900
      if (kind === 'unknown' && open) return since + 900
      return null
    },
    dismiss() { dismissed = true; open = false; changed() },
    reopen() { dismissed = false; open = true; changed() },
    // Told of a manual dismissal or reopening, wherever it comes from (a card
    // of the list reopens the window of a view already shown).
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

// Preserve a manual dismissal when switching tabs and returning to the pane.
// Bounded device-local state, without terminal text or user data.
const windows = new Map<string, ReturnType<typeof createInteractionWindow>>()
export function interactionWindowFor(paneId: string) {
  let window = windows.get(paneId)
  if (!window) {
    window = createInteractionWindow()
    if (windows.size >= 64) windows.delete(windows.keys().next().value!)
    windows.set(paneId, window)
  }
  return window
}
