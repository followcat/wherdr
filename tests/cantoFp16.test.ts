// public/workers/canto/fp16.js: the f32 <-> f16 bits used by the GPU voice,
// both with the browser's Float16Array (when present) and with the fallback
// conversion. Edge values: signed zero, infinities, NaN, subnormals, the
// largest finite value and the ties that round to even.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(process.cwd(), 'public/workers/canto/fp16.js'), 'utf8')
const F16 = (globalThis as { Float16Array?: new (n: number) => Float32Array }).Float16Array

function load(withFloat16Array: boolean) {
  const ctx: Record<string, unknown> = { Float16Array: withFloat16Array && F16 ? F16 : undefined }
  ctx.self = ctx
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return ctx.self as unknown as { wherdrCantoFp16: {
    f32ToF16: (x: number) => number
    f16ToF32: (b: number) => number
    toF16: (v: ArrayLike<number>) => Uint16Array
    fromF16: (b: Uint16Array) => Float32Array
    hasFloat16Array: () => boolean
  } }
}

describe('the fp16 helpers', () => {
  it('converts the edge values to and from float16 bits', () => {
    const F = load(false).wherdrCantoFp16
    const bits: [number, number][] = [
      [0, 0x0000],
      [-0, 0x8000],
      [1, 0x3c00],
      [-1, 0xbc00],
      [0.5, 0x3800],
      [2, 0x4000],
      [65504, 0x7bff],
      [-65504, 0xfbff],
      [65520, 0x7c00], // rounds up to infinity
      [65519, 0x7bff],
      [Infinity, 0x7c00],
      [-Infinity, 0xfc00],
      [2 ** -24, 0x0001],
      [-(2 ** -24), 0x8001],
      [2 ** -25, 0x0000],
      [2 ** -14, 0x0400],
      [1.0009765625, 0x3c01],
      [0.1, 0x2e66],
      [1 + 2 ** -11, 0x3c00], // tie, 0x3c00 is even
      [1 + 3 * 2 ** -11, 0x3c02], // tie, 0x3c02 is even
    ]
    for (const [value, expected] of bits) expect(F.f32ToF16(value), String(value)).toBe(expected)
    const nan = F.f32ToF16(Number.NaN)
    expect(nan & 0x7c00).toBe(0x7c00)
    expect(Number.isNaN(F.f16ToF32(nan))).toBe(true)
    expect(F.f16ToF32(0x0000)).toBe(0)
    expect(Object.is(F.f16ToF32(0x8000), -0)).toBe(true)
    expect(F.f16ToF32(0x3c00)).toBe(1)
    expect(F.f16ToF32(0x7bff)).toBe(65504)
    expect(F.f16ToF32(0x7c00)).toBe(Infinity)
    expect(F.f16ToF32(0xfc00)).toBe(-Infinity)
    expect(Number.isNaN(F.f16ToF32(0x7e00))).toBe(true)
    expect(F.f16ToF32(0x0001)).toBe(2 ** -24)
    expect(F.f16ToF32(0x0400)).toBe(2 ** -14)
    expect(F.f16ToF32(F.f32ToF16(0.1))).toBe(0.0999755859375)
  })

  it('round-trips arrays with and without Float16Array', () => {
    const values = new Float32Array([0, -0, 1, -1, 0.1, 0.3333, 65504, Infinity, -Infinity, 2 ** -24, 2 ** -25])
    for (const withF16 of [false, true]) {
      if (withF16 && !F16) continue
      const F = load(withF16).wherdrCantoFp16
      expect(F.hasFloat16Array()).toBe(withF16 && !!F16)
      const out = F.fromF16(F.toF16(values))
      expect(Array.from(out)).toEqual([
        0, -0, 1, -1, 0.0999755859375, 0.333251953125, 65504, Infinity, -Infinity, 2 ** -24, 0,
      ])
    }
  })
})
