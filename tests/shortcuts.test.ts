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

  it('the terminal keeps keys not meant for it: Escape, ⌘F, ? — Alt+arrows are app navigation', () => {
    expect(match({ key: 'Escape' }, term)).toBeNull()
    expect(match({ key: 'f', metaKey: true }, term)).toBeNull()
    expect(match({ key: '?', shiftKey: true }, term)).toBeNull()
    expect(match({ key: ',', metaKey: true }, term)).toBe('settings')
    // Taken at the window in the capture phase, before xterm could send them.
    const cap = { ...linux, phase: 'capture' as const }
    expect(match({ key: 'ArrowUp', altKey: true }, term, cap)).toBe('prev-agent')
    expect(match({ key: 'ArrowDown', altKey: true }, term, cap)).toBe('next-agent')
    expect(match({ key: 'ArrowLeft', altKey: true }, term, cap)).toBe('prev-tab')
    expect(match({ key: 'ArrowRight', altKey: true }, term, cap)).toBe('next-tab')
    expect(match({ key: 'ArrowDown', altKey: true }, term)).toBeNull()
    // Ctrl+arrows and bare arrows still belong to the program.
    expect(match({ key: 'ArrowRight', ctrlKey: true }, term, cap)).toBeNull()
    expect(match({ key: 'ArrowRight' }, term, cap)).toBeNull()
  })

  it('text being typed: plain keys left to the field, Mod chords and Alt+arrows still work', () => {
    const cap = { ...mac, phase: 'capture' as const }
    expect(match({ key: 'Escape' }, field(''))).toBe('stop')
    expect(match({ key: 'Escape' }, field('half a sentence'))).toBeNull()
    // Navigation works in a field, empty or not: Alt+↑/↓ are never text.
    expect(match({ key: 'ArrowUp', altKey: true }, field(''), cap)).toBe('prev-agent')
    expect(match({ key: 'ArrowUp', altKey: true }, field('line one'), cap)).toBe('prev-agent')
    expect(match({ key: 'ArrowLeft', altKey: true }, field('draft'), cap)).toBe('prev-tab')
    expect(match({ key: 'ArrowUp', altKey: true }, field(''))).toBeNull()
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
    const cap = { ...mac, phase: 'capture' as const }
    expect(match({ key: 'Escape' }, overlay)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true }, overlay, cap)).toBeNull()
    expect(match({ key: 'k', metaKey: true }, overlay)).toBe('search-all')
    expect(match({ key: '/', metaKey: true }, overlay)).toBe('help')
    expect(match({ key: 'Escape', isComposing: true })).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true, isComposing: true }, body, cap)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true, keyCode: 229 }, body, cap)).toBeNull()
    expect(match({ key: 'Escape', defaultPrevented: true })).toBeNull()
  })

  it('Alt+arrows want exactly Alt: no ⌘, no Ctrl/AltGr, no extra Shift', () => {
    const cap = { ...mac, phase: 'capture' as const }
    const win = { ...linux, phase: 'capture' as const }
    expect(match({ key: 'ArrowUp', altKey: true, shiftKey: true }, body, cap)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true, metaKey: true }, body, cap)).toBeNull()
    expect(match({ key: 'ArrowLeft', altKey: true, ctrlKey: true }, body, cap)).toBeNull()
    // Windows/Linux AltGr reads as Ctrl+Alt: still not the app chord.
    expect(match({ key: 'ArrowRight', altKey: true, ctrlKey: true }, body, win)).toBeNull()
  })

  it('held keys repeat step navigation only', () => {
    const cap = { ...mac, phase: 'capture' as const }
    expect(match({ key: 'ArrowDown', altKey: true, repeat: true }, body, cap)).toBe('next-agent')
    expect(match({ key: 'ArrowRight', altKey: true, repeat: true }, body, cap)).toBe('next-tab')
    expect(match({ key: 'Escape', repeat: true })).toBeNull()
    expect(match({ key: 'n', code: 'KeyN', metaKey: true, altKey: true, repeat: true }, body, cap)).toBeNull()
  })

  it('phone layout: only ⌘K', () => {
    const phone = { ...mac, desk: false }
    const cap = { ...phone, phase: 'capture' as const }
    expect(match({ key: 'k', metaKey: true }, body, phone)).toBe('search-all')
    expect(match({ key: 'Escape' }, body, phone)).toBeNull()
    expect(match({ key: 'f', metaKey: true }, body, phone)).toBeNull()
    expect(match({ key: 'ArrowDown', altKey: true }, body, cap)).toBeNull()
    expect(match({ key: 'ArrowRight', altKey: true }, body, cap)).toBeNull()
  })
})
