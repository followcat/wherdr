import { describe, expect, it } from 'vitest'
import { displayVirtualChord, toggleVirtualModifier, virtualChord, virtualInputAction, virtualNavigationBytes } from '../app/utils/virtualKeys'

describe('virtual terminal key combinations', () => {
  it('supports answering and leaving a question, tab navigation and multiline input', () => {
    expect(virtualChord('left', ['shift'])).toBe('shift+left')
    expect(virtualChord('right', ['shift'])).toBe('shift+right')
    expect(virtualChord('tab', ['shift'])).toBe('shift+tab')
    expect(virtualChord('enter', ['shift'])).toBe('shift+enter')
  })

  it('stacks modifiers without duplication and preserves named keys and literal plus', () => {
    expect(virtualChord('c', ['shift', 'ctrl'])).toBe('ctrl+shift+c')
    expect(virtualChord('ctrl+c', ['ctrl', 'alt'])).toBe('ctrl+alt+c')
    expect(virtualChord('pageup', ['alt'])).toBe('alt+pageup')
    expect(virtualChord('+', ['ctrl'])).toBe('ctrl+plus')
    expect(virtualChord('f12', ['super'])).toBe('super+f12')
  })

  it('can deselect a modifier without losing the other selections', () => {
    expect(toggleVirtualModifier(['ctrl'], 'shift')).toEqual(['ctrl', 'shift'])
    expect(toggleVirtualModifier(['ctrl', 'shift'], 'ctrl')).toEqual(['shift'])
  })

  it('understands keys emitted by Android text input and terminal input', () => {
    expect(virtualInputAction('C')).toEqual({ kind: 'key', key: 'c' })
    expect(virtualInputAction('\r')).toEqual({ kind: 'key', key: 'enter' })
    expect(virtualInputAction('\x1b[D')).toEqual({ kind: 'key', key: 'left' })
    expect(virtualInputAction('\x03')).toEqual({ kind: 'key', key: 'ctrl+c' })
    expect(virtualInputAction('\x1d')).toEqual({ kind: 'key', key: 'ctrl+]' })
  })

  it('never converts pasted commands or an IME word into modifier shortcuts', () => {
    expect(virtualInputAction('\x1b[200~rm example\x1b[201~')).toEqual({ kind: 'paste' })
    expect(virtualInputAction('hello')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('你好')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('你')).toEqual({ kind: 'blocked' })
  })

  it('shows understandable feedback for the exact combination', () => {
    expect(displayVirtualChord('ctrl+shift+c')).toBe('Ctrl + Shift + C')
    expect(displayVirtualChord('shift+left')).toBe('Shift + ←')
  })

  it('encodes navigation keys missing from Herdr 0.9.5 without pasting escape text', () => {
    expect(virtualNavigationBytes('home')).toBe('\x1b[H')
    expect(virtualNavigationBytes('shift+home')).toBe('\x1b[1;2H')
    expect(virtualNavigationBytes('ctrl+delete')).toBe('\x1b[3;5~')
    expect(virtualNavigationBytes('alt+pageup')).toBe('\x1b[5;3~')
    expect(virtualNavigationBytes('ctrl+shift+end')).toBe('\x1b[1;6F')
    expect(virtualNavigationBytes('shift+left')).toBe(null)
  })
})
