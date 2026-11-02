import { describe, expect, it } from 'vitest'
import { resampleTo16k } from '../app/utils/audio'

describe('resampleTo16k', () => {
  it('passes 16 kHz audio through unchanged', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1])
    expect(resampleTo16k(src, 16000)).toEqual(src)
  })

  it('halves a 32 kHz buffer', () => {
    const src = new Float32Array([0, 1, 0, -1, 0, 1])
    const out = resampleTo16k(src, 32000)
    expect(out.length).toBe(3)
    expect([...out]).toEqual([0, 0, 0])
  })

  it('interpolates between samples at 48 kHz', () => {
    const src = new Float32Array(48).fill(0).map((_, i) => i)
    const out = resampleTo16k(src, 48000)
    expect(out.length).toBe(16)
    expect(out[1]).toBeCloseTo(3, 5)
    expect(out[15]).toBeCloseTo(45, 5)
  })

  it('upsamples 8 kHz input', () => {
    const src = new Float32Array([0, 10])
    const out = resampleTo16k(src, 8000)
    expect(out.length).toBe(4)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(5, 5)
    expect(out[3]).toBeCloseTo(10, 1)
  })
})
