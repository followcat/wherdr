// Keyboard (computer) on a "Your turn" card with choices (interactive menu,
// permission, numbered question): ↑/↓/Enter/Escape go to the terminal as
// real keys, digits 1-9 choose a numbered option, ←/→ change tabs on a card
// that has some (`tabs`: omp's "Ask" box).
// Capture rule: the card is shown in the active view, no window
// (modal, dropdown menu) is open, and the focus is not in an input
// field that contains text. The message field, focused by default on a
// computer, is empty most of the time: it lets ↑/↓/Enter/Escape
// and digits through (as in the terminal, where a digit picks the option);
// as soon as a letter has been typed there, nothing is taken any more.
// Focus on a button: Enter / Space keep their native effect (the click).
export type CardKey = { kind: 'nav', key: 'up' | 'down' | 'enter' | 'esc' } | { kind: 'digit', n: number } | { kind: 'tab', dir: 1 | -1 }

export interface FocusInfo {
  // Champ de saisie (input texte, textarea, contenteditable).
  editable: boolean
  // … et vide.
  empty: boolean
  // Button, link, checkbox: Enter activates it.
  control: boolean
  // In a window opened on top (dialog, menu, dropdown list).
  overlay: boolean
  // The card's own search field: ↑/↓ stay captured there (a single
  // line, nothing to move), Enter starts the search there.
  own?: boolean
}

export interface KeyInfo { key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean, defaultPrevented?: boolean }

const NAV: Record<string, 'up' | 'down' | 'enter' | 'esc'> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'esc' }

export interface CardKeyOpts { digits: number, enter: boolean, tabs?: boolean }

export function cardKey(e: KeyInfo, f: FocusInfo, opts: CardKeyOpts): CardKey | null {
  if (e.defaultPrevented || e.isComposing) return null
  if (e.ctrlKey || e.metaKey || e.altKey || f.overlay) return null
  const nav = NAV[e.key]
  if (f.own && (nav === 'up' || nav === 'down') && !e.shiftKey) return { kind: 'nav', key: nav }
  if (f.own && nav === 'enter') return null
  if (f.editable && !f.empty) return null
  if (opts.tabs && !f.own && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return { kind: 'tab', dir: e.key === 'ArrowRight' ? 1 : -1 }
  if (nav) {
    if (e.shiftKey) return null
    if (nav === 'enter' && (f.control || !opts.enter)) return null
    return { kind: 'nav', key: nav }
  }
  // By name, or by position outside a text field without Shift: AZERTY's top row types
  // & é " ' ( … there, letters a reply may start with (Shift+digit works everywhere), and
  // QWERTY's Shift+1 is "!".
  const digit = /^[1-9]$/.test(e.key) ? e.key : !e.shiftKey && !f.editable ? /^Digit([1-9])$/.exec(e.code || '')?.[1] : undefined
  if (digit && !f.own) {
    const n = Number(digit)
    return n <= opts.digits ? { kind: 'digit', n } : null
  }
  return null
}

const TEXT_INPUT = /^(?:text|search|email|url|tel|password|number|)$/
export function describeFocus(el: Element | null): FocusInfo {
  const out: FocusInfo = { editable: false, empty: true, control: false, overlay: false }
  if (!el || el === document.body) return out
  // Settings beside the conversation count as a window: their keys stay theirs.
  out.overlay = Boolean(el.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"], .settings-panel'))
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT.test(el.type))) {
    out.editable = true
    out.empty = !el.value
  } else if ((el as HTMLElement).isContentEditable) {
    out.editable = true
    out.empty = !(el.textContent || '').trim()
  } else if (el.closest('button, a[href], select, input, [role="button"], [role="tab"], [role="switch"], summary')) {
    out.control = true
  }
  return out
}

// Listens to the keyboard while `active()`: a single card at a time (the active
// view; side by side, the active cell). Bubble phase: a focused field's own
// keys (search Esc / Enter) go first and are skipped here (defaultPrevented).
export function useCardKeys(active: () => boolean, opts: () => CardKeyOpts & { own?: Element | null }, run: (k: CardKey) => void) {
  function onKey(e: KeyboardEvent) {
    if (!active()) return
    const o = opts()
    const el = document.activeElement
    const k = cardKey(e, { ...describeFocus(el), own: Boolean(o.own && el === o.own) }, o)
    if (!k) return
    e.preventDefault()
    e.stopPropagation()
    run(k)
  }
  onMounted(() => document.addEventListener('keydown', onKey))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
}
