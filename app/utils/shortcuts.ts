// App keyboard shortcuts (computer): one table and a pure matcher, tested without a
// DOM; the actions live in composables/useShortcuts.ts. Choices and constraints:
// docs/product/keyboard-shortcuts.md. "Mod" = ⌘ on macOS, Ctrl elsewhere.
// Keys local to one component (composer, search fields, "Your turn" card,
// lightbox, dividers) stay with that component.

export type ShortcutId = 'search-all' | 'search-chat' | 'toggle-term' | 'stop' | 'prev-agent' | 'next-agent'
  | 'prev-tab' | 'next-tab'
  | 'new-space' | 'new-tab' | 'close-pane' | 'open-editor' | 'settings' | 'board' | 'help'

type Mod = 'mod' | 'ctrl' | 'alt' | 'shift'

interface Shortcut {
  id: ShortcutId
  // Exact modifiers (Shift ignored with `anyShift`: punctuation that needs it on AZERTY).
  mods: Mod[]
  anyShift?: boolean
  // ⌘ or Ctrl on every platform, other modifiers ignored (⌘K, as before the table).
  either?: boolean
  // Key by name (`e.key`, case-insensitive), or by position (`e.code`; `macCodes` on macOS).
  key?: string
  codes?: string[]
  macCodes?: string[]
  // Focus in a text field: always, only if it is empty, never.
  fields: 'any' | 'empty' | 'none'
  // Fires with the focus in the terminal (keys xterm does not send, or `capture`).
  terminal: boolean
  // Fires with a window open (the shortcut that toggles it).
  overlay?: boolean
  // Caught before the terminal (window, capture phase): xterm would send it to the
  // program on Linux (Ctrl+Alt+letter = ESC + control byte).
  capture?: boolean
  // Held key: repeats.
  repeat?: boolean
  // Also on the phone layout (hardware keyboard on a tablet).
  anyLayout?: boolean
  // Keys shown (UKbd / tooltip / help): Nuxt UI names, 'meta' = ⌘ or Ctrl.
  kbds: string[]
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'search-all', mods: [], either: true, key: 'k', fields: 'any', terminal: true, overlay: true, anyLayout: true, kbds: ['meta', 'K'] },
  { id: 'search-chat', mods: ['mod'], key: 'f', fields: 'any', terminal: false, kbds: ['meta', 'F'] },
  // Same as VS Code; by position (² on AZERTY). Chromium on an ISO Mac keyboard reports
  // the key left of 1 as IntlBackslash (elsewhere it is the < key next to Shift).
  { id: 'toggle-term', mods: ['ctrl'], codes: ['Backquote'], macCodes: ['Backquote', 'IntlBackslash'], fields: 'any', terminal: true, kbds: ['ctrl', '`'] },
  { id: 'stop', mods: [], key: 'escape', fields: 'empty', terminal: false, kbds: ['escape'] },
  { id: 'prev-agent', mods: ['alt'], key: 'arrowup', fields: 'empty', terminal: false, repeat: true, kbds: ['alt', 'arrowup'] },
  { id: 'next-agent', mods: ['alt'], key: 'arrowdown', fields: 'empty', terminal: false, repeat: true, kbds: ['alt', 'arrowdown'] },
  // Space tabs (the chips above a pane): previous / next, as shown. Taken
  // before everything — Alt+←/→ is the browser's Back/Forward, so fields and
  // the terminal must not see it either (caught at capture, like Mod+Alt).
  // (macOS: this takes ⌥←/→ word jumps out of text fields — personal fork.)
  { id: 'prev-tab', mods: ['alt'], key: 'arrowleft', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowleft'] },
  { id: 'next-tab', mods: ['alt'], key: 'arrowright', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowright'] },
  // Ctrl/⌘+N, T, W belong to the browser (pages never see them in Chromium).
  { id: 'new-space', mods: ['mod', 'alt'], key: 'n', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'N'] },
  { id: 'new-tab', mods: ['mod', 'alt'], key: 't', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'T'] },
  { id: 'close-pane', mods: ['mod', 'alt'], key: 'w', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'W'] },
  // Current agent folder in its default editor: like the other machine actions, Mod+Alt
  // (chromium.org never lets pages see Mod+N, T or W). O, not E: Firefox and Zen bind
  // ⌘⌥E to the Network Monitor on macOS (Ctrl+Shift+E elsewhere), Zen also uses
  // Ctrl+Alt+E for "Forward workspace"; Mod+Alt+O is free in Firefox, Chromium and Safari
  // (⌘O "Open File" needs no Alt). Caught before the terminal: on Linux Ctrl+Alt+letter
  // would be ESC + the control byte.
  { id: 'open-editor', mods: ['mod', 'alt'], key: 'o', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'O'] },
  { id: 'settings', mods: ['mod'], key: ',', fields: 'any', terminal: true, kbds: ['meta', ','] },
  { id: 'help', mods: ['mod'], anyShift: true, key: '/', fields: 'any', terminal: true, overlay: true, kbds: ['meta', '/'] },
  { id: 'help', mods: [], anyShift: true, key: '?', fields: 'none', terminal: false, overlay: true, kbds: ['?'] },
  // Board: bare H like `?`, never while typing nor in the terminal. Mod+Alt+H is
  // unusable on macOS (⌘⌥H = Hide Others, the page never sees it).
  { id: 'board', mods: [], key: 'h', fields: 'none', terminal: false, kbds: ['H'] },
]

export function shortcutKbds(id: ShortcutId): string[] {
  return SHORTCUTS.find(s => s.id === id)!.kbds
}

// `keyCode` 229: the key that ends an IME composition in Safari (isComposing already false).
export interface KeyInput { key?: string, code?: string, keyCode?: number, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean, defaultPrevented?: boolean, repeat?: boolean }

export interface ShortcutFocus {
  // Text field (the terminal's hidden textarea excepted: `terminal`).
  editable: boolean
  empty: boolean
  // In a window opened on top (dialog, menu, image viewer).
  overlay: boolean
  terminal: boolean
}

// `layout`: the letter each key prints without modifiers (navigator.keyboard, Chromium).
export interface ShortcutContext { mac: boolean, phase: 'capture' | 'bubble', desk: boolean, layout?: { get: (code: string) => string | undefined } | null }

const LETTER = /^[a-z]$/

function keysMatch(s: Shortcut, e: KeyInput, key: string, c: ShortcutContext): boolean {
  const meta = Boolean(e.metaKey)
  const ctrl = Boolean(e.ctrlKey)
  const alt = Boolean(e.altKey)
  if (s.either) {
    if (!meta && !ctrl) return false
  } else {
    if (meta !== (c.mac && s.mods.includes('mod'))) return false
    if (ctrl !== (s.mods.includes('ctrl') || (!c.mac && s.mods.includes('mod')))) return false
    if (alt !== s.mods.includes('alt')) return false
    if (!s.anyShift && Boolean(e.shiftKey) !== s.mods.includes('shift')) return false
  }
  const codes = (c.mac && s.macCodes) || s.codes
  if (codes) return codes.includes(e.code || '')
  if (!LETTER.test(s.key!)) return key === s.key
  // A letter: by name when the key types a Latin letter (⌥ changes it on macOS: ⌥N is a
  // dead key). Otherwise the letter printed on the key, else its position (Cyrillic,
  // AZERTY Mac without the layout map). Never for Ctrl+Alt outside macOS: it is AltGr on
  // Windows, and a letter it types (ń on Polish) is not N.
  if (LETTER.test(key) && !(c.mac && alt)) return key === s.key
  if (!c.mac && ctrl && alt) return false
  const printed = c.layout?.get(e.code || '')
  return printed && LETTER.test(printed) ? printed === s.key : e.code === `Key${s.key!.toUpperCase()}`
}

export function matchShortcut(e: KeyInput, f: ShortcutFocus, c: ShortcutContext): ShortcutId | null {
  if (typeof e.key !== 'string' || e.isComposing || e.keyCode === 229 || (c.phase === 'bubble' && e.defaultPrevented)) return null
  const key = e.key.toLowerCase()
  const s = SHORTCUTS.find(x => Boolean(x.capture) === (c.phase === 'capture') && keysMatch(x, e, key, c))
  if (!s) return null
  if (!c.desk && !s.anyLayout) return null
  if (e.repeat && !s.repeat) return null
  if (f.overlay && !s.overlay) return null
  if (f.terminal) return s.terminal ? s.id : null
  if (f.editable && (s.fields === 'none' || (s.fields === 'empty' && !f.empty))) return null
  return s.id
}
