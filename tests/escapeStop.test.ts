import { describe, expect, it } from 'vitest'
import { ESC_CONFIRM_MS, pressEscape } from '../app/utils/escapeStop'

describe('Escape stops a working agent on the second press only', () => {
  it('one stray Escape only arms', () => {
    const arm = { at: null }
    expect(pressEscape(arm, 1000)).toBe(false)
  })

  it('a second press within the delay stops', () => {
    const arm = { at: null }
    pressEscape(arm, 1000)
    expect(pressEscape(arm, 1000 + ESC_CONFIRM_MS - 1)).toBe(true)
  })

  it('a second press after the delay arms again instead', () => {
    const arm = { at: null }
    pressEscape(arm, 1000)
    expect(pressEscape(arm, 1000 + ESC_CONFIRM_MS)).toBe(false)
    expect(pressEscape(arm, 1000 + ESC_CONFIRM_MS + 100)).toBe(true)
  })

  it('a third press after a stop arms again', () => {
    const arm = { at: null }
    pressEscape(arm, 0)
    expect(pressEscape(arm, 100)).toBe(true)
    expect(pressEscape(arm, 200)).toBe(false)
  })

  it('a clock going back does not count as a quick second press', () => {
    const arm = { at: null }
    pressEscape(arm, 5000)
    expect(pressEscape(arm, 4000)).toBe(false)
  })
})
