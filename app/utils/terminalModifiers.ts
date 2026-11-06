export const VIRTUAL_MODIFIERS = ['ctrl', 'alt', 'shift'] as const
export type VirtualModifier = typeof VIRTUAL_MODIFIERS[number]

export function toggleVirtualModifier(current: readonly VirtualModifier[], modifier: VirtualModifier): VirtualModifier[] {
  return current.includes(modifier) ? current.filter(m => m !== modifier) : [...current, modifier]
}

export function virtualChord(key: string, modifiers: readonly VirtualModifier[]): string {
  const parts = (key === '+' ? 'plus' : key).toLowerCase().split('+')
  const base = parts.pop()!
  const selected = new Set([...modifiers, ...parts])
  return [...VIRTUAL_MODIFIERS.filter(m => selected.has(m)), base].join('+')
}

const INPUT_KEYS: Record<string, string> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace', ' ': 'space',
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[Z': 'shift+tab',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[2~': 'insert', '\x1b[3~': 'delete',
}

// Android IMEs may emit text without KeyboardEvents. Only a single ASCII
// key or a recognized terminal key can consume an armed modifier. Composed
// text and pastes remain text, never a sequence of shortcuts.
export function virtualInputKey(data: string): string | null {
  if (Object.hasOwn(INPUT_KEYS, data)) return INPUT_KEYS[data]!
  if (/^[!-~]$/.test(data)) {
    if (data === '+') return 'plus'
    // A typed capital carries the real keyboard's Shift, or Alt+A would be
    // sent as Alt+a to applications that read modifiers separately.
    const lower = data.toLowerCase()
    return lower === data ? lower : `shift+${lower}`
  }
  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (code === 0) return 'ctrl+space'
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`
    // Ctrl+\ is the only non-letter control key whose name the key API
    // accepts; Ctrl+], Ctrl+^ and Ctrl+_ have no representable name.
    if (code === 28) return 'ctrl+backslash'
  }
  return null
}

export type VirtualInputAction = { kind: 'key', key: string } | { kind: 'paste' } | { kind: 'blocked' }

// The server's named-key grammar (server/utils/coreInput.ts): the client must
// never emit a name outside it, and grammar alone is not enough — herdr-core
// resolves `backslash` and `-` as physical keys but has no `plus` alias.
// Punctuation bases like `ctrl+]`, `ctrl+^` and `ctrl+_` fail the grammar.
const WIRE_KEY = /^[a-z0-9+\-]{1,24}$/i
function transportable(key: string): boolean {
  return key.split('+').every(part => WIRE_KEY.test(part)) && key.slice(key.lastIndexOf('+') + 1) !== 'plus'
}

// Armed modifiers turn xterm's data into a key only when the chord name is
// transportable end to end. A bracketed paste is still a paste; anything
// else — composed text, a multi-character write, a typed punctuation key
// (`]`, `^`, `_`, `+`) or a control byte without a valid name (Ctrl+],
// Ctrl+^, Ctrl+_) — keeps its text and reports the chord as not applied
// instead of silently consuming the armed modifiers into a rejected name.
export function virtualInputAction(data: string): VirtualInputAction {
  if (data.startsWith('\x1b[200~')) return { kind: 'paste' }
  const key = virtualInputKey(data)
  return key && transportable(key) ? { kind: 'key', key } : { kind: 'blocked' }
}

// Committed IME text reaches onData exactly like a keystroke. Track the
// composition so its output stays text and never spends an armed modifier
// as a shortcut.
export function createCompositionTracker() {
  // `pending` is the live window's state; `gen` is a monotonic token minted
  // per window. They are separate because the window resets on every
  // resolution path while an old settle callback can still be queued — only
  // the latest token may close the window it armed.
  let active = false, ended = false, pending = false, gen = 0
  return {
    start() { active = true; ended = false },
    // compositionend fires before the committed text reaches onData: the
    // next data event is composition output, whatever it looks like. Returns
    // the generation of the pending-commit window it opens, so a settle armed
    // for an older composition can never clear a newer one's window.
    end() { active = false; ended = true; pending = true; return ++gen },
    // A keydown outside any composition is a real keystroke: drop a stale
    // flag left behind by a cancelled composition that produced no text.
    // Inside the finalize window the key reaches this capture listener before
    // xterm's own keydown handler flushes the pending commit, so the window
    // must outlive that keydown — only settle(gen)/takeEnded own `pending`.
    // Safari's keyCode 229 keydown still belongs to the composition.
    keydown(e?: { isComposing?: boolean, keyCode?: number }) {
      if (!active && !pending && !e?.isComposing && e?.keyCode !== 229) ended = false
    },
    get active() { return active },
    // The deferred-commit flag without consuming it: a caller that refuses an
    // action while a commit is pending must not steal it from the next data.
    get ended() { return ended },
    // A real commit may still be in flight only until xterm's deferred
    // finalize tick after compositionend. A cancelled session produces no
    // data at all, so it stops looking pending once that boundary passes
    // even though `ended` may still be set.
    get pending() { return pending },
    settle(g: number) { if (g === gen) pending = false },
    // The flag is consumed by the first data event after the end, so a
    // cancelled composition cannot swallow a later real keystroke.
    takeEnded() { const t = ended; ended = false; pending = false; return t },
  }
}
