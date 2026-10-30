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

