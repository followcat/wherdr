// Voices hidden by "Hide low-quality voices" in Settings › Read aloud, matched
// on the voice name without its "(…)" suffix ("Eddy (English (United States))").
// Source: the voice lists of macOS 14–15 and iOS 17–18 (System Settings ›
// Accessibility › Spoken Content › System voice), as speechSynthesis.getVoices()
// returns them in Chrome and Safari. No other platform ships known joke voices:
// Windows, Android and ChromeOS voices are all plain readers.

// macOS / iOS novelty voices (sound effects, singing, robots).
const APPLE_NOVELTY = [
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged',
  'Good News', 'Hysterical', 'Jester', 'Organ', 'Pipe Organ', 'Superstar', 'Trinoids',
  'Whisper', 'Wobble', 'Zarvox',
]
// Old MacinTalk voices from the 1990s, still listed on macOS.
const APPLE_MACINTALK = ['Fred', 'Junior', 'Kathy', 'Ralph']
// Eloquence voices (macOS 13+, iOS 16+): the same eight names in many languages.
const APPLE_ELOQUENCE = ['Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley']

export const LOW_QUALITY_VOICE_NAMES: ReadonlySet<string> = new Set([...APPLE_NOVELTY, ...APPLE_MACINTALK, ...APPLE_ELOQUENCE])
