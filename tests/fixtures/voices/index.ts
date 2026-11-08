// speechSynthesis.getVoices() samples, trimmed to a representative subset.
// Chromium on macOS names voices "Name (Language (Region))" for multi-language
// ones and "Name (Premium)" / "Name (Enhanced)"; its voiceURI is the name.
// Safari (macOS and iOS) gives Apple's identifiers as voiceURI.
import type { VoiceLike } from '../../../app/utils/speech/voicePicker'

const v = (name: string, lang: string, voiceURI = name, localService = true): VoiceLike => ({ name, lang, voiceURI, localService })

export const macChromiumVoices: VoiceLike[] = [
  v('Albert', 'en-US'), v('Bad News', 'en-US'), v('Bahh', 'en-US'), v('Zarvox', 'en-US'),
  v('Eddy (English (United Kingdom))', 'en-GB'), v('Eddy (French (France))', 'fr-FR'), v('Grandma (English (United States))', 'en-US'),
  v('Ava (Premium)', 'en-US'), v('Zoe (Enhanced)', 'en-US'), v('Audrey (Enhanced)', 'fr-FR'),
  v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Thomas', 'fr-FR'), v('Amélie', 'fr-CA'), v('Anna', 'de-DE'), v('Kyoko', 'ja-JP'),
  v('Google US English', 'en-US', 'Google US English', false), v('Google français', 'fr-FR', 'Google français', false), v('Google Deutsch', 'de-DE', 'Google Deutsch', false),
]

export const macSafariVoices: VoiceLike[] = [
  v('Albert', 'en-US', 'com.apple.speech.synthesis.voice.Albert'), v('Bubbles', 'en-US', 'com.apple.speech.synthesis.voice.Bubbles'),
  v('Fred', 'en-US', 'com.apple.speech.synthesis.voice.Fred'),
  v('Eddy (English (US))', 'en-US', 'com.apple.eloquence.en-US.Eddy'), v('Rocko (French (France))', 'fr-FR', 'com.apple.eloquence.fr-FR.Rocko'),
  v('Alex', 'en-US', 'com.apple.speech.synthesis.voice.Alex'),
  v('Ava (Premium)', 'en-US', 'com.apple.voice.premium.en-US.Ava'), v('Ava (Enhanced)', 'en-US', 'com.apple.voice.enhanced.en-US.Ava'),
  v('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha'), v('Thomas', 'fr-FR', 'com.apple.voice.compact.fr-FR.Thomas'),
  v('Anna', 'de-DE', 'com.apple.voice.compact.de-DE.Anna'),
]

// iOS Safari: names may lack the quality suffix; the voiceURI carries it.
export const iPhoneSafariVoices: VoiceLike[] = [
  v('Trinoids', 'en-US', 'com.apple.speech.synthesis.voice.Trinoids'), v('Good News', 'en-US', 'com.apple.speech.synthesis.voice.GoodNews'),
  v('Shelley', 'en-GB', 'com.apple.eloquence.en-GB.Shelley'), v('Flo', 'fr-FR', 'com.apple.eloquence.fr-FR.Flo'),
  v('Ava', 'en-US', 'com.apple.voice.premium.en-US.Ava'), v('Audrey', 'fr-FR', 'com.apple.voice.enhanced.fr-FR.Audrey'),
  v('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha'), v('Thomas', 'fr-FR', 'com.apple.voice.compact.fr-FR.Thomas'),
  v('Yuna', 'ko-KR', 'com.apple.voice.compact.ko-KR.Yuna'),
]
