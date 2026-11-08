// The pre-FFT implementation, retained as a slow numerical oracle only.
// Float32 trig tables and intermediate arrays match the original rounding.
const N = 400, F = 201, HOP = 160
const cos = new Float32Array(F * N), sin = new Float32Array(F * N), window = new Float32Array(N)
for (let k = 0; k < F; k++) for (let n = 0; n < N; n++) {
  cos[k * N + n] = Math.cos(2 * Math.PI * k * n / N)
  sin[k * N + n] = Math.sin(2 * Math.PI * k * n / N)
}
for (let n = 0; n < N; n++) window[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N)

export function referenceMel(audio: Float32Array, filters: { n_mels: number, data: number[][] }, dropLastFrame: boolean) {
  const src = audio.length >= HOP ? audio : new Float32Array(HOP)
  if (src !== audio) src.set(audio)
  const padded = new Float32Array(src.length + N)
  for (let i = 0; i < N / 2; i++) padded[i] = src[Math.min(N / 2 - i, src.length - 1)]!
  padded.set(src, N / 2)
  for (let i = 0; i < N / 2; i++) padded[N / 2 + src.length + i] = src[Math.max(0, src.length - 2 - i)]!
  const T = 1 + Math.floor(src.length / HOP) - Number(dropLastFrame)
  const out = new Float32Array(filters.n_mels * T)
  const frame = new Float32Array(N), power = new Float32Array(F)
  const bank = filters.data.map(row => new Float32Array(row))
  let max = -Infinity
  for (let t = 0; t < T; t++) {
    for (let n = 0; n < N; n++) frame[n] = padded[t * HOP + n]! * window[n]!
    for (let k = 0; k < F; k++) {
      let re = 0, im = 0
      for (let n = 0; n < N; n++) { re += frame[n]! * cos[k * N + n]!; im -= frame[n]! * sin[k * N + n]! }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < filters.n_mels; m++) {
      let sum = 0
      for (let k = 0; k < F; k++) sum += bank[m]![k]! * power[k]!
      const v = Math.log10(Math.max(sum, 1e-10))
      out[m * T + t] = v
      max = Math.max(max, v)
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, max - 8) + 4) / 4
  return out
}
