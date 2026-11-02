import { describe, expect, it } from 'vitest'
import { type KeyInput, type ShortcutContext, type ShortcutFocus, matchShortcut } from '../app/utils/shortcuts'

const body: ShortcutFocus = { editable: false, empty: true, overlay: false, terminal: false }
const field = (text: string): ShortcutFocus => ({ ...body, editable: true, empty: !text })
const term: ShortcutFocus = { ...body, editable: true, empty: true, terminal: true }
const mac: ShortcutContext = { mac: true, phase: 'bubble', desk: true }
const linux: ShortcutContext = { ...mac, mac: false }
const match = (e: KeyInput, f = body, c = mac) => matchShortcut(e, f, c)

describe('matchShortcut', () => {
  it('Mod is ⌘ on macOS and Ctrl elsewhere, never the other one', () => {
    expect(match({ key: 'f', metaKey: true })).toBe('search-chat')
    expect(match({ key: 'f', ctrlKey: true })).toBeNull()
    expect(match({ key: 'f', ctrlKey: true }, body, linux)).toBe('search-chat')
    expect(match({ key: 'f', metaKey: true }, body, linux)).toBeNull()
    expect(match({ key: 'f', metaKey: true, shiftKey: true })).toBeNull()
  })

  it('⌘K keeps accepting either modifier on every platform', () => {
    expect(match({ key: 'k', ctrlKey: true })).toBe('search-all')
    expect(match({ key: 'K', metaKey: true, shiftKey: true }, body, linux)).toBe('search-all')
  })

  it('Mod+Alt letters: by position on macOS (⌥ types another character), by name elsewhere (AltGr)', () => {
    const cap = { ...mac, phase: 'capture' as const }
    expect(match({ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }, body, cap)).toBe('new-space')
    expect(match({ key: '†', code: 'KeyT', metaKey: true, altKey: true }, body, cap)).toBe('new-tab')
    expect(match({ key: '∑', code: 'KeyW', metaKey: true, altKey: true }, body, cap)).toBe('close-pane')
    expect(match({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }, body, cap)).toBe('open-editor')
    expect(match({ key: 'o', code: 'KeyO', metaKey: true, altKey: true }, body, cap)).toBe('open-editor')
    const win = { ...linux, phase: 'capture' as const }
    expect(match({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }, body, win)).toBe('new-space')
    expect(match({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true }, term, win)).toBe('open-editor')
    // Polish layout: AltGr+N types ń, a letter for the field.
    expect(match({ key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true }, field('dzie'), win)).toBeNull()
    // Windows: Ctrl+O alone stays with the browser (⌘O: no Mod+Alt on macOS).
    expect(match({ key: 'o', ctrlKey: true }, term, win)).toBeNull()
    expect(match({ key: 'o', metaKey: true }, term)).toBeNull()
  })

  it('a layout other than QWERTY: the printed letter on a Mac, the position for Cyrillic', () => {
    const cap = { ...mac, phase: 'capture' as const }
    // AZERTY Mac: the key printed W is KeyZ; KeyW prints Z.
    const azerty = { get: (code: string) => ({ KeyZ: 'w', KeyW: 'z', KeyN: 'n' } as Record<string, string>)[code] }
    expect(match({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true }, body, { ...cap, layout: azerty })).toBe('close-pane')
    expect(match({ key: 'Å', code: 'KeyW', metaKey: true, altKey: true }, body, { ...cap, layout: azerty })).toBeNull()
    // Russian layout: Ctrl+F types "а", the key is still F.
    expect(match({ key: 'а', code: 'KeyF', ctrlKey: true }, body, linux)).toBe('search-chat')
  })

  it('Mod+Alt chords are taken before the terminal, in the capture phase only', () => {
    const e = { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }
    expect(match(e, term, { ...linux, phase: 'capture' })).toBe('close-pane')
    expect(match(e, term, linux)).toBeNull()
    expect(match({ key: 'f', metaKey: true }, body, { ...mac, phase: 'capture' })).toBeNull()
  })

  it('Ctrl+` by position, from the terminal too, with Ctrl on macOS', () => {
    expect(match({ key: '²', code: 'Backquote', ctrlKey: true }, term, linux)).toBe('toggle-term')
    expect(match({ key: '`', code: 'Backquote', ctrlKey: true }, field('draft'))).toBe('toggle-term')
    expect(match({ key: '`', code: 'Backquote', metaKey: true })).toBeNull()
    expect(match({ key: '<', code: 'IntlBackslash', ctrlKey: true }, body, linux)).toBeNull()
    expect(match({ key: '§', code: 'IntlBackslash', ctrlKey: true })).toBe('toggle-term')
  })

  it('the terminal keeps keys not meant for it: Escape, Alt+arrows, ⌘F, ?', () => {
    expect(match({ key: 'Escape' }, term)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true }, term)).toBeNull()
    expect(match({ key: 'f', metaKey: true }, term)).toBeNull()
    expect(match({ key: '?', shiftKey: true }, term)).toBeNull()
    expect(match({ key: ',', metaKey: true }, term)).toBe('settings')
  })

  it('text being typed: plain and Alt keys left to the field, Mod chords still work', () => {
    expect(match({ key: 'Escape' }, field(''))).toBe('stop')
    expect(match({ key: 'Escape' }, field('half a sentence'))).toBeNull()
    expect(match({ key: 'ArrowUp', altKey: true }, field(''))).toBe('prev-agent')
    expect(match({ key: 'ArrowUp', altKey: true }, field('line one'))).toBeNull()
    expect(match({ key: '?', shiftKey: true }, field(''))).toBeNull()
    expect(match({ key: '?', shiftKey: true })).toBe('help')
    expect(match({ key: '/', metaKey: true }, field('draft'))).toBe('help')
  })

  it('IME ending in Safari (keyCode 229) and keys without a name (autofill): nothing', () => {
    expect(match({ key: 'Escape', keyCode: 229 }, field(''))).toBeNull()
    expect(match({} as KeyInput)).toBeNull()
  })

  it('open window, composition, already handled: nothing, except what toggles a window', () => {
    const overlay = { ...body, overlay: true }
    expect(match({ key: 'Escape' }, overlay)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true }, overlay)).toBeNull()
    expect(match({ key: 'k', metaKey: true }, overlay)).toBe('search-all')
    expect(match({ key: '/', metaKey: true }, overlay)).toBe('help')
    expect(match({ key: 'Escape', isComposing: true })).toBeNull()
    expect(match({ key: 'Escape', defaultPrevented: true })).toBeNull()
  })

  it('Alt+←/→ switches space tabs, taken before fields and the terminal (browser Back)', () => {
    const cap = { ...linux, phase: 'capture' as const }
    expect(match({ key: 'ArrowLeft', altKey: true }, body, cap)).toBe('prev-tab')
    expect(match({ key: 'ArrowRight', altKey: true }, body, cap)).toBe('next-tab')
    // Capture phase only: the key is eaten before xterm or the browser sees it.
    expect(match({ key: 'ArrowLeft', altKey: true }, body, linux)).toBeNull()
    expect(match({ key: 'ArrowLeft', altKey: true }, term, cap)).toBe('prev-tab')
    expect(match({ key: 'ArrowLeft', altKey: true }, field('typing a draft'), cap)).toBe('prev-tab')
    // A held key keeps stepping; overlays block navigation.
    expect(match({ key: 'ArrowRight', altKey: true, repeat: true }, body, cap)).toBe('next-tab')
    expect(match({ key: 'ArrowRight', altKey: true }, { ...body, overlay: true }, cap)).toBeNull()
    // On macOS too (⌥+←/→), and plain or shifted arrows are untouched.
    const macCap = { ...mac, phase: 'capture' as const }
    expect(match({ key: 'ArrowLeft', altKey: true }, body, macCap)).toBe('prev-tab')
    expect(match({ key: 'ArrowLeft' }, body, macCap)).toBeNull()
    expect(match({ key: 'ArrowLeft', altKey: true, shiftKey: true }, body, macCap)).toBeNull()
  })

  it('held keys repeat agent navigation only', () => {
    expect(match({ key: 'ArrowDown', altKey: true, repeat: true })).toBe('next-agent')
    expect(match({ key: 'Escape', repeat: true })).toBeNull()
    expect(match({ key: 'n', code: 'KeyN', metaKey: true, altKey: true, repeat: true }, body, { ...mac, phase: 'capture' })).toBeNull()
  })

  it('phone layout: only ⌘K', () => {
    const phone = { ...mac, desk: false }
    expect(match({ key: 'k', metaKey: true }, body, phone)).toBe('search-all')
    expect(match({ key: 'Escape' }, body, phone)).toBeNull()
    expect(match({ key: 'f', metaKey: true }, body, phone)).toBeNull()
  })

  it('Board: bare H outside fields and the terminal, computer layout only', () => {
    expect(match({ key: 'h' })).toBe('board')
    expect(match({ key: 'h' }, field(''))).toBeNull()
    expect(match({ key: 'h' }, field('draft'))).toBeNull()
    expect(match({ key: 'h' }, term)).toBeNull()
    expect(match({ key: 'H', shiftKey: true })).toBeNull()
    expect(match({ key: 'h', altKey: true })).toBeNull()
    expect(match({ key: 'h', ctrlKey: true }, body, linux)).toBeNull()
    expect(match({ key: 'h', metaKey: true })).toBeNull()
    expect(match({ key: 'H', altKey: true, shiftKey: true })).toBeNull()
    expect(match({ key: 'h' }, body, { ...mac, desk: false })).toBeNull()
  })
})
