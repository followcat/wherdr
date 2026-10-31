// On-device speech recognition: the model lives in Cache Storage, independent
// of the app's precache — a wherdr update never re-downloads it. "Installed"
// means every file of the selected model is cached; Settings installs/removes,
// Composer's mic button reads `asrInstalled` (dim until true).
//
// Two models are offered (ASR_MODELS): SenseVoice-small — fast, five
// languages — and Qwen3-ASR 0.6B — four times the size, the clearest
// Cantonese output of the bake-off (proper punctuation, real 廣東話
// characters). `asrModelId` picks which one the mic loads.
//
// The worker (public/workers/asr-worker.js) resolves the same URLs through
// the same cache, so a pre-warmed install makes model load offline-capable.
import { computed, ref } from 'vue'

export const ASR_CACHE = 'wherdr-asr-v1'

export interface AsrModelDef {
  base: string
  // Relative file paths under `base` (tokenizer entries keep their subdir).
  files: string[]
  bytes: number // shown in Settings; actual sizes come from content-length
  // Which recognizer config the worker builds.
  kind: 'senseVoice' | 'qwen3Asr'
  // Execution providers the worker tries in order.
  providers: string[]
}

export const ASR_MODELS: Record<string, AsrModelDef> = {
  sensevoice: {
    base: '/models/sensevoice-zh-en-ja-ko-yue-2025-09',
    files: ['model.int8.onnx', 'tokens.txt'],
    bytes: 227 * 1048576,
    kind: 'senseVoice',
    providers: ['cpu'],
  },
  qwen3: {
    base: '/models/qwen3-asr-0.6b-int8',
    files: ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx', 'tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/tokenizer_config.json'],
    bytes: 983 * 1048576,
    kind: 'qwen3Asr',
    // webgpu first — falls back to cpu if the engine rejects it.
    providers: ['webgpu', 'cpu'],
  },
  funasr: {
    base: '/models/funasr-nano-int8',
    files: ['encoder_adaptor.int8.onnx', 'llm.int8.onnx', 'embedding.int8.onnx', 'Qwen3-0.6B/vocab.json', 'Qwen3-0.6B/merges.txt', 'Qwen3-0.6B/tokenizer.json'],
    bytes: 964 * 1048576,
    kind: 'funasrNano',
    providers: ['webgpu', 'cpu'],
  },
  // wsyue (wenetCtc) is intentionally not listed: the wasm build's wenetCtc
  // engine traps on this int8 model (works in native builds), and its niche —
  // Cantonese only, no punctuation — is covered better by funasr/qwen3.
  firered2: {
    base: '/models/fire-red-asr2-ctc-int8',
    files: ['model.int8.onnx', 'tokens.txt'],
    bytes: 741 * 1048576,
    kind: 'fireRedAsrCtc',
    providers: ['webgpu', 'cpu'],
  },
  omnilingual: {
    base: '/models/omnilingual-300m-ctc-int8',
    files: ['model.int8.onnx', 'tokens.txt'],
    bytes: 349 * 1048576,
    kind: 'omnilingual',
    providers: ['cpu'],
  },
  dolphin: {
    base: '/models/dolphin-base-ctc-int8',
    files: ['model.int8.onnx', 'tokens.txt'],
    bytes: 100 * 1048576,
    kind: 'dolphin',
    providers: ['cpu'],
  },
}
export const ASR_MODEL_IDS = Object.keys(ASR_MODELS)

// Cohere Transcribe is registered once its tarball layout is confirmed —
// the engine needs encoder/decoder/tokens and supports 14 languages.

const STORAGE_KEY = 'wherdr-asr-model'
export const asrModelId = ref<string>(ASR_MODEL_IDS[0]!)
if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && ASR_MODELS[saved]) asrModelId.value = saved
}
export function selectAsrModel(id: string) {
  if (!ASR_MODELS[id]) return
  asrModelId.value = id
  try { localStorage.setItem(STORAGE_KEY, id) } catch {}
}

export const asrModel = computed(() => ASR_MODELS[asrModelId.value]!)
export const asrUrls = (id: string = asrModelId.value) => (ASR_MODELS[id]?.files || []).map(f => `${ASR_MODELS[id]!.base}/${f}`)

// Retired model sets — evicted on refresh so leftovers don't squat Cache
// Storage: the streaming zipformer (~200 MB) and the 2024 SenseVoice export
// the 2025-09 one replaces (~230 MB).
const LEGACY_FILES: Record<string, string[]> = {
  '/models/asr-zipformer-zh-en': ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
  '/models/sensevoice-zh-en-ja-ko-yue': ['model.int8.onnx', 'tokens.txt'],
}

// Per-model install state — Settings shows each, the mic reads the selected.
export const asrInstalledBy = ref<Record<string, boolean>>({})
export const asrInstalled = computed(() => Boolean(asrInstalledBy.value[asrModelId.value]))

export async function refreshAsrInstalled(cacheProvider: CacheStorage | undefined = globalThis.caches): Promise<boolean> {
  if (!cacheProvider) { asrInstalledBy.value = {}; return false }
  try {
    // The retired files may sit in any cache — the service worker's
    // network-first cache also stored them when they were fetched.
    for (const name of await cacheProvider.keys()) {
      const cache = await cacheProvider.open(name)
      for (const [base, files] of Object.entries(LEGACY_FILES)) {
        for (const f of files) await cache.delete(`${base}/${f}`).catch(() => {})
      }
    }
  } catch {}
  const map: Record<string, boolean> = {}
  for (const id of ASR_MODEL_IDS) {
    const hits = await Promise.all(asrUrls(id).map(u => cacheProvider.match(u)))
    map[id] = hits.every(Boolean)
  }
  asrInstalledBy.value = map
  return asrInstalled.value
}

export interface AsrProgress { file: string, got: number, total: number, done: number, count: number }

// Downloads every file of a model into the ASR cache. Progress counts whole
// files; per-file byte progress rides along when content-length is known.
export async function installAsr(onProgress?: (p: AsrProgress) => void, cacheProvider: CacheStorage | undefined = globalThis.caches, modelId: string = asrModelId.value): Promise<void> {
  if (!cacheProvider) throw new Error('Cache Storage unavailable')
  const cache = await cacheProvider.open(ASR_CACHE)
  const urls = asrUrls(modelId)
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!
    const file = url.split('/').pop()!
    if (await cacheProvider.match(url)) { onProgress?.({ file, got: 0, total: 0, done: i + 1, count: urls.length }); continue }
    const body = await fetchModelFile(url, file, (got, total) => onProgress?.({ file, got, total, done: i, count: urls.length }))
    await cache.put(url, body)
    onProgress?.({ file, got: 0, total: 0, done: i + 1, count: urls.length })
  }
  await refreshAsrInstalled(cacheProvider)
}

// The ~1 GB model crosses tunnels that drop long transfers, so files are
// pulled in byte-range slices with per-slice retries: progress survives a
// dropped connection instead of restarting from zero. When the server ignores
// Range (older deploys) the whole body is drained in one pass. Slices feed a
// ReadableStream straight into the cached Response — a 750 MB file is never
// assembled in memory.
const DL_CHUNK = 8 * 1024 * 1024

async function refetch(doFetch: () => Promise<Response>): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < 5; i++) {
    try {
      const r = await doFetch()
      if (r.status < 500) return r
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) { lastErr = e }
    await new Promise(r => setTimeout(r, 700 * (i + 1)))
  }
  throw lastErr
}

async function fetchModelFile(url: string, file: string, onGot: (got: number, total: number) => void): Promise<Response> {
  const first = await refetch(() => fetch(url, { headers: { range: `bytes=0-${DL_CHUNK - 1}` } }))
  if (first.status === 206) {
    const total = Number((first.headers.get('content-range') || '').split('/')[1]) || 0
    if (!total) throw new Error(`bad content-range on ${file}`)
    const firstPart = new Uint8Array(await first.arrayBuffer())
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          ctrl.enqueue(firstPart)
          let got = firstPart.byteLength
          onGot(got, total)
          while (got < total) {
            const end = Math.min(got + DL_CHUNK - 1, total - 1)
            const res = await refetch(() => fetch(url, { headers: { range: `bytes=${got}-${end}` } }))
            if (res.status !== 206) throw new Error(`HTTP ${res.status} on ${file} at byte ${got}`)
            const part = new Uint8Array(await res.arrayBuffer())
            if (part.byteLength !== end - got + 1) throw new Error(`short slice on ${file} at byte ${got}`)
            ctrl.enqueue(part)
            got = end + 1
            onGot(got, total)
          }
          ctrl.close()
        } catch (e) { ctrl.error(e) }
      },
    })
    return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total) } })
  }
  if (!first.ok) throw new Error(`HTTP ${first.status} on ${file}`)
  const total = Number(first.headers.get('content-length')) || 0
  if (!first.body) return first
  const reader = first.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        let got = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          ctrl.enqueue(value)
          got += value.length
          onGot(got, total)
        }
        ctrl.close()
      } catch (e) { ctrl.error(e) }
    },
  })
  return new Response(stream, { headers: first.headers })
}

// Removes one model's files (its URLs only — a second model may share the
// cache). `modelId` defaults to the selected one.
export async function removeAsr(cacheProvider: CacheStorage | undefined = globalThis.caches, modelId: string = asrModelId.value): Promise<void> {
  if (cacheProvider) {
    const cache = await cacheProvider.open(ASR_CACHE)
    for (const u of asrUrls(modelId)) await cache.delete(u).catch(() => {})
  }
  await refreshAsrInstalled(cacheProvider)
}
