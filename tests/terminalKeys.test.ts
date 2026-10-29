// Keys an xterm terminal leaves to the browser or sends as named keys (issue #45):
// Ctrl+V outside Apple devices must reach the browser's paste, F12 its tools.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindTerminalKeys, isApplePlatform, terminalKeyAction } from '../app/utils/terminalKeys'

type Handler = (e: KeyboardEvent) => boolean

function key(init: Partial<KeyboardEvent> & { key: string }, type = 'keydown') {
  return {
    type, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false,
    preventDefault: vi.fn(), ...init,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function bind(apple: boolean) {
  let handler: Handler = () => true
  const term = { attachCustomKeyEventHandler: (h: Handler) => { handler = h } }
  const send = vi.fn()
  bindTerminalKeys(term as never, send, apple)
  return { handler: (e: KeyboardEvent) => handler(e), send }
}

describe('isApplePlatform', () => {
  it('prefers userAgentData, then navigator.platform', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true)
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false)
    expect(isApplePlatform({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true)
    for (const p of ['iPhone', 'iPad', 'MacIntel']) expect(isApplePlatform({ platform: p })).toBe(true)
    for (const p of ['Win32', 'Linux x86_64', 'Linux aarch64', 'CrOS x86_64', '']) expect(isApplePlatform({ platform: p })).toBe(false)
    expect(isApplePlatform({ userAgentData: { platform: 'Chrome OS' } })).toBe(false)
    for (const p of ['Android', 'Linux']) expect(isApplePlatform({ userAgentData: { platform: p } })).toBe(false)
    expect(isApplePlatform({ userAgentData: { platform: 'iOS' } })).toBe(true)
    // iPadOS presents itself as a Mac.
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true)
    // Unknown platform.
    expect(isApplePlatform({})).toBe(false)
  })

  describe('default: the global navigator', () => {
    // Node 22 has a global navigator whose platform is the host's ("MacIntel" on
    // macOS): the default is tested with a stubbed one, never the real one.
    afterEach(() => { vi.unstubAllGlobals() })

    it('reads an Apple navigator', () => {
      vi.stubGlobal('navigator', { platform: 'MacIntel' })
      expect(isApplePlatform()).toBe(true)
    })

    it('reads another navigator', () => {
      vi.stubGlobal('navigator', { platform: 'Win32', userAgentData: { platform: 'Windows' } })
      expect(isApplePlatform()).toBe(false)
    })

    it('is not Apple without a navigator', () => {
      vi.stubGlobal('navigator', undefined)
      expect(isApplePlatform()).toBe(false)
    })
  })
})

describe('terminalKeyAction', () => {
  it('leaves Ctrl+V to the browser outside Apple devices only', () => {
    expect(terminalKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), false)).toBe('browser')
    expect(terminalKeyAction(key({ key: 'V', code: 'KeyV', ctrlKey: true }), false)).toBe('browser')
    // Cyrillic layout: the key at V still pastes in the browser.
    expect(terminalKeyAction(key({ key: 'м', code: 'KeyV', ctrlKey: true }), false)).toBe('browser')
    // Dvorak: the key labelled V is not at KeyV; the physical KeyV types another letter.
    expect(terminalKeyAction(key({ key: 'v', code: 'Period', ctrlKey: true }), false)).toBe('browser')
    expect(terminalKeyAction(key({ key: 'k', code: 'KeyV', ctrlKey: true }), false)).toBe('xterm')
    // Mac and iPhone: ^V stays a key for the program.
    expect(terminalKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), true)).toBe('xterm')
  })

  it('keeps the other V chords for xterm', () => {
    const v = { key: 'v', code: 'KeyV' }
    expect(terminalKeyAction(key(v), false)).toBe('xterm')
    expect(terminalKeyAction(key({ ...v, ctrlKey: true, shiftKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ ...v, ctrlKey: true, altKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ ...v, ctrlKey: true, metaKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ ...v, metaKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC', ctrlKey: true }), false)).toBe('xterm')
  })

  it('leaves F12 to the browser everywhere, F12 chords to xterm', () => {
    expect(terminalKeyAction(key({ key: 'F12' }), false)).toBe('browser')
    expect(terminalKeyAction(key({ key: 'F12' }), true)).toBe('browser')
    expect(terminalKeyAction(key({ key: 'F12', shiftKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'F11' }), false)).toBe('xterm')
  })

  it('sends Shift+Enter as a named key, not while composing', () => {
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true }), false)).toBe('shift+enter')
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, ctrlKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, isComposing: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'Enter' }), false)).toBe('xterm')
  })
})

describe('bindTerminalKeys', () => {
  it('returns false for Ctrl+V on Windows without cancelling it, so the native paste fires', () => {
    const { handler, send } = bind(false)
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const e = key({ key: 'v', code: 'KeyV', ctrlKey: true }, type)
      expect(handler(e)).toBe(false)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('lets xterm handle Ctrl+V on a Mac', () => {
    const { handler } = bind(true)
    expect(handler(key({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(true)
  })

  it('returns false for F12 without cancelling it', () => {
    const { handler } = bind(false)
    const e = key({ key: 'F12', code: 'F12' })
    expect(handler(e)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('sends Shift+Enter once, on keydown', () => {
    const { handler, send } = bind(false)
    const down = key({ key: 'Enter', shiftKey: true })
    expect(handler(down)).toBe(false)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(handler(key({ key: 'Enter', shiftKey: true }, 'keyup'))).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('shift+enter')
  })

  it('sends Ctrl+Enter and Apple Cmd+Enter once as a named key', () => {
    for (const [apple, modifier] of [[false, 'ctrlKey'], [true, 'ctrlKey'], [true, 'metaKey']] as const) {
      const { handler, send } = bind(apple)
      for (const type of ['keydown', 'keypress', 'keyup']) {
        expect(handler(key({ key: 'Enter', [modifier]: true }, type))).toBe(false)
      }
      expect(send).toHaveBeenCalledExactlyOnceWith('ctrl+enter')
    }
    expect(terminalKeyAction(key({ key: 'Enter', metaKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'Enter', ctrlKey: true, altKey: true }), false)).toBe('xterm')
    expect(terminalKeyAction(key({ key: 'Enter', ctrlKey: true, isComposing: true }), false)).toBe('xterm')
  })

  it('lets xterm handle ordinary keys', () => {
    const { handler } = bind(false)
    expect(handler(key({ key: 'a', code: 'KeyA' }))).toBe(true)
    expect(handler(key({ key: 'Enter' }))).toBe(true)
  })
})
