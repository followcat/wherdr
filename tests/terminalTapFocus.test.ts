import { describe, expect, it } from 'vitest'
import { mouseFromTouch, tapFocusesTerminal } from '../app/utils/terminalTapFocus'

describe('tapFocusesTerminal', () => {
  it('keeps the keyboard away from a tap on WebKit (every iOS browser)', () => {
    expect(tapFocusesTerminal('Apple Computer, Inc.')).toBe(false)
  })
  it.each(['Google Inc.', '', undefined])('keeps tap-to-type on other engines (%s)', vendor => {
    expect(tapFocusesTerminal(vendor)).toBe(true)
  })
})

describe('mouseFromTouch', () => {
  it('trusts the browser when it reports the source', () => {
    expect(mouseFromTouch(true, 5000)).toBe(true)
    expect(mouseFromTouch(false, 10)).toBe(false)
  })
  it('falls back to a recent touch without sourceCapabilities (WebKit)', () => {
    expect(mouseFromTouch(undefined, 10)).toBe(true)
    expect(mouseFromTouch(undefined, 700)).toBe(false)
  })
})
