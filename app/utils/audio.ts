// Linear resample to 16 kHz mono for the ASR worker, one whole buffer: the
// file-decode bench path. The mic path streams through createResampler.
export function resampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000) return src.slice(0)
  const ratio = srcRate / 16000
  const out = new Float32Array(Math.floor(src.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio
    const a = Math.floor(p)
    const b = Math.min(a + 1, src.length - 1)
    out[i] = src[a]! + (src[b]! - src[a]!) * (p - a)
  }
  return out
}

// The same resample, one capture buffer at a time (the mic, when the device
// does not honor the requested 16 kHz context). The position carries over
// from buffer to buffer, so no sample is lost or doubled at the joins:
// resampling each buffer on its own lost a fraction of a sample at every
// join and the take drifted. Upstream's v3 dictation (app/utils/dictation/
// audio.ts) made the same fix.
export function createResampler(srcRate: number): (src: Float32Array) => Float32Array {
  const ratio = srcRate / 16000
  let pos = 0 // next output position, in samples of the coming buffer (>= -1)
  let prev = 0 // last sample of the previous buffer, at position -1
  return (src) => {
    if (ratio === 1) return src.slice(0)
    const n = Math.max(0, Math.ceil((src.length - 1 - pos) / ratio))
    const out = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const p = pos + k * ratio
      const a = Math.floor(p)
      const from = a < 0 ? prev : src[a]!
      out[k] = from + (src[a + 1]! - from) * (p - a)
    }
    if (src.length) {
      pos += n * ratio - src.length
      prev = src[src.length - 1]!
    }
    return out
  }
}
