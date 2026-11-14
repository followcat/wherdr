// The models the on-device engine can run. The data lives in models.json (the
// catalog: sizes, languages, published figures, from the model study WHR-318),
// which scripts/fetch-dictation-files.mjs reads too: a model of a known family
// is added there without code. Files go to DATA_DIR/models and are served by
// the /models/** route.
import catalog from './models.json'

// sherpa-onnx WASM runtime folder, under /models/runtime/.
export const DEVICE_RUNTIME = 'sherpa-onnx-679ff70'
// Cache Storage the model files are kept in (the service worker spares wherdr-asr-*).
export const DEVICE_CACHE = 'wherdr-asr-v1'

// The families the worker knows how to build (public/workers/dictation-worker.js).
export const DEVICE_KINDS = ['senseVoice', 'nemoTransducer', 'canary'] as const
export type DeviceKind = typeof DEVICE_KINDS[number]
export type DeviceNeed = 'webgpu' | 'shader-f16'

export interface DeviceModel {
  id: string
  name: string
  kind: DeviceKind
  requires: DeviceNeed[]
  set: string // the fetch script's set
  dir: string // under /models/
  files: { path: string, bytes: number }[]
  source: { url: string, sha256: string } // the fetch script's pinned archive
  languages: string[] // ISO 639-1 (639-3 when there is none: yue)
  ranked: string[] // the same languages, best first (see RANKING SOURCES)
  autoDetect?: false // the language is not detected: the device's is used (deviceLanguage)
  punctuation: boolean
  textCase?: 'upper' // writes in capitals: put in sentence case (sentenceCase)
  // Published error rate, %: word errors, or character errors (metric 'CER').
  quality: { lang: string, dataset: string, wer: number, metric?: 'CER', source: string }[]
  speed?: { estimate: number, basis: string, source: string } // 1-5, until measured here
  license?: { id: string, url: string }
  // Measured: WASM heap after load (what the budget checks) and the page's peak.
  memory?: { heap: number, peak: number, basis: string }
}

// A catalog entry of a family this build does not know is skipped, so a newer
// catalog never breaks an older app.
export function readCatalog(raw: { models: unknown[] }): DeviceModel[] {
  return (raw.models as DeviceModel[]).filter(m => (DEVICE_KINDS as readonly string[]).includes(m.kind))
}

export const DEVICE_MODELS: DeviceModel[] = readCatalog(catalog)

export const DEVICE_MODEL_KEY = 'dictationDeviceModel'

// What this device can hold, in bytes of WASM heap; null = no known limit.
// iOS Safari kills a tab around 1 to 1.5 GB: SenseVoice (512 MiB of heap)
// runs on a real iPhone, Parakeet v3 (818 MiB) gets the page killed.
// Elsewhere, a quarter of navigator.deviceMemory (Chromium only).
export const IOS_HEAP_BUDGET = 640 * 2 ** 20
export function memoryBudget(nav: { userAgent?: string, platform?: string, maxTouchPoints?: number, deviceMemory?: number } | undefined = globalThis.navigator): number | null {
  if (!nav) return null
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  if (ios) return IOS_HEAP_BUDGET
  return nav.deviceMemory ? nav.deviceMemory * 2 ** 30 / 4 : null
}

// Models marked too large on this device: 'killed', the page died while
// loading it (see markLoading); 'oom', the worker said it ran out of memory.
// Settings' Try again (or Delete) clears the mark.
export type TooLargeWhy = 'killed' | 'oom'
const CRASHED_KEY = 'dictationTooLarge'
const LOADING_KEY = 'dictationLoading'
function store(): Storage | null {
  try { return globalThis.localStorage ?? null }
  catch { return null }
}
export function crashedModels(): Record<string, TooLargeWhy> {
  try {
    const v = JSON.parse(store()?.getItem(CRASHED_KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  catch { return {} }
}
function setCrashed(marks: Record<string, TooLargeWhy>) {
  try { store()?.setItem(CRASHED_KEY, JSON.stringify(marks)) }
  catch { /* private mode */ }
}
export const markTooLarge = (id: string, why: TooLargeWhy) => setCrashed({ ...crashedModels(), [id]: why })
export function forgetCrash(id: string) {
  const { [id]: _, ...rest } = crashedModels()
  setCrashed(rest)
}
// A load in progress is noted until it ends; a normal reload or close
// (pagehide) clears it. Still there at the next start: the system killed
// the page while it loaded (iOS, out of memory), so the model is too large here.
export function markLoading(id: string | null) {
  try {
    if (id) store()?.setItem(LOADING_KEY, id)
    else store()?.removeItem(LOADING_KEY)
  }
  catch { /* private mode */ }
}
let checked = false
let lastCrash: string | null = null
export function checkCrash() {
  if (checked) return
  checked = true
  globalThis.addEventListener?.('pagehide', () => markLoading(null))
  lastCrash = store()?.getItem(LOADING_KEY) ?? null
  if (!lastCrash) return
  markLoading(null)
  markTooLarge(lastCrash, 'killed')
}
// The model the last page was killed loading, given once.
export function takeCrash(): string | null {
  checkCrash()
  const id = lastCrash
  lastCrash = null
  return id
}

// 'ok', or why this model should not run here.
export function memoryFit(m: DeviceModel, budget = memoryBudget(), marks = crashedModels()): 'ok' | 'budget' | TooLargeWhy {
  if (marks[m.id]) return marks[m.id]!
  if (budget != null && m.memory && m.memory.heap > budget) return 'budget'
  return 'ok'
}

// The model this device uses: its saved choice if still offered and not too
// large here, else the first of the catalog that fits (never a too-large one).
export function deviceModel(saved: string | null | undefined, budget = memoryBudget(), marks = crashedModels()): DeviceModel {
  const fits = (m: DeviceModel) => memoryFit(m, budget, marks) === 'ok'
  const own = DEVICE_MODELS.find(m => m.id === saved)
  return (own && fits(own) ? own : DEVICE_MODELS.find(fits)) ?? own ?? DEVICE_MODELS[0]!
}

// The language a model without detection is told: the first of the device's
// languages it speaks, else English.
export function deviceLanguage(m: DeviceModel, langs: readonly string[] = globalThis.navigator?.languages ?? []): string {
  return langs.map(l => l.slice(0, 2).toLowerCase()).find(l => m.languages.includes(l)) ?? (m.languages.includes('en') ? 'en' : m.languages[0]!)
}

// All-capital output in sentence case: lower case, a capital to start each
// sentence and on the English "I". Text with any small letter is kept.
export function sentenceCase(text: string): string {
  if (text === text.toUpperCase() && text !== text.toLowerCase()) {
    return text.toLowerCase()
      .replace(/(^|[.!?]\s+)(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
      .replace(/\bi\b(?=$|\s|')/g, 'I')
  }
  return text
}

export const modelBytes = (m: DeviceModel) => m.files.reduce((n, f) => n + f.bytes, 0)

// Quality, 1 to 5, from the published word error rate for one language:
// FLEURS first, else MLS, else Common Voice. 'unsupported' when the model does
// not speak it, null when no figure is published.
const DATASETS = ['FLEURS', 'MLS', 'CV']
const WER_STEPS = [5, 7, 10, 15]
export function qualityRating(m: DeviceModel, lang: string) {
  if (!m.languages.includes(lang)) return 'unsupported' as const
  const figure = DATASETS.map(d => m.quality.find(q => q.lang === lang && q.dataset === d)).find(Boolean)
  if (!figure) return null
  const step = WER_STEPS.findIndex(s => figure.wer <= s)
  return { dots: step < 0 ? 1 : 5 - step, ...figure }
}

// RANKING SOURCES: each model's `ranked` languages, best first, from its
// own published figures (fetched 2026-11-09):
// - Parakeet v3: FLEURS WER of each of its 25 languages, model card
//   https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 (Italian 3.00 %,
//   Spanish 3.45 % … Slovenian 24.03 %).
// - Canary 180M: Common Voice 16.1 WER, the one dataset given for all four
//   languages, model card https://huggingface.co/nvidia/canary-180m-flash
//   (es 4.90, de 5.94, fr 8.19, en 9.53).
// - SenseVoice: the paper's Table 6, https://arxiv.org/html/2407.04051v3, and
//   the model card's language order (https://huggingface.co/FunAudioLLM/SenseVoiceSmall):
//   trained mostly on Chinese, with Chinese and Cantonese its best results
//   (AISHELL-1 2.96 % CER); Common Voice CER (zh, yue, ja, ko) and WER (en)
//   are not directly comparable, so English comes before Japanese and Korean
//   as on the card.
// A model with at least MULTI languages is shown as broadly multilingual.
export const MULTI = 10

// The languages a model card shows, best first: at most three (two and
// 'Multi' for a broadly multilingual model), then how many more.
export function languageLine(m: DeviceModel): string {
  const multi = m.languages.length >= MULTI
  const shown = m.ranked.slice(0, multi ? 2 : 3)
  const more = m.languages.length - shown.length
  const tail = multi ? [`Multi (${m.languages.length})`] : more ? [`+${more}`] : []
  return [...shown.map(l => l.toUpperCase()), ...tail].join(' · ')
}

// The languages the quality bars show: the model's two best, then the
// device's own language when the model speaks it and it is not one of them.
// mine: the device's language, when the model speaks it.
export function ratedLanguages(m: DeviceModel, langs: readonly string[] = globalThis.navigator?.languages ?? []) {
  const own = langs[0]?.split('-')[0]?.toLowerCase()
  const mine = own && m.languages.includes(own) ? own : null
  const top = m.ranked.slice(0, 2)
  return { langs: mine && !top.includes(mine) ? [...top, mine] : top, mine }
}

// What this browser offers to models that need the GPU.
export async function gpuFeatures(gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } } | undefined)?.gpu): Promise<DeviceNeed[]> {
  if (!gpu) return []
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return []
    return adapter.features.has('shader-f16') ? ['webgpu', 'shader-f16'] : ['webgpu']
  }
  catch { return [] }
}

// The models that can run here: one needing WebGPU is left out without it.
export const runnableModels = (have: DeviceNeed[], models = DEVICE_MODELS) =>
  models.filter(m => m.requires.every(r => have.includes(r)))
