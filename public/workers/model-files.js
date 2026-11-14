// Model-file access shared by the dictation and read-aloud workers: a file comes from
// Cache Storage — a whole entry, or its 8 MB `?chunk=N` slices written by
// app/utils/dictation/modelStore.ts — or streams from the server in
// resumable Range slices when there is no cache. A classic script each
// worker loads with importScripts('/workers/model-files.js'); the API
// lives on self.wherdrModelFiles.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT).
//
//   openFile(url, file, bytes, msg) -> Promise<Response>: the whole
//     cached entry, else the `msg.chunk`-byte slices the cache holds,
//     else a streamed download. The body is never assembled in JS, so a
//     600 MB file keeps the worker's own memory flat. msg.cache = ''
//     streams from the server.
//   streamFile(url, file) -> async generator of Uint8Array slices. Posts
//     { t: 'dl', file, got, total } progress messages as the bytes arrive.
//   cachedSlices(cache, url, file, count) -> async generator of the
//     `url?chunk=i` slices for i < count; a missing slice throws
//     `${file}: not downloaded`.
//   fsWriteStreamed(FS, path, res) -> Promise: a Response's body into the
//     emscripten FS slice by slice.

'use strict'

;(() => {
// Without Cache Storage, model files stream from the server in 8 MB range
// slices: a long single GET through a tunnel or a mobile link dies mid-stream,
// while each slice gets its own retries.
const CHUNK = 8 * 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function refetch(doFetch) {
  let lastErr = null
  for (let i = 0; i < 5; i++) {
    try {
      const r = await doFetch()
      if (r.status < 500) return r
      lastErr = new Error(`HTTP ${r.status}`)
    }
    catch (e) { lastErr = e }
    await sleep(700 * (i + 1))
  }
  throw lastErr
}

// The first request doubles as slice 0 and a range probe: a 206 means the
// server slices; a 200 means it sends the whole file, drained as it comes.
async function* streamFile(url, file) {
  const first = await refetch(() => fetch(url, { headers: { range: `bytes=0-${CHUNK - 1}` } }))
  if (first.status !== 206) {
    if (!first.ok) throw new Error(`fetch ${file}: HTTP ${first.status}`)
    const total = Number(first.headers.get('content-length')) || 0
    const reader = first.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      got += value.length
      postMessage({ t: 'dl', file, got, total })
      yield value
    }
  }
  const total = Number((first.headers.get('content-range') || '').split('/')[1]) || 0
  if (!total) throw new Error(`fetch ${file}: bad content-range`)
  const firstPart = new Uint8Array(await first.arrayBuffer())
  let got = firstPart.byteLength
  postMessage({ t: 'dl', file, got, total })
  yield firstPart
  while (got < total) {
    const end = Math.min(got + CHUNK - 1, total - 1)
    const res = await refetch(() => fetch(url, { headers: { range: `bytes=${got}-${end}` } }))
    if (res.status !== 206) throw new Error(`fetch ${file}: HTTP ${res.status} at byte ${got}`)
    const part = new Uint8Array(await res.arrayBuffer())
    if (part.byteLength !== end - got + 1) throw new Error(`fetch ${file}: short slice at byte ${got}`)
    got = end + 1
    postMessage({ t: 'dl', file, got, total })
    yield part
  }
}

// A Response for `url`, never assembled in JS: its slices from the cache
// (or one whole entry, as F2 kept files), else streamed from the server.
async function openFile(url, file, bytes, msg) {
  const cache = msg.cache && self.caches ? await caches.open(msg.cache) : null
  const whole = cache && await cache.match(url)
  if (whole) return whole
  const gen = cache ? cachedSlices(cache, url, file, Math.max(1, Math.ceil(bytes / msg.chunk))) : streamFile(url, file)
  return new Response(new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await gen.next()
      if (done) ctrl.close()
      else ctrl.enqueue(value)
    },
  }))
}

async function* cachedSlices(cache, url, file, count) {
  for (let i = 0; i < count; i++) {
    const hit = await cache.match(`${url}?chunk=${i}`)
    if (!hit) throw new Error(`${file}: not downloaded`)
    yield new Uint8Array(await hit.arrayBuffer())
  }
}

// A file into the emscripten FS slice by slice: the weights must live in the
// WASM heap anyway, but no second whole copy is held in JS (a whole-file
// writeFile got a phone tab killed, in followcat's tests).
async function fsWriteStreamed(FS, path, res) {
  const fd = FS.open(path, 'w')
  const reader = res.body.getReader()
  let off = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      FS.write(fd, value, 0, value.length, off)
      off += value.length
    }
  }
  finally { FS.close(fd) }
}

self.wherdrModelFiles = { openFile, streamFile, cachedSlices, fsWriteStreamed }
})()
