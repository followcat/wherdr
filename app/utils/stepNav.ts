// DOM stepping for the Alt+arrow navigation keys (see useShortcuts.ts):
// clicks the card/chip a click would act on, in shown order. The key is
// always consumed — even at the ends or with nothing to step to — because
// unfocused Alt+←/→ would otherwise reach the browser as Back/Forward.

// The next or previous card of the sidebar, as shown, and what a click on it does.
// Collapsed machines, projects and repositories render no cards; the rail only hides them.
export function stepAgent(step: 1 | -1): boolean {
  const cards = [...document.querySelectorAll<HTMLElement>('#home .card[data-pane]')]
  if (!cards.length) return true
  const at = cards.findIndex(c => c.classList.contains('sel'))
  // Nothing selected: from the top (↓) or the bottom (↑). At the ends: nothing, key still taken.
  const next = cards[at < 0 ? (step > 0 ? 0 : cards.length - 1) : at + step]
  next?.click()
  next?.scrollIntoView({ block: 'nearest' })
  return true
}

// The next or previous tab chip of the viewed space, as shown
// (AgentView header, or the TabView strip); the ends stop.
export function stepTab(step: 1 | -1): boolean {
  const chips = [...document.querySelectorAll<HTMLElement>('.space-tabs .tab-chip[data-tab]')]
  if (!chips.length) return true
  const at = chips.findIndex(c => c.getAttribute('aria-current') === 'page')
  const next = chips[at < 0 ? (step > 0 ? 0 : chips.length - 1) : at + step]
  next?.click()
  return true
}
