import { describe, expect, it } from 'vitest'
import { scaledTermFont } from '../app/utils/terminalFont'

describe('scaledTermFont (Interface size › Large)', () => {
  it('scales ~15% on a computer at Large', () => {
    expect(scaledTermFont(12, true, 'lg')).toBe(14)
    expect(scaledTermFont(13, true, 'lg')).toBe(15)
    expect(scaledTermFont(20, true, 'lg')).toBe(23)
  })

  it('never scales on a phone — even when the device stored Large', () => {
    expect(scaledTermFont(12, false, 'lg')).toBe(12)
    expect(scaledTermFont(20, false, 'lg')).toBe(20)
  })

  it('Standard is the base size everywhere', () => {
    expect(scaledTermFont(13, true, 'md')).toBe(13)
    expect(scaledTermFont(13, false, 'md')).toBe(13)
  })

  it('caps at 30px', () => {
    expect(scaledTermFont(28, true, 'lg')).toBe(30)
  })
})
