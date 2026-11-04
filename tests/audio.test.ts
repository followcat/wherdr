import { describe, expect, it } from 'vitest'
import { createResampler, resampleTo16k } from '../app/utils/audio'

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

describe('createResampler', () => {
  // The mic delivers 4096-sample buffers. Resampling each one on its own lost
  // a fraction of a sample at every join (a third at 48 kHz): the take drifted.
  const ramp = (n: number) => new Float32Array(n).map((_, i) => Math.sin(i / 7))
  for (const rate of [48000, 44100, 22050]) {
    it(`streams ${rate} Hz buffers like one continuous take`, () => {
      const src = ramp(4096 * 10)
      const whole = createResampler(rate)(src)
      const stream = createResampler(rate)
      const parts: number[] = []
      for (let at = 0; at < src.length; at += 4096) parts.push(...stream(src.subarray(at, at + 4096)))
      expect(parts.length).toBe(whole.length)
      expect(parts.length).toBe(Math.ceil((src.length - 1) / (rate / 16000)))
      for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 4)
    })
  }

  it('passes 16 kHz buffers through unchanged', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1])
    expect(createResampler(16000)(src)).toEqual(src)
  })

  it('takes an empty buffer', () => {
    const stream = createResampler(48000)
    expect(stream(new Float32Array(0)).length).toBe(0)
    expect(stream(new Float32Array([0, 3, 6, 9])).length).toBe(1)
  })
})
