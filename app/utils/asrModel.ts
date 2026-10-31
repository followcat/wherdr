// On-device speech recognition: the model lives in Cache Storage, independent
// of the app's precache — a wherdr update never re-downloads it. "Installed"
// means every model file is cached; Settings installs/removes, Composer's mic
// button reads `installed` (dim until true).
//
// The worker (public/workers/asr-worker.js) resolves the same URLs through
// the same cache, so a pre-warmed install makes model load offline-capable.
import { ref } from 'vue'

export const ASR_CACHE = 'wherdr-asr-v1'
export const ASR_MODEL = {
  base: '/models/sensevoice-zh-en-ja-ko-yue',
  files: {
    model: 'model.int8.onnx',
    tokens: 'tokens.txt',
  } as Record<string, string>,
  bytes: 234 * 1048576, // shown in Settings; actual sizes come from content-length
}
export const asrUrls = () => Object.values(ASR_MODEL.files).map(f => `${ASR_MODEL.base}/${f}`)

// The retired streaming-zipformer set — evicted on refresh so a leftover
// install doesn't squat ~200 MB of Cache Storage after the SenseVoice switch.
const LEGACY_BASE = '/models/asr-zipformer-zh-en'

// Shared reactive install state — Settings mutates, Composer reads.
export const asrInstalled = ref(false)

export async function refreshAsrInstalled(cacheProvider: CacheStorage | undefined = globalThis.caches): Promise<boolean> {
  if (!cacheProvider) { asrInstalled.value = false; return false }
  try {
    const cache = await cacheProvider.open(ASR_CACHE)
    for (const f of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      await cache.delete(`${LEGACY_BASE}/${f}`).catch(() => {})
    }
  } catch {}
  const hits = await Promise.all(asrUrls().map(u => cacheProvider.match(u)))
  asrInstalled.value = hits.every(Boolean)
  return asrInstalled.value
}

export interface AsrProgress { file: string, got: number, total: number, done: number, count: number }

// Downloads every model file into the ASR cache. Progress counts whole files;
// per-file byte progress rides along when content-length is known.
export async function installAsr(onProgress?: (p: AsrProgress) => void, cacheProvider: CacheStorage | undefined = globalThis.caches): Promise<void> {
  if (!cacheProvider) throw new Error('Cache Storage unavailable')
  const cache = await cacheProvider.open(ASR_CACHE)
  const urls = asrUrls()
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!
    const file = url.split('/').pop()!
    if (await cacheProvider.match(url)) { onProgress?.({ file, got: 0, total: 0, done: i + 1, count: urls.length }); continue }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${file}`)
    const total = Number(res.headers.get('content-length')) || 0
    let body = res
    if (res.body && onProgress) {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.length
        onProgress({ file, got, total, done: i, count: urls.length })
      }
      const buf = new Uint8Array(got)
      let at = 0
      for (const c of chunks) { buf.set(c, at); at += c.length }
      body = new Response(buf, { headers: res.headers })
    }
    await cache.put(url, body)
    onProgress?.({ file, got: total, total, done: i + 1, count: urls.length })
  }
  await refreshAsrInstalled(cacheProvider)
}

export async function removeAsr(cacheProvider: CacheStorage | undefined = globalThis.caches): Promise<void> {
  if (cacheProvider) await cacheProvider.delete(ASR_CACHE)
  asrInstalled.value = false
}
