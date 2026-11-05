import { describe, expect, it } from 'vitest'
import { readUiScale } from '../app/utils/uiScale'
import { scaledTermFont } from '../app/utils/terminalFont'

describe('readUiScale', () => {
  it('keeps an explicit choice', () => {
    expect(readUiScale('md')).toBe('md')
    expect(readUiScale('lg')).toBe('lg')
  })
  it('defaults to Large: missing or unknown values', () => {
    expect(readUiScale(null)).toBe('lg')
    expect(readUiScale('')).toBe('lg')
    expect(readUiScale('huge')).toBe('lg')
    expect(readUiScale('MD')).toBe('lg')
  })
})

describe('scaledTermFont', () => {
  it('enlarges the terminal text by ~15% on a computer at Large', () => {
    expect(scaledTermFont(12, true, 'lg')).toBe(14)
    expect(scaledTermFont(13, true, 'lg')).toBe(15)
    expect(scaledTermFont(20, true, 'lg')).toBe(23)
  })
  it('keeps the device text size at Standard or off the computer layout', () => {
    expect(scaledTermFont(12, true, 'md')).toBe(12)
    expect(scaledTermFont(12, false, 'lg')).toBe(12)
    expect(scaledTermFont(16, false, 'lg')).toBe(16)
    expect(scaledTermFont(20, false, 'md')).toBe(20)
  })
  it('caps at 30 and rounds to the nearest integer', () => {
    expect(scaledTermFont(26, true, 'lg')).toBe(30)
    expect(scaledTermFont(30, true, 'lg')).toBe(30)
    expect(scaledTermFont(11, true, 'lg')).toBe(13)
  })
})
