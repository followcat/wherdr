import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import VOICES from '../../app/utils/speech/voices.json' with { type: 'json' }
import { CSP_CANTO_TTS_WORKER } from '../../server/utils/csp'
import { serveModelFile } from '../../server/utils/modelFiles'

// public/workers/canto-tts-worker.js in a real Chromium, with the app's worker
// headers (not cross-origin isolated, one WASM thread). The model, G2P data,
// OpenCC tables and ORT 1.23.2 files stream from a local server through
// model-files.js; no Cache Storage is filled here (the store's own tests cover
// it). Skips when the dev model folder is absent (CI has no model):
//   DATA_DIR=data npx playwright test tests/e2e/canto-tts-worker.spec.ts
const voice = VOICES.voices.find(v => v.id === 'canto-nano-int8')!
const modelsDir = path.resolve(process.env.CANTO_MODELS_DIR || path.join(process.env.DATA_DIR || 'data', 'models'))
const runtime = 'runtime/onnxruntime-web-1.23.2/'
const present = existsSync(path.join(modelsDir, voice.dir, 'MOSS-TTS-Nano-cantophon-ONNX/moss_tts_prefill.onnx'))
  && existsSync(path.join(modelsDir, runtime, 'ort.webgpu.min.js'))
const SENTENCE = '今日天氣幾好，我想出街行吓，再去茶餐廳食個早餐。'
const LONG = `${SENTENCE}你食咗飯未呀？如果未食，不如一齊去啦。`
const voiceGpu = VOICES.voices.find(v => v.id === 'canto-nano-fp16-gpu')!
const presentGpu = existsSync(path.join(modelsDir, voiceGpu.dir, 'MOSS-TTS-Nano-cantophon-ONNX/moss_tts_prefill.onnx'))
  && existsSync(path.join(modelsDir, runtime, 'ort.webgpu.min.js'))
  && existsSync(path.join(modelsDir, voiceGpu.textDir!, 'g2p/data/word.bin'))

// Full Chromium (the headless shell has no WebGPU), with the Vulkan ANGLE
// backend that exposes shader-f16 on the Intel Iris Xe. The GPU test skips
// when no adapter with shader-f16 exists (CI, or the headless shell).
test.use({
  channel: 'chromium',
  launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'] },
})

async function startServer() {
  const workers = path.resolve('public/workers')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    let out: Response
    if (url.pathname.startsWith('/models/')) {
      out = await serveModelFile(modelsDir, decodeURIComponent(url.pathname.slice(8)), { method: req.method, range: req.headers.range })
    }
    else if (url.pathname.startsWith('/workers/') && existsSync(path.join(workers, url.pathname.slice(9)))) {
      out = new Response(readFileSync(path.join(workers, url.pathname.slice(9))), {
        headers: { 'content-type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'content-security-policy': CSP_CANTO_TTS_WORKER },
      })
    }
    else out = new Response('<!doctype html><title>canto</title>', { headers: { 'content-type': 'text/html' } })
    res.writeHead(out.status, Object.fromEntries(out.headers))
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://localhost:${(server.address() as AddressInfo).port}/`, close: () => server.close() }
}

const loadArgs = { dir: voice.dir, textBase: voice.textDir ? `/models/${voice.textDir}` : `/models/${voice.dir}`, files: voice.members.map(m => m.path), bytes: voice.members.map(m => m.bytes), runtime }

test('the Canto worker speaks a Cantonese sentence without cross-origin isolation', async ({ page }, testInfo) => {
  test.skip(!present, `no Canto model under ${modelsDir}`)
  test.setTimeout(300_000)
  const server = await startServer()
  try {
    await page.goto(server.url)
    const isolated = await page.evaluate(() => crossOriginIsolated)
    const result = await page.evaluate(async ({ dir, textBase, files, bytes, runtime, text }) => {
      const worker = new Worker('/workers/canto-tts-worker.js')
      const messages: Record<string, unknown>[] = []
      worker.addEventListener('message', (e) => messages.push(e.data))
      const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'ready') { worker.removeEventListener('message', on); resolve(e.data) }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
      })
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, textBase, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
      const loaded = await ready
      const parts: Record<string, unknown>[] = []
      let total = 0
      const done = new Promise<void>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'parts') total = e.data.count
          else if (e.data.t === 'audio') {
            parts.push(e.data)
            if (parts.length === total) { worker.removeEventListener('message', on); resolve() }
          }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
        worker.postMessage({ t: 'speak', id: '1.0', text })
      })
      await done
      let peak = 0
      let samples = 0
      let sampleRate = 0
      let genMs = 0
      let heap = Number(loaded.heap) || 0
      for (const p of parts) {
        const pcm = new Float32Array(p.pcm as ArrayBuffer)
        samples += pcm.length
        sampleRate = Number(p.sampleRate)
        genMs += Number(p.ms) || 0
        heap = Math.max(heap, Number(p.heap) || 0)
        for (const s of pcm) peak = Math.max(peak, Math.abs(s))
      }
      worker.postMessage({ t: 'dispose' })
      return {
        loadMs: loaded.ms,
        threads: loaded.threads,
        total,
        parts: parts.length,
        sampleRate,
        seconds: samples / sampleRate,
        genMs,
        peak,
        maxHeap: heap,
        types: messages.map(m => m.t),
      }
    }, { ...loadArgs, text: SENTENCE })
    const rtf = result.genMs / 1000 / result.seconds
    const mib = (n: number) => `${Math.round(n / 2 ** 20)} MiB`
    const report = `${testInfo.project.name}: load ${result.loadMs} ms, ${result.seconds.toFixed(2)} s in ${result.parts} part(s), generation ${result.genMs} ms (RTF ${rtf.toFixed(2)}), sampleRate ${result.sampleRate}, peak ${result.peak.toFixed(2)}, heap ${mib(Number(result.maxHeap))}`
    console.log(report)
    testInfo.annotations.push({ type: 'canto', description: report })
    expect(isolated).toBe(false)
    expect(result.threads).toBe(1)
    expect(result.sampleRate).toBe(48000)
    expect(result.seconds).toBeGreaterThan(1.5)
    expect(result.parts).toBeGreaterThan(0)
    expect(result.peak).toBeGreaterThan(0.05)
  }
  finally { server.close() }
})

test('stop cancels a synthesis at a word boundary and posts no more audio', async ({ page }) => {
  test.skip(!present, `no Canto model under ${modelsDir}`)
  test.setTimeout(300_000)
  const server = await startServer()
  try {
    await page.goto(server.url)
    const result = await page.evaluate(async ({ dir, textBase, files, bytes, runtime, text }) => {
      const worker = new Worker('/workers/canto-tts-worker.js')
      const ready = new Promise<void>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'ready') { worker.removeEventListener('message', on); resolve() }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
      })
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, textBase, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
      await ready
      let total = 0
      const audio: number[] = []
      const outcome = await new Promise<{ cancelled: boolean }>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'parts') total = e.data.count
          else if (e.data.t === 'audio') {
            audio.push(e.data.part)
            if (audio.length === 1) worker.postMessage({ t: 'cancel', id: '1.0', gen: 1 })
          }
          else if (e.data.t === 'cancelled') {
            // Give the ORT call that was running time to finish; it must not post.
            setTimeout(() => { worker.removeEventListener('message', on); resolve({ cancelled: true }) }, 1500)
          }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
        worker.postMessage({ t: 'speak', id: '1.0', text })
      })
      const afterStop = audio.length
      worker.postMessage({ t: 'dispose' })
      return { total, audio: afterStop, cancelled: outcome.cancelled }
    }, { ...loadArgs, text: LONG })
    expect(result.cancelled).toBe(true)
    expect(result.audio).toBeGreaterThan(0)
    expect(result.audio).toBeLessThan(result.total)
  }
  finally { server.close() }
})

test('stop during a load is acknowledged before the voice is ready', async ({ page }) => {
  test.skip(!present, `no Canto model under ${modelsDir}`)
  test.setTimeout(300_000)
  const server = await startServer()
  try {
    await page.goto(server.url)
    const result = await page.evaluate(async ({ dir, textBase, files, bytes, runtime }) => {
      const worker = new Worker('/workers/canto-tts-worker.js')
      let ready = false
      const outcome = new Promise<{ cancelled: boolean }>((resolve) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'ready') ready = true
          if (e.data.t === 'cancelled') {
            setTimeout(() => { worker.removeEventListener('message', on); resolve({ cancelled: true }) }, 1500)
          }
        }
        worker.addEventListener('message', on)
      })
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, textBase, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
      worker.postMessage({ t: 'cancel', id: 'load', gen: 1 })
      const out = await outcome
      worker.postMessage({ t: 'dispose' })
      return { ...out, ready }
    }, loadArgs)
    expect(result.cancelled).toBe(true)
    expect(result.ready).toBe(false)
  }
  finally { server.close() }
})

test('the GPU voice speaks on WebGPU with shader-f16, CPU I/O and GPU KV', async ({ page }, testInfo) => {
  test.skip(!presentGpu, `no fp16 Canto model under ${modelsDir}`)
  test.setTimeout(900_000)
  const server = await startServer()
  try {
    await page.goto(server.url)
    const support = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter()
      return !!adapter && adapter.features.has('shader-f16')
    })
    test.skip(!support, 'no WebGPU adapter with shader-f16')
    const texts = { short: '今日天氣幾好。', medium: '今日天氣幾好，我想出街行吓，再去茶餐廳食個早餐。', english: '我哋一齊去 IFC food court 食飯。' }
    const result = await page.evaluate(async ({ int8, gpu, texts }) => {
      const runs = [
        { name: 'int8', voice: int8, runner: undefined },
        { name: 'gpu-cpu-io', voice: gpu, runner: gpu.runner },
        { name: 'gpu-gpu-kv', voice: gpu, runner: { ...gpu.runner, kvGpu: true } },
      ]
      const load = (worker: Worker, run: { voice: { dir: string, textDir: string, members: { path: string, bytes: number }[] }, runner: unknown }) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'ready') { worker.removeEventListener('message', on); resolve(e.data) }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
        worker.postMessage({
          t: 'load',
          runtime: '/models/runtime/onnxruntime-web-1.23.2/',
          base: `/models/${run.voice.dir}`,
          textBase: `/models/${run.voice.textDir}`,
          files: run.voice.members.map(m => m.path),
          bytes: run.voice.members.map(m => m.bytes),
          chunk: 8 * 1024 * 1024,
          cache: '',
          kind: 'cantoNano',
          runner: run.runner,
        })
      })
      const speak = (worker: Worker, text: string) => new Promise<{ parts: Record<string, unknown>[], firstMs: number }>((resolve, reject) => {
        const parts: Record<string, unknown>[] = []
        let total = 0
        let firstMs: number | null = null
        const t0 = performance.now()
        const on = (e: MessageEvent) => {
          if (e.data.id !== '1.0') return
          if (e.data.t === 'parts') total = e.data.count
          else if (e.data.t === 'audio') {
            if (firstMs === null) firstMs = Math.round(performance.now() - t0)
            parts.push(e.data)
            if (parts.length === total) { worker.removeEventListener('message', on); resolve({ parts, firstMs }) }
          }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
        worker.postMessage({ t: 'speak', id: '1.0', text })
      })
      const out: Record<string, any> = {}
      for (const run of runs) {
        const worker = new Worker('/workers/canto-tts-worker.js')
        const ready = await load(worker, run)
        out[run.name + ':ready'] = { provider: ready.provider, phase: ready.phase, dtype: ready.dtype, loadMs: ready.ms, heap: ready.heap, threads: ready.threads }
        for (const [name, text] of Object.entries(texts)) {
          const { parts, firstMs } = await speak(worker, text)
          let samples = 0
          let genMs = 0
          let heap = 0
          let sampleRate = 0
          let peak = 0
          const pcm: number[] = []
          for (const p of parts) {
            const f = new Float32Array(p.pcm as ArrayBuffer)
            for (const s of f) { pcm.push(s); peak = Math.max(peak, Math.abs(s)) }
            samples += f.length
            sampleRate = Number(p.sampleRate)
            genMs += Number(p.ms) || 0
            heap = Math.max(heap, Number(p.heap) || 0)
          }
          out[run.name + ':' + name] = {
            text,
            firstMs,
            seconds: samples / sampleRate,
            genMs,
            rtf: genMs / 1000 / (samples / sampleRate),
            sampleRate,
            peak,
            heap,
            parts: parts.length,
            truncated: parts.some(p => p.truncated),
            pcm,
          }
        }
        worker.postMessage({ t: 'dispose' })
      }
      return out
    }, { int8: { dir: voice.dir, textDir: voice.textDir, members: voice.members }, gpu: { ...voiceGpu }, texts })
    const samplesDir = path.resolve('../briefs/canto-tts/samples-fp16')
    mkdirSync(samplesDir, { recursive: true })
    const wav = (values: Float32Array, sampleRate: number) => {
      const buf = Buffer.alloc(44 + values.length * 2)
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + values.length * 2, 4); buf.write('WAVE', 8)
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
      buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
      buf.write('data', 36); buf.writeUInt32LE(values.length * 2, 40)
      for (let i = 0; i < values.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(values[i]! * 32767))), 44 + i * 2)
      return buf
    }
    const lines: string[] = []
    for (const [key, value] of Object.entries(result) as [string, any][]) {
      if (!value.text) {
        lines.push(`${key}: provider ${value.provider}, phase ${value.phase}, dtype ${value.dtype}, load ${value.loadMs} ms, heap ${Math.round(value.heap / 2 ** 20)} MiB, threads ${value.threads}`)
        continue
      }
      writeFileSync(path.join(samplesDir, key.replace(':', '-') + '.wav'), wav(Float32Array.from(value.pcm), value.sampleRate))
      const line = `${key}: ${value.seconds.toFixed(2)} s, first ${value.firstMs} ms, generation ${value.genMs} ms (RTF ${value.rtf.toFixed(2)}), peak ${value.peak.toFixed(2)}, heap ${Math.round(value.heap / 2 ** 20)} MiB, parts ${value.parts}, truncated ${value.truncated}`
      lines.push(line)
      console.log(line)
    }
    console.log(lines.join('\n'))
    testInfo.annotations.push({ type: 'canto-gpu', description: lines.join(' | ') })
    expect(result['int8:ready'].provider).toBe('wasm')
    expect(result['gpu-cpu-io:ready'].provider).toBe('webgpu')
    expect(result['gpu-cpu-io:ready'].dtype).toBe('float16')
    expect(result['gpu-cpu-io:ready'].phase).toBe('cpu-io')
    expect(result['gpu-gpu-kv:ready'].phase).toBe('gpu-kv')
    for (const key of ['int8:short', 'gpu-cpu-io:short', 'gpu-gpu-kv:short', 'int8:medium', 'gpu-cpu-io:medium', 'gpu-gpu-kv:medium', 'int8:english', 'gpu-cpu-io:english', 'gpu-gpu-kv:english']) {
      expect(result[key].peak, key).toBeGreaterThan(0.05)
      expect(result[key].seconds, key).toBeGreaterThan(0.5)
    }
  }
  finally { server.close() }
})
