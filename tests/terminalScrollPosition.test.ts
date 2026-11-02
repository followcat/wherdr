import { describe, expect, it } from 'vitest'
import { terminalScrollPosition } from '../server/utils/scrollPosition'

describe('terminal scroll coordinates', () => {
  it('preserves the actual touch cell and its modifier mask', () => {
    expect(terminalScrollPosition({ column: 22, row: 12, modifiers: 2 }, 80, 24)).toEqual({ column: 22, row: 12, modifiers: 2 })
  })
  it('keeps old clients scrolling the content area and bounds untrusted coordinates', () => {
    expect(terminalScrollPosition({}, 80, 24)).toEqual({ column: 40, row: 12, modifiers: 0 })
    expect(terminalScrollPosition({ column: -5, row: 999, modifiers: 255 }, 80, 24)).toEqual({ column: 0, row: 23, modifiers: 15 })
    expect(terminalScrollPosition({ column: NaN, row: '12' }, 80, 24)).toEqual({ column: 40, row: 12, modifiers: 0 })
  })
})
