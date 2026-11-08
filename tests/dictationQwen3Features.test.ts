// public/workers/qwen3/{mel,fp16}.js — the Qwen3-ASR worker's numeric
// helpers — loaded in node:vm as classic scripts and driven on synthetic
// fixtures (never the real mel_filters.json).
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { referenceMel } from './qwen3DftReference'

interface Q3 {
  mel: { N_FFT: number, HOP: number, N_FREQS: number, logMel: (a: Float32Array, f: { n_mels: number, data: number[][] }, o?: { dropLastFrame?: boolean }) => { data: Float32Array, nMels: number, T: number } }
  fp16: { f32ToF16: (a: Float32Array) => Uint16Array, f16ToF32: (a: Uint16Array) => Float32Array }
}

// A worker-like global: `self` is the global object; Float16Array can be
// removed to force the manual conversion path.
function load(o: { f16?: boolean } = {}) {
  const ctx = vm.createContext({ TextEncoder, TextDecoder } as Record<string, unknown>)
  ctx.self = ctx
  if (o.f16 === false) ctx.Float16Array = undefined
  for (const f of ['mel.js', 'fp16.js']) {
    vm.runInContext(readFileSync(new URL(`../public/workers/qwen3/${f}`, import.meta.url), 'utf8'), ctx)
  }
  return (ctx.self as { wherdrQwen3: Q3 }).wherdrQwen3
}
const Q = load()
const hasNativeF16 = vm.runInNewContext('typeof Float16Array === "function"') as boolean

describe('the qwen3 log-mel', () => {
  const row = (k: number) => { const r = new Array(201).fill(0); r[k] = 1; return r }
  const filters = { n_mels: 3, data: [row(0), row(1), row(2)] }
  it('refuses malformed mel filterbanks instead of producing NaN features', () => {
    for (const bad of [
      { n_mels: 2, data: [row(0)] },
      { n_mels: 1, data: [row(0).slice(1)] },
      { n_mels: 1, data: [[...row(0), 0]] },
      { n_mels: 0, data: [] },
      { n_mels: 1, data: [row(0).fill(NaN)] },
    ]) {
      expect(() => Q.mel.logMel(new Float32Array(160), bad)).toThrow('Invalid speech model mel filters')
    }
  })
  it('gives finite values and one frame minimum at the edges', () => {
    for (const [len, T] of [[0, 1], [159, 1], [160, 1], [161, 1], [16000, 100]]) {
      const m = Q.mel.logMel(new Float32Array(len).fill(0.5), filters)
      expect(m.T).toBe(T)
      expect(m.data.length).toBe(filters.n_mels * T)
      expect([...m.data].every(Number.isFinite)).toBe(true)
    }
  })
  it('drops the last frame only when asked (the pinned config does)', () => {
    for (const len of [0, 160, 16000]) {
      const keep = Q.mel.logMel(new Float32Array(len).fill(0.5), filters, { dropLastFrame: false })
      const drop = Q.mel.logMel(new Float32Array(len).fill(0.5), filters)
      expect(drop.T).toBe(keep.T - 1)
      expect([...keep.data].every(Number.isFinite)).toBe(true)
    }
    expect(Q.mel.logMel(new Float32Array(16000), filters, { dropLastFrame: false }).T).toBe(101)
  })
  it('matches a hand-computed power spectrum', () => {
    // DC input through the Hann window: power[0] = 200^2, power[1] = 100^2,
    // power[2] ~= 0. log10, then (max(v, gmax - 8) + 4) / 4 with gmax = log10(40000).
    const m = Q.mel.logMel(new Float32Array(160).fill(1), filters)
    expect(m.data[0]).toBeCloseTo((Math.log10(40000) + 4) / 4, 4)
    expect(m.data[1]).toBeCloseTo((Math.log10(10000) + 4) / 4, 4)
    expect(m.data[2]).toBeCloseTo((Math.log10(40000) - 4) / 4, 4) // clamped to the gmax-8 floor
  })
  it('matches the previous DFT across every real-frequency bin and framing edge', () => {
    const bank = { n_mels: 201, data: Array.from({ length: 201 }, (_, k) => row(k)) }
    let seed = 0x12345678
    const noise = Float32Array.from({ length: 1600 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32 - 0.5
    })
    const impulse = new Float32Array(401); impulse[200] = 1
    const tone = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 16000))
    for (const audio of [new Float32Array(), new Float32Array(159).fill(0.5), new Float32Array(1600), impulse, tone, noise]) {
      for (const dropLastFrame of [false, true]) {
        const actual = Q.mel.logMel(audio, bank, { dropLastFrame }).data
        const expected = referenceMel(audio, bank, dropLastFrame)
        expect(actual.length).toBe(expected.length)
        const maxError = actual.reduce((max, v, i) => Math.max(max, Math.abs(v - expected[i]!)), 0)
        expect(maxError).toBeLessThan(2e-5)
      }
    }
  })
})

describe('the qwen3 fp16 conversion', () => {
  const slow = load({ f16: false }).fp16, fast = load().fp16
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && [...a].every((v, i) => Object.is(v, b[i]))
  it.skipIf(!hasNativeF16)('matches Float16Array bit for bit, both directions', () => {
    const f32 = new Float32Array([0, -0, 1, -2.5, 0.1, 65504, -65504, 65519, 65520, 1e9, 6e-5, 6e-8, 3e-8, 1e-9, Infinity, -Infinity, NaN])
    expect(same(slow.f32ToF16(f32), fast.f32ToF16(f32))).toBe(true)
    const all = new Uint16Array(65536)
    for (let i = 0; i < all.length; i++) all[i] = i
    expect(same(slow.f16ToF32(all), fast.f16ToF32(all))).toBe(true)
  })
  it.skipIf(!hasNativeF16)('matches native rounding around every f16 value and seeded f32 bit patterns', () => {
    const all = Uint16Array.from({ length: 65536 }, (_, i) => i)
    const f32 = fast.f16ToF32(all)
    const bits = new Uint32Array(f32.buffer)
    const sweep = new Uint32Array(all.length * 4)
    let seed = 0x12345678
    for (let i = 0; i < all.length; i++) {
      sweep[i * 4] = bits[i] - 1
      sweep[i * 4 + 1] = bits[i]
      sweep[i * 4 + 2] = bits[i] + 1
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      sweep[i * 4 + 3] = seed >>> 0
    }
    const values = new Float32Array(sweep.buffer)
    const actual = slow.f32ToF16(values), expected = fast.f32ToF16(values)
    // JS engines may choose different NaN signs/payloads; all other bits,
    // including signed zero, must agree exactly.
    const nan = (v: number) => (v & 0x7c00) === 0x7c00 && (v & 0x3ff) !== 0
    const mismatch = actual.findIndex((v, i) => v !== expected[i] && !(nan(v) && nan(expected[i]!)))
    expect(mismatch).toBe(-1)
  })
  it('converts the boundary cases: normals, subnormals, Inf, NaN', () => {
    const bits = slow.f32ToF16(new Float32Array([1, -2, 0.5, 65504, 6.103515625e-5, 5.960464477539063e-8, Infinity, -Infinity, NaN]))
    expect([...bits].map(b => b.toString(16))).toEqual(['3c00', 'c000', '3800', '7bff', '400', '1', '7c00', 'fc00', '7e00'])
    expect(same(slow.f32ToF16(new Float32Array([1e-30, -1e-30])), new Uint16Array([0x0000, 0x8000]))).toBe(true) // signed zeros
    expect(Object.is(slow.f16ToF32(new Uint16Array([0x8000]))[0], -0)).toBe(true)
    expect(slow.f16ToF32(new Uint16Array([0x7c00]))[0]).toBe(Infinity)
    expect(slow.f16ToF32(new Uint16Array([0x7e00]))[0]).toBeNaN()
  })
  it('rounds half to even, in the normal and subnormal ranges', () => {
    const one = (v: number) => slow.f32ToF16(new Float32Array([v]))[0]
    expect(one(1 + 0.5 * 2 ** -10)).toBe(0x3c00) // tie -> even down
    expect(one(1 + 0.75 * 2 ** -10)).toBe(0x3c01)
    expect(one(1 + 1.5 * 2 ** -10)).toBe(0x3c02) // tie -> even up
    expect(one(2 ** -25)).toBe(0) // smallest subnormal, tie -> even
    expect(one(2 ** -24 * 0.75)).toBe(1)
    expect(one(2 ** -24 * 1.5)).toBe(2)
    const back = slow.f16ToF32(slow.f32ToF16(new Float32Array([1, -2.5, 65504])))
    expect([...back]).toEqual([1, -2.5, 65504])
  })
})
