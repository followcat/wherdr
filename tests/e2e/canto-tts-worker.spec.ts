import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
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

const loadArgs = { dir: voice.dir, files: voice.members.map(m => m.path), bytes: voice.members.map(m => m.bytes), runtime }

test('the Canto worker speaks a Cantonese sentence without cross-origin isolation', async ({ page }, testInfo) => {
  test.skip(!present, `no Canto model under ${modelsDir}`)
  test.setTimeout(300_000)
  const server = await startServer()
  try {
    await page.goto(server.url)
    const isolated = await page.evaluate(() => crossOriginIsolated)
    const result = await page.evaluate(async ({ dir, files, bytes, runtime, text }) => {
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
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
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
    const result = await page.evaluate(async ({ dir, files, bytes, runtime, text }) => {
      const worker = new Worker('/workers/canto-tts-worker.js')
      const ready = new Promise<void>((resolve, reject) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'ready') { worker.removeEventListener('message', on); resolve() }
          else if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.error)) }
        }
        worker.addEventListener('message', on)
      })
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
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
    const result = await page.evaluate(async ({ dir, files, bytes, runtime }) => {
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
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, files, bytes, chunk: 8 * 1024 * 1024, cache: '' })
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
