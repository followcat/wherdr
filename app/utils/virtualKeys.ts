export const VIRTUAL_MODIFIERS = ['ctrl', 'alt', 'shift', 'super'] as const
export type VirtualModifier = typeof VIRTUAL_MODIFIERS[number]

export function toggleVirtualModifier(current: readonly VirtualModifier[], modifier: VirtualModifier): VirtualModifier[] {
  return current.includes(modifier) ? current.filter(m => m !== modifier) : [...current, modifier]
}

// Keep named keys: Herdr encodes them for the application's keyboard protocol.
export function virtualChord(key: string, modifiers: readonly VirtualModifier[]): string {
  const parts = (key === '+' ? 'plus' : key).toLowerCase().split('+')
  const base = parts.pop()!
  const selected = new Set([...modifiers, ...parts])
  return [...VIRTUAL_MODIFIERS.filter(m => selected.has(m)), base].join('+')
}

export function displayVirtualChord(chord: string): string {
  const names: Record<string, string> = {
    ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Win/⌘',
    left: '←', right: '→', up: '↑', down: '↓', enter: 'Enter', tab: 'Tab',
    esc: 'Esc', space: 'Space', backspace: '⌫', delete: 'Del', plus: '+',
    home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
  }
  return chord.split('+').map(k => names[k] || k.toUpperCase()).join(' + ')
}

// Herdr 0.9.5's named-key API lacks these standard navigation keys. These
// are the same CSI sequences xterm sends from a physical keyboard.
export function virtualNavigationBytes(chord: string): string | null {
  const parts = chord.split('+')
  const key = parts.pop()!
  const code = ({ home: 'H', end: 'F', insert: '2~', delete: '3~', pageup: '5~', pagedown: '6~' } as Record<string, string>)[key]
  if (!code) return null
  const bits: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 }
  const modifier = 1 + parts.reduce((mask, m) => mask | (bits[m] || 0), 0)
  if (modifier === 1) return `\x1b[${code}`
  return code.endsWith('~') ? `\x1b[${code.slice(0, -1)};${modifier}~` : `\x1b[1;${modifier}${code}`
}

const INPUT_KEYS: Record<string, string> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace', ' ': 'space',
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[2~': 'insert', '\x1b[3~': 'delete', '\x1b[Z': 'shift+tab',
}

// Android IMEs often emit text without a useful KeyboardEvent. Apply a pending
// modifier only to a single ASCII key. Pasted text must stay pasted text;
// a composed word must never turn into a sequence of terminal shortcuts.
export function virtualInputAction(data: string): { kind: 'key', key: string } | { kind: 'paste' } | { kind: 'blocked' } {
  if (data.startsWith('\x1b[200~')) return { kind: 'paste' }
  const named = INPUT_KEYS[data]
  if (named) return { kind: 'key', key: named }
  if (/^[!-~]$/.test(data)) {
    if (data === '+') return { kind: 'key', key: 'plus' }
    // A typed capital carries the real keyboard's Shift, or Alt+A would be
    // sent as Alt+a to applications that read modifiers separately.
    const lower = data.toLowerCase()
    return { kind: 'key', key: lower === data ? lower : `shift+${lower}` }
  }
  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (code === 0) return { kind: 'key', key: 'ctrl+space' }
    if (code >= 1 && code <= 26) return { kind: 'key', key: `ctrl+${String.fromCharCode(code + 96)}` }
    if (code >= 28 && code <= 31) return { kind: 'key', key: `ctrl+${['backslash', ']', '^', '_'][code - 28]}` }
  }
  return { kind: 'blocked' }
}

// Committed IME text reaches onData exactly like a keystroke. Track the
// composition so its output stays text and never spends an armed modifier
// as a shortcut.
export function createCompositionTracker() {
  let active = false, ended = false
  return {
    start() { active = true; ended = false },
    // compositionend fires before the committed text reaches onData: the
    // next data event is composition output, whatever it looks like.
    end() { active = false; ended = true },
    // A keydown outside any composition is a real keystroke: drop a stale
    // flag left behind by a cancelled composition that produced no text.
    // Safari's keyCode 229 keydown still belongs to the composition.
    keydown(e?: { isComposing?: boolean, keyCode?: number }) {
      if (!active && !e?.isComposing && e?.keyCode !== 229) ended = false
    },
    get active() { return active },
    // The flag is consumed by the first data event after the end, so a
    // cancelled composition cannot swallow a later real keystroke.
    takeEnded() { const t = ended; ended = false; return t },
  }
}
