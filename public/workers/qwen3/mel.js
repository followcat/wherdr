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

// Pack even/odd real samples into a 200-point complex FFT (4 * 2 * 5 * 5),
// then recover the 201 nonnegative bins by conjugate symmetry. Plans and
// workspaces are reused: no trig or allocation inside the frame loop.
function fftPlan(n) {
  const radix = n % 4 === 0 ? 4 : n % 2 === 0 ? 2 : 5, m = n / radix
  const re = new Float64Array(n), im = new Float64Array(n)
  const cr = new Float64Array(n), ci = new Float64Array(n)
  const cos = new Float64Array(n * radix), sin = new Float64Array(n * radix)
  for (let k = 0; k < n; k++) for (let j = 0; j < radix; j++) {
    const a = 2 * Math.PI * j * k / n
    cos[k * radix + j] = Math.cos(a); sin[k * radix + j] = Math.sin(a)
  }
  const child = m > 1 ? fftPlan(m) : null
  return { re, im, run(frame, offset = 0, stride = 1) {
    for (let j = 0; j < radix; j++) {
      if (child) {
        child.run(frame, offset + j * stride, stride * radix)
        cr.set(child.re, j * m); ci.set(child.im, j * m)
      } else {
        cr[j] = frame[2 * (offset + j * stride)]; ci[j] = frame[2 * (offset + j * stride) + 1]
      }
    }
    for (let k = 0; k < n; k++) {
      let r = 0, i = 0
      const at = k % m
      for (let j = 0; j < radix; j++) {
        const c = cos[k * radix + j], s = sin[k * radix + j], b = j * m + at
        r += cr[b] * c + ci[b] * s; i += ci[b] * c - cr[b] * s
      }
      re[k] = r; im[k] = i
    }
  } }
}

const fft = fftPlan(N_FFT / 2)
const w = new Float32Array(N_FFT), cos = new Float64Array(N_FREQS), sin = new Float64Array(N_FREQS)
for (let n = 0; n < N_FFT; n++) w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT)
for (let k = 0; k < N_FREQS; k++) { cos[k] = Math.cos(2 * Math.PI * k / N_FFT); sin[k] = Math.sin(2 * Math.PI * k / N_FFT) }
function realPower(frame, power) {
  fft.run(frame)
  for (let k = 0; k < N_FREQS; k++) {
    const a = k % 200, b = (200 - k) % 200
    const er = (fft.re[a] + fft.re[b]) / 2, ei = (fft.im[a] - fft.im[b]) / 2
    const or = (fft.im[a] + fft.im[b]) / 2, oi = (fft.re[b] - fft.re[a]) / 2
    const re = er + cos[k] * or + sin[k] * oi, im = ei + cos[k] * oi - sin[k] * or
    power[k] = re * re + im * im
  }
}

// Whisper-style log-mel: power spectrum, mel filterbank, log10, global-max
// normalize; dropLastFrame drops the last frame (prompt_config's
// drop_last_frame, pinned true).
function logMel(audio, filters, { dropLastFrame = true } = {}) {
  const nMels = filters?.n_mels
  if (!Number.isInteger(nMels) || nMels <= 0 || !Array.isArray(filters.data)
    || filters.data.length !== nMels || filters.data.some(row => !Array.isArray(row)
      || row.length !== N_FREQS || row.some(v => !Number.isFinite(v)))) {
    throw new Error('Invalid speech model mel filters')
  }
  const fb = new Float32Array(nMels * N_FREQS)
  for (let m = 0; m < nMels; m++) for (let k = 0; k < N_FREQS; k++) fb[m * N_FREQS + k] = filters.data[m][k]
  // Mel triangles are sparse; skip their zero tails without changing sums.
  const starts = [], ends = []
  for (let m = 0; m < nMels; m++) {
    let start = 0, end = N_FREQS
    while (start < end && fb[m * N_FREQS + start] === 0) start++
    while (end > start && fb[m * N_FREQS + end - 1] === 0) end--
    starts.push(start); ends.push(end)
  }
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
    realPower(frame, power)
    for (let m = 0; m < nMels; m++) {
      let acc = 0
      const fb2 = m * N_FREQS
      for (let k = starts[m]; k < ends[m]; k++) acc += fb[fb2 + k] * power[k]
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
