// f32 <-> f16 conversion for the Qwen3-ASR WebGPU worker: the encoder's mel
// input and the decoder's fp16 tensors. Float16Array when the engine has it;
// the manual fallback is bit-exact (round half to even, subnormals, Infinity
// and NaN), so an engine without it converts the same way.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT): q4f32ToF16 /
// q4f16ToF32 — the fallback here adds the subnormal and NaN cases the
// original left out.
//
//   wherdrQwen3.fp16.f32ToF16(Float32Array) -> Uint16Array of f16 bits
//   wherdrQwen3.fp16.f16ToF32(Uint16Array) -> Float32Array

'use strict'

;(() => {
const hasF16 = () => typeof Float16Array !== 'undefined'

// float32 bits -> float16 bits by hand. The 13 dropped mantissa bits round
// the kept part half to even; a carry can push the exponent up to (and into)
// the Infinity encoding.
function f32ToF16Slow(src) {
  const out = new Uint16Array(src.length)
  const f = new Float32Array(1), u = new Uint32Array(f.buffer)
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i]
    const x = u[0]
    const s = (x >>> 16) & 0x8000
    const E = (x >>> 23) & 0xff
    const m = x & 0x7fffff
    if (E === 255) { out[i] = s | (m ? 0x7e00 : 0x7c00); continue } // Inf / NaN
    const e = E - 112 // the f16-biased exponent this value needs
    if (e >= 31) { out[i] = s | 0x7c00; continue } // too big: Infinity
    if (e > 0) {
      let man = m >> 13
      const rem = m & 0x1fff
      if (rem > 0x1000 || (rem === 0x1000 && (man & 1))) man++
      out[i] = man === 0x400 ? s | ((e + 1) << 10) : s | (e << 10) | man
      continue
    }
    // Below 2^-14: an f16 subnormal, f = round(v / 2^-24) = sig >> (126 - E).
    const sig = 0x800000 | m
    const sh = 126 - E
    if (sh > 24) { out[i] = s; continue } // too small: a signed zero
    let fv = sig >>> sh
    const rem = sig & ((1 << sh) - 1)
    const half = 1 << (sh - 1)
    if (rem > half || (rem === half && (fv & 1))) fv++
    out[i] = s | fv // fv may reach 0x400: the smallest normal, same encoding
  }
  return out
}

function f32ToF16(src) {
  if (hasF16()) return new Uint16Array(new Float16Array(src).buffer)
  return f32ToF16Slow(src)
}

function f16ToF32(src) {
  if (hasF16()) return new Float32Array(new Float16Array(src.buffer, src.byteOffset, src.length))
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const h = src[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff
    out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024)
      : e === 31 ? (f ? NaN : s * Infinity)
        : s * Math.pow(2, e - 15) * (1 + f / 1024)
  }
  return out
}

const Q = self.wherdrQwen3 = self.wherdrQwen3 || {}
Q.fp16 = { f32ToF16, f16ToF32 }
})()
