// App keyboard shortcuts (computer): one table and a pure matcher, tested without a
// DOM; the actions live in composables/useShortcuts.ts. Choices and constraints:
// docs/product/keyboard-shortcuts.md. "Mod" = ⌘ on macOS, Ctrl elsewhere.
// Keys local to one component (composer, search fields, "Your turn" card,
// lightbox, dividers) stay with that component.

export type ShortcutId = 'search-all' | 'search-chat' | 'toggle-term' | 'stop' | 'prev-agent' | 'next-agent'
  | 'prev-tab' | 'next-tab'
  | 'new-space' | 'new-tab' | 'close-pane' | 'split-right' | 'split-down' | 'open-editor' | 'settings' | 'notes' | 'help'

export type Mod = 'mod' | 'ctrl' | 'alt' | 'shift'

export interface Shortcut {
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
  // HARDWARE Alt+arrows are app navigation in this fork, never text or
  // terminal input: taken at the window before a focused xterm or field could
  // see them, and consumed even with nothing to step to (Alt+←/→ = browser
  // Back/Forward). The virtual keybar's Alt+arrow stays a literal agent chord.
  { id: 'prev-agent', mods: ['alt'], key: 'arrowup', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowup'] },
  { id: 'next-agent', mods: ['alt'], key: 'arrowdown', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowdown'] },
  { id: 'prev-tab', mods: ['alt'], key: 'arrowleft', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowleft'] },
  { id: 'next-tab', mods: ['alt'], key: 'arrowright', fields: 'any', terminal: true, capture: true, repeat: true, kbds: ['alt', 'arrowright'] },
  // Ctrl/⌘+N, T, W belong to the browser (pages never see them in Chromium).
  { id: 'new-space', mods: ['mod', 'alt'], key: 'n', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'N'] },
  { id: 'new-tab', mods: ['mod', 'alt'], key: 't', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'T'] },
  { id: 'close-pane', mods: ['mod', 'alt'], key: 'w', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'W'] },
  // Split the current pane (S for split): a shell to the right, or below with Shift. Caught
  // before the terminal as N, T and W. Not ⌥⌘D: macOS shows or hides the Dock with it.
  { id: 'split-right', mods: ['mod', 'alt'], key: 's', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'S'] },
  { id: 'split-down', mods: ['mod', 'alt', 'shift'], key: 's', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'shift', 'S'] },
  // Current agent folder in its default editor: like the other machine actions, Mod+Alt
  // (chromium.org never lets pages see Mod+N, T or W). O, not E: Firefox and Zen bind
  // ⌘⌥E to the Network Monitor on macOS (Ctrl+Shift+E elsewhere), Zen also uses
  // Ctrl+Alt+E for "Forward workspace"; Mod+Alt+O is free in Firefox, Chromium and Safari
  // (⌘O "Open File" needs no Alt). Caught before the terminal: on Linux Ctrl+Alt+letter
  // would be ESC + the control byte.
  { id: 'open-editor', mods: ['mod', 'alt'], key: 'o', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'O'] },
  { id: 'settings', mods: ['mod'], key: ',', fields: 'any', terminal: true, kbds: ['meta', ','] },
  // Notes (P for pad): Mod+Alt like the other app panels' chords. ⌘⌥P and Ctrl+Alt+P are
  // free in Chromium, Firefox and Safari; caught before the terminal as N, T, W and O.
  { id: 'notes', mods: ['mod', 'alt'], key: 'p', fields: 'any', terminal: true, capture: true, kbds: ['meta', 'alt', 'P'] },
  { id: 'help', mods: ['mod'], anyShift: true, key: '/', fields: 'any', terminal: true, overlay: true, kbds: ['meta', '/'] },
  { id: 'help', mods: [], anyShift: true, key: '?', fields: 'none', terminal: false, overlay: true, kbds: ['?'] },
]

export function tableKbds(table: readonly Shortcut[], id: ShortcutId): string[] {
  return table.find(s => s.id === id)!.kbds
}

// User bindings (Settings › Shortcuts, synced setting `shortcutBindings`): a key by
// name with exact modifiers, replacing the first row of its id. Escape (Stop) and `?`
// stay fixed.
export interface Binding { mods: Mod[], key: string }
export type Bindings = Partial<Record<ShortcutId, Binding>>
export const FIXED_SHORTCUTS: readonly ShortcutId[] = ['stop']
const MODS: Mod[] = ['mod', 'ctrl', 'alt', 'shift']

export function parseBindings(raw: string | null): Bindings {
  const out: Bindings = {}
  try {
    const v: unknown = JSON.parse(raw || '{}')
    for (const [id, b] of Object.entries(v && typeof v === 'object' ? v : {})) {
      const ok = SHORTCUTS.some(s => s.id === id) && !FIXED_SHORTCUTS.includes(id as ShortcutId)
        && typeof b?.key === 'string' && b.key && Array.isArray(b.mods) && b.mods.every((m: unknown) => MODS.includes(m as Mod))
      if (ok) out[id as ShortcutId] = { mods: MODS.filter(m => b.mods.includes(m)), key: b.key.toLowerCase() }
    }
  } catch { /* defaults */ }
  return out
}

export function bindingKbds(b: Binding): string[] {
  const names: Record<Mod, string> = { mod: 'meta', ctrl: 'ctrl', alt: 'alt', shift: 'shift' }
  return [...MODS.filter(m => b.mods.includes(m)).map(m => names[m]), LETTER.test(b.key) ? b.key.toUpperCase() : b.key]
}

export function applyBindings(bindings: Bindings): Shortcut[] {
  const done = new Set<ShortcutId>()
  return SHORTCUTS.map((s) => {
    const b = bindings[s.id]
    if (!b || done.has(s.id)) return s
    done.add(s.id)
    // A chord the terminal would send to its program is caught before it.
    const capture = s.terminal && b.mods.some(m => m !== 'shift')
    return { ...s, mods: b.mods, key: b.key, codes: undefined, macCodes: undefined, either: false, anyShift: false, capture, kbds: bindingKbds(b) }
  })
}

// The keys pressed while recording; null for a lone modifier (keep listening).
export function bindingFromEvent(e: KeyInput, mac: boolean): Binding | null {
  if (!e.key || ['control', 'alt', 'shift', 'meta', 'altgraph', 'dead', 'unidentified'].includes(e.key.toLowerCase()) && !/^Key[A-Z]$/.test(e.code || '')) return null
  if (!mac && e.metaKey) return null
  const mods: Mod[] = []
  if (e.metaKey || (!mac && e.ctrlKey)) mods.push('mod')
  if (mac && e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  // ⌥ or another layout types another character: the letter by position.
  const letter = /^Key([A-Z])$/.exec(e.code || '')
  const key = letter && !LETTER.test(e.key.toLowerCase()) ? letter[1]!.toLowerCase() : e.key.toLowerCase()
  return { mods, key }
}

// Why a binding cannot be used: no Ctrl/Alt/⌘ (it would type), or the browser's own.
const BROWSER = new Set(['mod+n', 'mod+t', 'mod+w', 'mod+q', 'mod+r', 'mod+l', 'mod+c', 'mod+v', 'mod+x', 'mod+z', 'mod+a', 'mod+shift+t', 'mod+shift+n', 'mod+tab', 'f5', 'f11', 'f12'])
export function reservedReason(b: Binding): 'modifier' | 'browser' | null {
  const sig = [...b.mods, b.key].join('+')
  if (BROWSER.has(sig) || ['escape', 'tab', 'enter'].includes(b.key)) return 'browser'
  return b.mods.some(m => m !== 'shift') || /^f\d+$/.test(b.key) ? null : 'modifier'
}

// The other shortcut already on these keys (Ctrl and Mod are one key outside macOS).
export function sameKeys(a: string[], b: string[], mac: boolean): boolean {
  const sig = (k: string[]) => k.map(x => (!mac && x === 'meta' ? 'ctrl' : x.toLowerCase())).sort().join('+')
  return sig(a) === sig(b)
}
export function findConflict(table: readonly Shortcut[], id: ShortcutId, kbds: string[], mac: boolean): ShortcutId | null {
  return table.find(s => s.id !== id && sameKeys(s.kbds, kbds, mac))?.id ?? null
}

// `keyCode` 229: the key that ends an IME composition in Safari (isComposing already false).
// Every Enter that sends or submits checks this first.
export const imeComposing = (e: { isComposing?: boolean, keyCode?: number }) => Boolean(e.isComposing || e.keyCode === 229)

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

export function matchShortcut(e: KeyInput, f: ShortcutFocus, c: ShortcutContext, table: readonly Shortcut[] = SHORTCUTS): ShortcutId | null {
  if (typeof e.key !== 'string' || imeComposing(e) || (c.phase === 'bubble' && e.defaultPrevented)) return null
  const key = e.key.toLowerCase()
  const s = table.find(x => Boolean(x.capture) === (c.phase === 'capture') && keysMatch(x, e, key, c))
  if (!s) return null
  if (!c.desk && !s.anyLayout) return null
  if (e.repeat && !s.repeat) return null
  if (f.overlay && !s.overlay) return null
  if (f.terminal) return s.terminal ? s.id : null
  if (f.editable && (s.fields === 'none' || (s.fields === 'empty' && !f.empty))) return null
  return s.id
}
