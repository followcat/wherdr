// The voice picker of Settings › Read aloud: sorts the device's voices into
// quality sections (best first) and applies the language and quality filters.
import { LOW_QUALITY_VOICE_NAMES } from './lowQualityVoices'

export interface VoiceLike { name: string, lang: string, voiceURI: string, localService: boolean }
export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'online' | 'low'
// Section order in the list.
export const QUALITY_ORDER: readonly VoiceQuality[] = ['premium', 'enhanced', 'standard', 'online', 'low']

// 'mine' = the user's languages, 'all', or one language code ('en').
export type VoiceLangFilter = string

// "Eddy (English (United States))" → "Eddy".
export const baseVoiceName = (name: string) => name.replace(/\s*\(.*$/, '').trim()

// Apple says it in the name ("Ava (Premium)", Chrome and recent Safari) or in
// the voiceURI ("com.apple.voice.premium.en-US.Ava", Safari on macOS and iOS).
export function voiceQuality(v: VoiceLike): VoiceQuality {
  // Not on the device: the text goes to the vendor (Chrome's Google voices, Edge's online voices).
  if (!v.localService) return 'online'
  const id = `${v.name} ${v.voiceURI}`
  if (/\(premium\)|\.premium\./i.test(id)) return 'premium'
  if (/\(enhanced\)|\.enhanced\./i.test(id)) return 'enhanced'
  if (LOW_QUALITY_VOICE_NAMES.has(baseVoiceName(v.name)) || /\.eloquence\./i.test(v.voiceURI)) return 'low'
  return 'standard'
}

// "en-US", "en_US", "EN" → "en".
export const langCode = (lang: string) => (lang.split(/[-_]/)[0] || '').toLowerCase()

// The user's languages: the browser's, then the app's, without repeats.
export function userLanguages(browser: readonly string[], app: string): string[] {
  return [...new Set([...browser, app].map(langCode).filter(Boolean))]
}

// Language codes present among the voices, sorted by their name.
export function voiceLanguages(voices: readonly VoiceLike[], nameOf: (code: string) => string = c => c): string[] {
  return [...new Set(voices.map(v => langCode(v.lang)).filter(Boolean))]
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

export function languageName(code: string, uiLang: string): string {
  try { return new Intl.DisplayNames([uiLang], { type: 'language' }).of(code) || code } catch { return code }
}

export interface VoiceFilters {
  lang: VoiceLangFilter
  hideLow: boolean
  // The user's languages, used by lang 'mine'.
  mine: readonly string[]
  // voiceURI of the chosen voice: always kept.
  selected?: string
}

// The voices to list, in sections, best first; empty sections are left out.
// 'mine' with none of the user's languages among the voices lists them all.
export function voiceSections<V extends VoiceLike>(voices: readonly V[], f: VoiceFilters): { quality: VoiceQuality, voices: V[] }[] {
  const present = new Set(voices.map(v => langCode(v.lang)))
  const langs = f.lang === 'all' ? null
    : f.lang === 'mine' ? (f.mine.some(l => present.has(l)) ? new Set(f.mine) : null)
      : new Set([f.lang])
  const keep = (v: V, q: VoiceQuality) => v.voiceURI === f.selected
    || ((!langs || langs.has(langCode(v.lang))) && !(f.hideLow && q === 'low'))
  const by = new Map<VoiceQuality, V[]>()
  for (const v of voices) {
    const q = voiceQuality(v)
    if (keep(v, q)) by.set(q, [...(by.get(q) || []), v])
  }
  return QUALITY_ORDER.filter(q => by.has(q)).map(q => ({ quality: q, voices: by.get(q)! }))
}
