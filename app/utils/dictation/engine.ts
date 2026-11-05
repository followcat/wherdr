// Dictation engines. Both families (on the device, OpenRouter) work per take:
// the composer records, the user releases, and the whole text comes back at
// once. Capture, levels and draft insertion are shared (useDictation); only
// the engine behind this interface changes.

export type DictationEngineId = 'device' | 'cloud'

export interface Take {
  pcm: Float32Array // 16 kHz mono, the whole take
  seconds: number
}

export interface TranscribeOptions {
  language?: string // ISO 639-1; absent = automatic detection
  terms: string[] // pane terms (dictationTerms), possibly empty
  signal: AbortSignal // the take was cancelled or its composer unmounted
  // The text so far, as a long take is decoded piece by piece (or streamed).
  onPartial?: (text: string) => void
}

export type NotReadyReason = 'not-installed' | 'no-key' | 'unsupported' | 'offline' | 'too-large'

export type Readiness =
  | { ready: true }
  | { ready: false, reason: NotReadyReason, detail?: string }

export interface PrepareProgress { phase: string, got?: number, total?: number }

export interface DictationEngine {
  id: DictationEngineId
  // What the interface can show or offer.
  caps: { terms: boolean, languages: string[] | 'many', offline: boolean }
  // Usable here, now? (model cached, key saved, WebGPU…). Never rejects.
  readiness(): Promise<Readiness>
  // Load what is heavy (worker, model); a no-op for the cloud engine.
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<void>
  // Rejects with an AbortError as soon as opts.signal aborts.
  transcribe(take: Take, opts: TranscribeOptions): Promise<{ text: string, ms: number }>
  // Free the worker and memory (engine or model switch). Safe to call twice.
  dispose(): void
}

export const TAKE_RATE = 16000

// The error an engine rejects with when its signal aborts.
export function abortError(): Error {
  return new DOMException('The take was cancelled', 'AbortError')
}

// The model needs more memory than this device gives a page (worker out of
// memory, or the page was killed while loading it).
export class ModelTooLarge extends Error {
  override name = 'ModelTooLarge'
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}
