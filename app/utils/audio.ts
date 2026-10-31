// Linear resample to 16 kHz mono for the ASR worker. Good enough for the
// file-decode bench path; the mic path asks the AudioContext for 16 kHz
// directly and skips this.
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
