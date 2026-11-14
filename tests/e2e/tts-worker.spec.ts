import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import VOICES from '../../app/utils/speech/voices.json' with { type: 'json' }
import { CSP_TTS_WORKER } from '../../server/utils/csp'
import { serveModelFile } from '../../server/utils/modelFiles'

// public/workers/tts-worker.js in a real browser (Chromium and WebKit): the
// French voice's files are put in Cache Storage as 8 MB `?chunk=N` slices, as
// app/utils/dictation/modelStore.ts does, then the worker loads the runtime and
// the voice and speaks one sentence. Logs load time, speed (RTF: synthesis
// time / audio time) and the WASM heap. Needs the runtime and the voice under
// TTS_MODELS_DIR (default: $DATA_DIR/models), else skipped (CI has no voice):
//   DATA_DIR=~/wherdr-data node scripts/fetch-dictation-files.mjs runtime tts-siwis-medium
//   TTS_MODELS_DIR=~/wherdr-data/models npx playwright test tts-worker
const voice = VOICES.voices.find(v => v.id === 'siwis-medium')!
const modelsDir = path.resolve(process.env.TTS_MODELS_DIR || path.join(process.env.DATA_DIR || 'data', 'models'))
const runtime = 'runtime/sherpa-onnx-679ff70/'
const present = existsSync(path.join(modelsDir, voice.dir, '.complete')) && existsSync(path.join(modelsDir, runtime, 'sherpa-onnx-tts.js'))
const SENTENCE = 'Bonjour, je lis la réponse de votre agent à voix haute.'

test('the TTS worker speaks a French sentence from cached slices', async ({ page }, testInfo) => {
  test.skip(!present, `no voice under ${modelsDir}`)
  test.setTimeout(180_000)
  const workers = path.resolve('public/workers')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    let out: Response
    if (url.pathname.startsWith('/models/')) {
      out = await serveModelFile(modelsDir, decodeURIComponent(url.pathname.slice(8)), { method: req.method, range: req.headers.range })
    }
    else if (url.pathname.startsWith('/workers/') && existsSync(path.join(workers, path.basename(url.pathname)))) {
      out = new Response(readFileSync(path.join(workers, path.basename(url.pathname))), { headers: { 'content-type': 'text/javascript', 'content-security-policy': CSP_TTS_WORKER } })
    }
    else out = new Response('<!doctype html><title>tts</title>', { headers: { 'content-type': 'text/html' } })
    res.writeHead(out.status, Object.fromEntries(out.headers))
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    await page.goto(`http://localhost:${(server.address() as AddressInfo).port}/`)
    const result = await page.evaluate(async ({ dir, model, members, runtime, text }) => {
      const CHUNK = 8 * 1024 * 1024
      const cache = await caches.open('wherdr-asr-v1')
      for (const f of members) {
        const url = `/models/${dir}/${f.path}`
        const blob = await (await fetch(url)).blob()
        for (let i = 0; i < Math.max(1, Math.ceil(f.bytes / CHUNK)); i++) {
          await cache.put(`${url}?chunk=${i}`, new Response(blob.slice(i * CHUNK, (i + 1) * CHUNK)))
        }
      }
      const worker = new Worker('/workers/tts-worker.js')
      const next = (t: string) => new Promise<Record<string, any>>((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.t === 'error') reject(new Error(e.data.error))
          else if (e.data.t === t) resolve(e.data)
        }
      })
      const ready = next('ready')
      worker.postMessage({ t: 'load', runtime: `/models/${runtime}`, base: `/models/${dir}`, model, files: members.map(f => f.path), bytes: members.map(f => f.bytes), chunk: CHUNK, cache: 'wherdr-asr-v1' })
      const loaded = await ready
      const spoken = next('audio')
      worker.postMessage({ t: 'speak', id: 1, text })
      const audio = await spoken
      const pcm = new Float32Array(audio.pcm)
      worker.postMessage({ t: 'dispose' })
      let peak = 0
      for (const s of pcm) peak = Math.max(peak, Math.abs(s))
      return { loadMs: loaded.ms, heapAfterLoad: loaded.heap, ms: audio.ms, heap: audio.heap, sampleRate: audio.sampleRate, seconds: pcm.length / audio.sampleRate, peak }
    }, { dir: voice.dir, model: voice.model, members: voice.members, runtime, text: SENTENCE })
    const rtf = result.ms / 1000 / result.seconds
    const mib = (n: number) => `${Math.round(n / 2 ** 20)} MiB`
    const report = `${testInfo.project.name}: load ${result.loadMs} ms, ${result.seconds.toFixed(2)} s of audio in ${result.ms} ms (RTF ${rtf.toFixed(2)}), heap ${mib(result.heapAfterLoad)} after load, ${mib(result.heap)} after speaking`
    console.log(report)
    testInfo.annotations.push({ type: 'tts', description: report })
    expect(result.sampleRate).toBe(voice.sampleRate)
    expect(result.seconds).toBeGreaterThan(1.5)
    expect(result.peak).toBeGreaterThan(0.05)
  }
  finally { server.close() }
})
