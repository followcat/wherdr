// float32 <-> float16 for the Cantonese GPU voice. The browser's
// Float16Array is used when present; otherwise a small round-to-nearest-even
// conversion produces the raw bits ORT's 'float16' tensors expect.
// A classic script loaded by public/workers/canto-tts-worker.js.
'use strict'

;(() => {
const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

function f32ToF16(value) {
  f32[0] = value
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  const mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 127 + 15
  if (e >= 31) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    const m = mant | 0x800000
    const shift = 14 - e
    let half = m >>> shift
    const rem = m & ((1 << shift) - 1)
    const halfPoint = 1 << (shift - 1)
    if (rem > halfPoint || (rem === halfPoint && (half & 1))) half++
    return sign | half
  }
  let half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++
  return sign | half
}

function f16ToF32(bits) {
  const sign = (bits & 0x8000) ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const mant = bits & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 31) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

function hasFloat16Array() {
  return typeof Float16Array === 'function'
}

// ArrayLike<number> -> Uint16Array of raw float16 bits.
function toF16(values) {
  if (hasFloat16Array()) {
    const f = new Float16Array(values.length)
    for (let i = 0; i < values.length; i++) f[i] = values[i]
    return new Uint16Array(f.buffer)
  }
  const out = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = f32ToF16(values[i])
  return out
}

// Uint16Array of raw float16 bits -> Float32Array.
function fromF16(bits) {
  if (hasFloat16Array()) {
    const f = new Float16Array(bits.buffer, bits.byteOffset, bits.length)
    return Float32Array.from(f)
  }
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) out[i] = f16ToF32(bits[i])
  return out
}

self.wherdrCantoFp16 = { f32ToF16, f16ToF32, toF16, fromF16, hasFloat16Array }
})()
