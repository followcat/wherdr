// public/workers/canto/runner.js: the per-voice runner options. The INT8 voice
// keeps the WASM/float32 defaults; the GPU voice changes the external-data
// names, the dtype and the provider.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(process.cwd(), 'public/workers/canto/runner.js'), 'utf8')
const ctx: Record<string, unknown> = {}
ctx.self = ctx
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(source, ctx)
const runner = (ctx.self as unknown as { wherdrCantoRunner: {
  runnerOptions: (voice?: unknown) => { dtype: string, providers: string[], kvGpu: boolean, external: Record<string, string> }
} }).wherdrCantoRunner

describe('the Canto runner options', () => {
  it('keeps the INT8 defaults: WASM, float32 and the int8 external-data names', () => {
    expect(runner.runnerOptions(undefined)).toEqual({
      dtype: 'float32',
      providers: ['wasm'],
      kvGpu: false,
      external: {
        tts: 'moss_tts_decode_step.onnx.data',
        local: 'moss_tts_local_fixed_sampled_frame.onnx.data',
        codec: 'moss_audio_tokenizer_decode_shared.data',
      },
    })
  })

  it('configures the GPU voice: WebGPU, float16, its files, and an optional GPU KV', () => {
    const gpu = runner.runnerOptions({
      dtype: 'float16',
      providers: ['webgpu'],
      external: {
        tts: 'moss_tts_global_shared.data',
        local: 'moss_tts_local_shared.data',
        codec: 'moss_audio_tokenizer_decode_shared.data',
      },
    })
    expect(gpu).toEqual({
      dtype: 'float16',
      providers: ['webgpu'],
      kvGpu: false,
      external: {
        tts: 'moss_tts_global_shared.data',
        local: 'moss_tts_local_shared.data',
        codec: 'moss_audio_tokenizer_decode_shared.data',
      },
    })
    expect(runner.runnerOptions({ kvGpu: true, providers: ['webgpu'] }).kvGpu).toBe(true)
    // A partial override keeps the defaults it does not name.
    expect(runner.runnerOptions({ dtype: 'float16' }).external.tts).toBe('moss_tts_decode_step.onnx.data')
  })
})
