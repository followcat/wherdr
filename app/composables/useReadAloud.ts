// Read aloud: the Play button under agent replies (ReadAloudButton.vue) and
// Settings › Conversation › Read aloud (ReadAloudSettings.vue). One reply at a
// time for the whole app. Engines: the device's own voices (speechSynthesis),
// or `wherdr`, a neural voice run on the device (utils/speech/neuralVoice.ts),
// which reads each reply with the voice of its language (French or English,
// a guess) and falls back to the device's voices while that voice is not installed.
// Both are free and never go through the wherdr server. Choice and voice are
// kept on this device.
import { speakableText, speechChunks } from '~/utils/speech/plainText'
import { createNeuralVoice, defaultVoice, replyLanguage } from '~/utils/speech/neuralVoice'
import type { Voice } from '~/utils/speech/neuralVoice'
import { toast } from './useHerdr'

export type ReadAloudEngine = 'off' | 'device' | 'wherdr'
export const READ_ALOUD_KEY = 'readAloud'
export const READ_ALOUD_VOICE_KEY = 'readAloudVoice'
export const READ_ALOUD_LANG_KEY = 'readAloudVoiceLang'
export const READ_ALOUD_HIDE_LOW_KEY = 'readAloudHideLow'

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}
const synth = (): SpeechSynthesis | null => typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null

export const readAloudSupported = !!synth()
export const neuralVoice = typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined' ? createNeuralVoice() : null
void neuralVoice?.refresh()
// On by default where the browser has voices: the button is the feature.
const savedEngine = store.get(READ_ALOUD_KEY)
export const readAloudEngine = ref<ReadAloudEngine>(savedEngine === 'wherdr' && neuralVoice ? 'wherdr' : savedEngine === 'off' || !readAloudSupported ? 'off' : 'device')
watch(readAloudEngine, v => store.set(READ_ALOUD_KEY, v))
// voiceURI of the chosen voice; '' = the system's default voice.
export const readAloudVoice = ref(store.get(READ_ALOUD_VOICE_KEY) || '')
watch(readAloudVoice, v => store.set(READ_ALOUD_VOICE_KEY, v))
// Voice list filters (utils/speech/voicePicker.ts): 'mine' (the user's
// languages), 'all' or a language code; low-quality voices hidden by default.
export const readAloudVoiceLang = ref(store.get(READ_ALOUD_LANG_KEY) || 'mine')
watch(readAloudVoiceLang, v => store.set(READ_ALOUD_LANG_KEY, v))
export const readAloudHideLow = ref(store.get(READ_ALOUD_HIDE_LOW_KEY) !== 'off')
watch(readAloudHideLow, v => store.set(READ_ALOUD_HIDE_LOW_KEY, v ? 'on' : 'off'))

// The device's voices: often empty at first, filled on `voiceschanged`.
export const deviceVoices = shallowRef<SpeechSynthesisVoice[]>([])
function loadVoices() {
  const s = synth()
  if (!s) return
  deviceVoices.value = [...s.getVoices()].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
}
if (readAloudSupported) {
  loadVoices()
  synth()!.addEventListener?.('voiceschanged', loadVoices)
}

// What is playing: the id given to speak() (pane id + reply key), or null.
export const speakingId = ref<string | null>(null)
let gen = 0
// Safari drops utterances it no longer references before their `end` event.
let live: SpeechSynthesisUtterance[] = []
let watchdog: ReturnType<typeof setInterval> | undefined

function done(g: number) {
  if (g !== gen) return
  speakingId.value = null
  live = []
  clearInterval(watchdog)
}

// `md`: the reply as Markdown. Called from the tap itself: iOS only speaks from
// a user gesture, so every piece is queued at once, here. `neural`: this neural
// voice rather than the one of the reply’s language (Settings’ Test).
export function speak(id: string, md: string, neural?: Voice) {
  const s = synth()
  if (!s && readAloudEngine.value !== 'wherdr') return
  const g = ++gen
  s?.cancel()
  neuralVoice?.stop()
  const chunks = speechChunks(speakableText(md, tl('Code block.', 'Bloc de code.')))
  if (!chunks.length) return done(g)
  if (readAloudEngine.value === 'wherdr' && neuralVoice?.speak({
    voice: neural ?? defaultVoice([replyLanguage(chunks.join(' '))]),
    chunks,
    onEnd: () => done(g),
    onError: (e) => {
      if (g !== gen) return
      done(g)
      toast(tl(`Could not read aloud (${e.message})`), true)
    },
  })) {
    speakingId.value = id
    return
  }
  if (!s) return done(g)
  const voice = deviceVoices.value.find(v => v.voiceURI === readAloudVoice.value)
  speakingId.value = id
  live = chunks.map((text, i) => {
    const u = new SpeechSynthesisUtterance(text)
    if (voice) { u.voice = voice; u.lang = voice.lang }
    if (i === chunks.length - 1) u.onend = () => done(g)
    u.onerror = (e) => {
      if (g !== gen || e.error === 'interrupted' || e.error === 'canceled') return
      done(g)
      s.cancel()
      toast(tl(`Could not read aloud (${e.error})`, `Lecture impossible (${e.error})`), true)
    }
    return u
  })
  for (const u of live) s.speak(u)
  // Chrome can start paused after a cancel().
  s.resume()
  // iOS stops speaking with the screen locked or the app in the background,
  // without an `end` event: the button comes back to Play once nothing is left.
  clearInterval(watchdog)
  watchdog = setInterval(() => { if (!s.speaking && !s.pending) done(g) }, 1500)
}

// Stops what plays; with `prefix`, only if it belongs to it (a closed pane).
export function stopSpeaking(prefix?: string) {
  if (!speakingId.value || (prefix && !speakingId.value.startsWith(prefix))) return
  const g = gen
  synth()?.cancel()
  neuralVoice?.stop()
  done(g)
}
