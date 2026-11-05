import { describe, expect, it } from 'vitest'
import { smoothTouchDefault } from '../app/utils/smoothTouch'

describe('smoothTouchDefault', () => {
  it('defaults on for a coarse-pointer, non-hover device and off on a computer', () => {
    expect(smoothTouchDefault(null, true)).toBe(true)
    expect(smoothTouchDefault(null, false)).toBe(false)
  })
  it('lets a saved choice win over the device default', () => {
    expect(smoothTouchDefault('0', true)).toBe(false)
    expect(smoothTouchDefault('1', false)).toBe(true)
    expect(smoothTouchDefault('1', true)).toBe(true)
    expect(smoothTouchDefault('0', false)).toBe(false)
  })
})
