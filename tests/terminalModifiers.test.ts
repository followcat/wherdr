import { describe, expect, it } from 'vitest'
import { createCompositionTracker, toggleVirtualModifier, virtualChord, virtualInputKey } from '../app/utils/terminalModifiers'

describe('one-shot terminal modifiers', () => {
  it('stacks and toggles modifiers without duplicates', () => {
    expect(toggleVirtualModifier(['ctrl'], 'shift')).toEqual(['ctrl', 'shift'])
    expect(toggleVirtualModifier(['ctrl', 'shift'], 'ctrl')).toEqual(['shift'])
    expect(virtualChord('shift+tab', ['ctrl', 'shift'])).toBe('ctrl+shift+tab')
    expect(virtualChord('left', ['shift'])).toBe('shift+left')
    expect(virtualChord('+', ['alt'])).toBe('alt+plus')
  })
  it('recognizes single ASCII and named input without converting composed text or pastes', () => {
    expect(virtualInputKey('c')).toBe('c')
    expect(virtualInputKey('\x03')).toBe('ctrl+c')
    expect(virtualInputKey('\x1b[D')).toBe('left')
    expect(virtualInputKey('\r')).toBe('enter')
    expect(virtualInputKey('你好')).toBeNull()
    expect(virtualInputKey('é')).toBeNull()
    expect(virtualInputKey('hello')).toBeNull()
    for (const text of ['toString', 'constructor', '__proto__']) expect(virtualInputKey(text)).toBeNull()
    expect(virtualInputKey('\x1b[200~hello\x1b[201~')).toBeNull()
  })
  it('keeps the real keyboard Shift in a typed capital', () => {
    expect(virtualInputKey('A')).toBe('shift+a')
    expect(virtualChord(virtualInputKey('A')!, ['alt'])).toBe('alt+shift+a')
    // An armed Shift is not doubled by a typed capital.
    expect(virtualChord(virtualInputKey('A')!, ['shift'])).toBe('shift+a')
    expect(virtualChord(virtualInputKey('A')!, ['ctrl', 'alt'])).toBe('ctrl+alt+shift+a')
  })
  it('marks committed IME text as data across a real composition sequence', () => {
    const composition = createCompositionTracker()
    const action = (d: string, armed: string[]) => {
      if (composition.active || composition.takeEnded()) return { text: d }
      const key = armed.length ? virtualInputKey(d) : null
      return key ? { key } : { text: d }
    }
    composition.start()
    expect(action('a', ['ctrl'])).toEqual({ text: 'a' }) // in-progress output
    composition.end()
    expect(action('a', ['ctrl'])).toEqual({ text: 'a' }) // committed 'a' stays text
    expect(action('a', ['ctrl'])).toEqual({ key: 'a' })  // a real keystroke fires
    // A cancelled composition produces no data; the next real keydown drops
    // the stale flag before its keystroke can be eaten.
    composition.start()
    composition.end()
    composition.keydown()
    expect(action('c', ['ctrl'])).toEqual({ key: 'c' })
    // Safari ends a composition with a keyCode 229 keydown before the
    // committed text: that keydown must not drop the flag.
    composition.start()
    composition.end()
    composition.keydown({ keyCode: 229 })
    expect(action('a', ['ctrl'])).toEqual({ text: 'a' })
    composition.keydown({ isComposing: true })
    composition.keydown({ keyCode: 37 })
    expect(action('\x1b[D', ['alt'])).toEqual({ key: virtualInputKey('\x1b[D') })
  })

  it.each([{ keyCode: 229 }, { isComposing: true }])('keeps the IME commit guard for a composition keydown: %o', event => {
    const composition = createCompositionTracker()
    composition.start()
    composition.end()
    composition.keydown(event)
    expect(composition.takeEnded()).toBe(true)
    expect(composition.takeEnded()).toBe(false)
  })

  it('lets a caller refuse an action while a commit is pending without spending the flag', () => {
    const composition = createCompositionTracker()
    expect(composition.ended).toBe(false)
    composition.start()
    expect(composition.ended).toBe(false)
    composition.end()
    // A refusal must observe the pending commit twice without consuming it:
    // the deferred data still goes through the composition path afterwards.
    expect(composition.ended).toBe(true)
    expect(composition.ended).toBe(true)
    expect(composition.takeEnded()).toBe(true)
    expect(composition.ended).toBe(false)
  })

  it('never reuses a pending generation after the window resets', () => {
    const composition = createCompositionTracker()
    const first = composition.end()
    // The commit resolves the window; the next composition must get a fresh
    // token even though the first settle callback is still queued.
    expect(composition.takeEnded()).toBe(true)
    composition.start()
    const second = composition.end()
    composition.settle(first)
    expect(composition.pending).toBe(true)
    composition.settle(second)
    expect(composition.pending).toBe(false)
  })

  it('keeps the finalize window until its own generation settles, not the guard', () => {
    const composition = createCompositionTracker()
    expect(composition.pending).toBe(false)
    composition.start()
    const first = composition.end()
    expect(composition.pending).toBe(true)
    // A settle armed for an older window cannot clear a newer one's.
    composition.start()
    const second = composition.end()
    composition.settle(first)
    expect(composition.pending).toBe(true)
    composition.settle(second)
    expect(composition.pending).toBe(false)
    // Settling resolves only the pending window: the first-data guard stays
    // armed until real data or an ordinary keydown consumes it.
    expect(composition.ended).toBe(true)
    expect(composition.takeEnded()).toBe(true)
    expect(composition.pending).toBe(false)
  })
})
