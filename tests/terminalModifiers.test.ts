import { describe, expect, it } from 'vitest'
import { createCompositionTracker, toggleVirtualModifier, virtualChord, virtualInputAction, virtualInputKey } from '../app/utils/terminalModifiers'

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
  it('recognizes the navigation and control sequences a keyboard can emit', () => {
    expect(virtualInputKey('\x1b[H')).toBe('home')
    expect(virtualInputKey('\x1b[F')).toBe('end')
    expect(virtualInputKey('\x1b[5~')).toBe('pageup')
    expect(virtualInputKey('\x1b[6~')).toBe('pagedown')
    expect(virtualInputKey('\x1b[2~')).toBe('insert')
    expect(virtualInputKey('\x1b[3~')).toBe('delete')
    // Ctrl+\ (byte 28) is the only non-letter control name the key API accepts.
    expect(virtualInputKey('\x1c')).toBe('ctrl+backslash')
  })
  it('classifies armed-modifier input as a key, a paste or unsupported text', () => {
    expect(virtualInputAction('c')).toEqual({ kind: 'key', key: 'c' })
    expect(virtualInputAction('\r')).toEqual({ kind: 'key', key: 'enter' })
    expect(virtualInputAction('\x1b[D')).toEqual({ kind: 'key', key: 'left' })
    expect(virtualInputAction('\x1b[H')).toEqual({ kind: 'key', key: 'home' })
    expect(virtualInputAction('\x1b[3~')).toEqual({ kind: 'key', key: 'delete' })
    expect(virtualInputAction('\x03')).toEqual({ kind: 'key', key: 'ctrl+c' })
    expect(virtualInputAction('\x1c')).toEqual({ kind: 'key', key: 'ctrl+backslash' })
    expect(virtualInputAction('A')).toEqual({ kind: 'key', key: 'shift+a' })
    expect(virtualInputAction('6')).toEqual({ kind: 'key', key: '6' })
    // `-` is the one punctuation name in the grammar herdr-core resolves as a
    // physical key (it supports `ctrl+shift+-`); every other symbol is blocked.
    expect(virtualInputAction('-')).toEqual({ kind: 'key', key: '-' })
    expect(virtualInputAction('\x1b[200~rm example\x1b[201~')).toEqual({ kind: 'paste' })
    expect(virtualInputAction('hello')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('你好')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('é')).toEqual({ kind: 'blocked' })
    // Bytes 29–31 are Ctrl+], Ctrl+^ and Ctrl+_: their chord names cannot pass
    // the key API's validation, so the armed modifier is not applied and the
    // byte goes through as the text it already is.
    expect(virtualInputAction('\x1d')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('\x1e')).toEqual({ kind: 'blocked' })
    expect(virtualInputAction('\x1f')).toEqual({ kind: 'blocked' })
    // Typed punctuation is no better: `]`, `^`, `_` and friends fail the name
    // grammar, and `+` names `plus` which passes it although herdr-core has no
    // such alias — none may be consumed into a rejected named key.
    for (const text of [']', '[', '^', '_', '+', '=', ';', "'", ',', '.', '/', '\\', '`', '!', '@', '#', '$', '%', '&', '*', '(', ')', '{', '}', '|', ':', '"', '<', '>', '?', '~'])
      expect(virtualInputAction(text)).toEqual({ kind: 'blocked' })
  })
  it('canonicalizes and deduplicates armed modifiers on every arrow', () => {
    for (const arrow of ['up', 'down', 'left', 'right']) {
      expect(virtualChord(arrow, [])).toBe(arrow)
      expect(virtualChord(arrow, ['ctrl'])).toBe(`ctrl+${arrow}`)
      expect(virtualChord(arrow, ['alt'])).toBe(`alt+${arrow}`)
      expect(virtualChord(arrow, ['shift'])).toBe(`shift+${arrow}`)
      expect(virtualChord(arrow, ['shift', 'ctrl', 'alt'])).toBe(`ctrl+alt+shift+${arrow}`)
      expect(virtualChord(`ctrl+${arrow}`, ['ctrl', 'alt'])).toBe(`ctrl+alt+${arrow}`)
    }
    // The modifier order is canonical whatever the tap order was.
    expect(virtualChord('a', ['shift', 'alt', 'ctrl'])).toBe('ctrl+alt+shift+a')
    expect(virtualChord('ctrl+backslash', ['ctrl'])).toBe('ctrl+backslash')
    expect(virtualChord('ctrl+c', ['ctrl', 'alt'])).toBe('ctrl+alt+c')
    expect(virtualChord('+', ['ctrl'])).toBe('ctrl+plus')
    expect(virtualChord('pageup', ['alt'])).toBe('alt+pageup')
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
    // A cancelled composition produces no data; once the settle boundary
    // passes, the next real keydown drops the stale flag before its
    // keystroke can be eaten.
    composition.start()
    const cancel = composition.end()
    composition.settle(cancel)
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

  it.each([
    { mods: ['ctrl'], commit: 'a' },
    { mods: ['ctrl'], commit: '好' },
    { mods: ['alt'], commit: 'a' },
  ])('keeps a pending commit through an ordinary keydown inside the finalize window: %o', ({ mods: armed, commit }) => {
    const composition = createCompositionTracker()
    let mods = armed
    // Mirrors useTerminal's onData: a commit clears the armed modifiers like
    // any text; a transportable keystroke spends them as a one-shot chord.
    const action = (d: string) => {
      if (composition.active || composition.takeEnded()) { mods = []; return { text: d } }
      const key = mods.length ? virtualInputKey(d) : null
      if (key) mods = []
      return key ? { key } : { text: d }
    }
    composition.start()
    composition.end()
    // xterm flushes the deferred commit inside its own keydown handler —
    // after this capture listener runs. The flag must survive so the flushed
    // commit stays text and the arrow that triggered the flush stays a key.
    composition.keydown({ keyCode: 37 })
    expect(composition.pending).toBe(true)
    expect(action(commit)).toEqual({ text: commit })
    expect(action('\x1b[D')).toEqual({ text: '\x1b[D' }) // armed modifier spent by the commit
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
