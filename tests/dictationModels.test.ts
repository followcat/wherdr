import { describe, expect, it } from 'vitest'
import { DEFAULT_CLOUD_MODEL, cheapestTextModel, openRouterPage, sttModels, textModels } from '../shared/dictationModels'

const STT = { input_modalities: ['audio'], output_modalities: ['transcription'] }
const ENDPOINT = ['/api/v1/audio/transcriptions']
// Trimmed entries in the shape of OpenRouter's GET /api/v1/models.
const MODELS_ANSWER = {
  data: [
    { id: 'qwen/qwen3-asr-1.7b', name: 'Qwen: Qwen3 ASR 1.7B', architecture: STT, pricing: { prompt: '0.0000075', completion: '0' }, endpoints: ENDPOINT },
    { id: 'openai/gpt-4o-mini-transcribe', name: 'OpenAI: GPT-4o Mini Transcribe', architecture: STT, pricing: { prompt: '0.00000125', completion: '0.000005' }, endpoints: ENDPOINT },
    { id: DEFAULT_CLOUD_MODEL, name: 'OpenAI: Whisper Large V3 Turbo', architecture: STT, pricing: { prompt: '0.00000333', completion: '0' }, endpoints: ENDPOINT },
    { id: 'microsoft/mai-transcribe-2', name: 'Microsoft AI: MAI-Transcribe 2', architecture: STT, pricing: { prompt: '0.1', completion: '0' }, endpoints: ENDPOINT },
    // A chat model that accepts audio: it answers text, not at the transcription endpoint.
    { id: 'mistralai/voxtral-small-24b-2507', name: 'Mistral: Voxtral Small 24B', architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000003' }, endpoints: ['/api/v1/chat/completions'] },
    // Says transcription but is not served at the endpoint the relay calls.
    { id: 'acme/odd-stt', name: 'Acme', architecture: STT, pricing: { prompt: '0.00001' }, endpoints: ['/api/v1/chat/completions'] },
    { id: 'not a slug', name: 'Bad id', architecture: STT, endpoints: ENDPOINT },
    { id: 'openai/gpt-5', name: 'GPT-5', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ],
}

describe('sttModels', () => {
  it('keeps only speech-to-text models served at the transcription endpoint', () => {
    expect(sttModels(MODELS_ANSWER).map(m => m.id)).toEqual([
      DEFAULT_CLOUD_MODEL, 'qwen/qwen3-asr-1.7b', 'microsoft/mai-transcribe-2', 'openai/gpt-4o-mini-transcribe',
    ])
  })

  it('gives a price per minute only for duration-priced models', () => {
    const byId = Object.fromEntries(sttModels(MODELS_ANSWER).map(m => [m.id, m]))
    expect(byId[DEFAULT_CLOUD_MODEL]).toEqual({ id: DEFAULT_CLOUD_MODEL, name: 'OpenAI: Whisper Large V3 Turbo', perMinute: 0.0002 })
    expect(byId['qwen/qwen3-asr-1.7b']!.perMinute).toBe(0.00045)
    // Billed per output token, or a price that cannot be per second: none shown.
    expect(byId['openai/gpt-4o-mini-transcribe']!.perMinute).toBeUndefined()
    expect(byId['microsoft/mai-transcribe-2']!.perMinute).toBeUndefined()
  })

  it('accepts an answer without endpoints and refuses junk', () => {
    expect(sttModels({ data: [{ id: 'a/b', architecture: STT }] })).toEqual([{ id: 'a/b', name: 'a/b' }])
    expect(sttModels(null)).toEqual([])
    expect(sttModels({ data: 'x' })).toEqual([])
    expect(sttModels({ data: [null, 1, { id: 'a/b', architecture: { input_modalities: 'audio' } }] })).toEqual([])
  })
})

describe('prices that are not plain per-second audio prices', () => {
  // Real pricing shapes from OpenRouter (2026-11): MAI quotes per hour, the
  // GPT-4o and Gemini transcribers bill tokens. No unit is guessed: no price,
  // the pickers link to the model's OpenRouter page instead.
  it('gives no per-minute price for them, and a page to link to', () => {
    const real = { data: [
      { id: 'microsoft/mai-transcribe-2', architecture: STT, pricing: { prompt: '0.1', completion: '0' }, endpoints: ENDPOINT },
      { id: 'microsoft/mai-transcribe-1.5', architecture: STT, pricing: { prompt: '0.36', completion: '0' }, endpoints: ENDPOINT },
      { id: 'openai/gpt-4o-transcribe', architecture: STT, pricing: { prompt: '0.0000025', completion: '0.00001' }, endpoints: ENDPOINT },
      { id: 'google/gemini-3.5-transcribe', architecture: STT, pricing: { prompt: '0.000002', completion: '0.000012' }, endpoints: ENDPOINT },
      { id: 'deepgram/nova-3', architecture: STT, pricing: { prompt: '0.0000716666666667', completion: '0' }, endpoints: ENDPOINT },
    ] }
    const out = sttModels(real)
    expect(out.filter(m => m.perMinute === undefined).map(m => m.id).sort()).toEqual([
      'google/gemini-3.5-transcribe', 'microsoft/mai-transcribe-1.5', 'microsoft/mai-transcribe-2', 'openai/gpt-4o-transcribe',
    ])
    expect(out.find(m => m.id === 'deepgram/nova-3')!.perMinute).toBe(0.0043)
    expect(openRouterPage('microsoft/mai-transcribe-2')).toBe('https://openrouter.ai/microsoft/mai-transcribe-2')
  })
})

describe('textModels', () => {
  const TEXT = { input_modalities: ['text'], output_modalities: ['text'] }
  const answer = { data: [
    { id: 'mistralai/mistral-nemo', name: 'Mistral: Mistral Nemo', architecture: TEXT, pricing: { prompt: '0.000000029', completion: '0.00000003' } },
    // Cheaper still, but output is free: an extraction tool, not a chat model.
    { id: 'scaledown/extract', name: 'ScaleDown: Extract', architecture: TEXT, pricing: { prompt: '0.00000004', completion: '0' } },
    { id: 'openai/gpt-oss-20b:batch', name: 'gpt-oss-20b (batch)', architecture: TEXT, pricing: { prompt: '0.00000001', completion: '0.00000001' } },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama free', architecture: TEXT, pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', name: 'Auto Router', architecture: TEXT, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.00000025', completion: '0.000002' } },
    { id: 'openai/whisper-1', name: 'Whisper', architecture: STT, pricing: { prompt: '0.0001', completion: '0' } },
    { id: 'black-forest-labs/flux', name: 'Flux', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ] }

  it('keeps text-to-text models, priced per million tokens when the price is plain', () => {
    const out = textModels(answer)
    expect(out.map(m => m.id)).not.toContain('openai/whisper-1')
    expect(out.map(m => m.id)).not.toContain('black-forest-labs/flux')
    const byId = Object.fromEntries(out.map(m => [m.id, m]))
    expect(byId['mistralai/mistral-nemo']!.perM).toEqual({ in: 0.029, out: 0.03 })
    expect(byId['openai/gpt-5-mini']!.perM).toEqual({ in: 0.25, out: 2 })
    expect(byId['openrouter/auto']!.perM).toBeUndefined()
    expect(textModels({ data: [{ id: 'a/b', architecture: TEXT, pricing: { prompt: '' , completion: '0' } }] })[0]!.perM).toBeUndefined()
  })

  it('defaults to the cheapest paid chat model, never a free, batch or free-output one', () => {
    expect(cheapestTextModel(textModels(answer))).toBe('mistralai/mistral-nemo')
    expect(cheapestTextModel([])).toBeUndefined()
  })
})
