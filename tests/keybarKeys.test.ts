import { describe, expect, it } from 'vitest'
import { displayVirtualChord, virtualNavigationBytes } from '../app/utils/keybarKeys'

describe('mobile function keys', () => {
  it('encodes navigation keys unavailable through Herdr named keys', () => {
    expect(virtualNavigationBytes('home')).toBe('\x1b[H')
    expect(virtualNavigationBytes('shift+home')).toBe('\x1b[1;2H')
    expect(virtualNavigationBytes('ctrl+delete')).toBe('\x1b[3;5~')
    expect(virtualNavigationBytes('alt+pageup')).toBe('\x1b[5;3~')
    expect(virtualNavigationBytes('ctrl+shift+end')).toBe('\x1b[1;6F')
    expect(virtualNavigationBytes('shift+left')).toBeNull()
  })
  it('announces the chord with readable key names', () => {
    expect(displayVirtualChord('ctrl+shift+left')).toBe('Ctrl + Shift + ←')
    expect(displayVirtualChord('pageup')).toBe('PgUp')
  })
})
