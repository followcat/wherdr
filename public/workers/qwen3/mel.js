// Log-mel features for the Qwen3-ASR encoder: reflect-padded frames
// (n_fft 400, hop 160), a 201-bin power spectrum, the mel filterbank of
// mel_filters.json, log10 and global-max normalization, the last frame
// dropped per prompt_config's drop_last_frame: logMel's option, pinned true.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT): q4LogMel — with the
// short-input edges defined: a take under one hop (160 samples) is
// zero-padded to a frame, and the reflect pad repeats the edge sample
// below pad + 2 samples (the original read out of bounds and produced
// NaN).
//
//   wherdrQwen3.mel.logMel(Float32Array pcm, filters, { dropLastFrame }?)
//     -> { data, nMels, T }; dropLastFrame defaults true (the pinned
//     prompt_config's drop_last_frame).
//     filters: parsed mel_filters.json { n_mels, data: number[][] }
//     data:    nMels x T, mel-major; T >= 1 for any input length.

'use strict'

;(() => {
const N_FFT = 400, HOP = 160, N_FREQS = 201

let tables = null
function dftTables() {
  if (tables) return tables
  const cos = new Float32Array(N_FREQS * N_FFT), sin = new Float32Array(N_FREQS * N_FFT)
  for (let k = 0; k < N_FREQS; k++) for (let n = 0; n < N_FFT; n++) {
    const a = 2 * Math.PI * k * n / N_FFT
    cos[k * N_FFT + n] = Math.cos(a)
    sin[k * N_FFT + n] = Math.sin(a)
  }
  const w = new Float32Array(N_FFT)
  for (let n = 0; n < N_FFT; n++) w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT)
  tables = { cos, sin, w }
  return tables
}

// Whisper-style log-mel: power spectrum, mel filterbank, log10, global-max
// normalize; dropLastFrame drops the last frame (prompt_config's
// drop_last_frame, pinned true).
function logMel(audio, filters, { dropLastFrame = true } = {}) {
  const { cos, sin, w } = dftTables()
  const nMels = filters.n_mels
  const fb = new Float32Array(nMels * N_FREQS)
  for (let m = 0; m < nMels; m++) for (let k = 0; k < N_FREQS; k++) fb[m * N_FREQS + k] = filters.data[m][k]
  const pad = N_FFT / 2
  // Below one hop there is no full frame: pad silence to get one.
  const src = audio.length >= HOP ? audio : (() => { const s = new Float32Array(HOP); s.set(audio); return s })()
  const L = src.length
  const padded = new Float32Array(L + 2 * pad)
  // Reflect pad; a short take repeats its edge samples (a pure reflect
  // reads before the start of the array when L < pad + 2).
  for (let i = 0; i < pad; i++) padded[i] = src[Math.min(pad - i, L - 1)]
  padded.set(src, pad)
  for (let i = 0; i < pad; i++) padded[pad + L + i] = src[Math.max(0, L - 2 - i)]
  const nFrames = 1 + Math.floor((padded.length - N_FFT) / HOP), T = nFrames - (dropLastFrame ? 1 : 0)
  const out = new Float32Array(nMels * T), frame = new Float32Array(N_FFT), power = new Float32Array(N_FREQS)
  let gmax = -Infinity
  for (let t = 0; t < T; t++) {
    const off = t * HOP
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[off + n] * w[n]
    for (let k = 0; k < N_FREQS; k++) {
      let re = 0, im = 0
      const b = k * N_FFT
      for (let n = 0; n < N_FFT; n++) { re += frame[n] * cos[b + n]; im -= frame[n] * sin[b + n] }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < nMels; m++) {
      let acc = 0
      const fb2 = m * N_FREQS
      for (let k = 0; k < N_FREQS; k++) acc += fb[fb2 + k] * power[k]
      const v = Math.log10(Math.max(acc, 1e-10))
      out[m * T + t] = v
      if (v > gmax) gmax = v
    }
  }
  const fl = gmax - 8
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], fl) + 4) / 4
  return { data: out, nMels, T }
}

const Q = self.wherdrQwen3 = self.wherdrQwen3 || {}
Q.mel = { N_FFT, HOP, N_FREQS, logMel }
})()
