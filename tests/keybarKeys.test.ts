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

describe('navigation through the named-key API', () => {
  it('preserves CSI case and modifiers without requiring a terminal connection', async () => {
    const { virtualNavigationKeys } = await import('../app/utils/keybarKeys')
    expect(virtualNavigationKeys('home')).toEqual(['esc', '[', 'shift+h'])
    expect(virtualNavigationKeys('end')).toEqual(['esc', '[', 'shift+f'])
    expect(virtualNavigationKeys('pageup')).toEqual(['esc', '[', '5', '~'])
    expect(virtualNavigationKeys('pagedown')).toEqual(['esc', '[', '6', '~'])
    expect(virtualNavigationKeys('insert')).toEqual(['esc', '[', '2', '~'])
    expect(virtualNavigationKeys('delete')).toEqual(['esc', '[', '3', '~'])
    expect(virtualNavigationKeys('ctrl+shift+end')).toEqual(['esc', '[', '1', ';', '6', 'shift+f'])
  })
})
