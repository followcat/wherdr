// Settings › Read aloud voice picker: quality sections and filters on real
// voice lists from macOS Chromium, macOS Safari and iPhone Safari.
import { describe, expect, it } from 'vitest'
import { baseVoiceName, langCode, userLanguages, voiceLanguages, voiceQuality, voiceSections } from '../app/utils/speech/voicePicker'
import { iPhoneSafariVoices, macChromiumVoices, macSafariVoices } from './fixtures/voices'

const names = (s: ReturnType<typeof voiceSections>) => Object.fromEntries(s.map(x => [x.quality, x.voices.map(v => v.name)]))
const mine = ['en', 'fr']

describe('voiceQuality', () => {
  it('sorts macOS Chromium voices by name suffix, online and low-quality lists', () => {
    expect(names(voiceSections(macChromiumVoices, { lang: 'all', hideLow: false, mine }))).toEqual({
      premium: ['Ava (Premium)'],
      enhanced: ['Zoe (Enhanced)', 'Audrey (Enhanced)'],
      standard: ['Samantha', 'Daniel', 'Thomas', 'Amélie', 'Anna', 'Kyoko'],
      online: ['Google US English', 'Google français', 'Google Deutsch'],
      low: ['Albert', 'Bad News', 'Bahh', 'Zarvox', 'Eddy (English (United Kingdom))', 'Eddy (French (France))', 'Grandma (English (United States))'],
    })
  })

  it('reads the voiceURI in Safari on macOS and iPhone', () => {
    expect(names(voiceSections(macSafariVoices, { lang: 'all', hideLow: false, mine }))).toEqual({
      premium: ['Ava (Premium)'],
      enhanced: ['Ava (Enhanced)'],
      standard: ['Alex', 'Samantha', 'Thomas', 'Anna'],
      low: ['Albert', 'Bubbles', 'Fred', 'Eddy (English (US))', 'Rocko (French (France))'],
    })
    expect(names(voiceSections(iPhoneSafariVoices, { lang: 'all', hideLow: false, mine }))).toEqual({
      premium: ['Ava'],
      enhanced: ['Audrey'],
      standard: ['Samantha', 'Thomas', 'Yuna'],
      low: ['Trinoids', 'Good News', 'Shelley', 'Flo'],
    })
  })

  it('treats a voice off the device as online whatever its name', () => {
    expect(voiceQuality({ name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'x', localService: false })).toBe('online')
    expect(voiceQuality({ name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'x', localService: true })).toBe('standard')
  })

  it('strips the language suffix from a name', () => {
    expect(baseVoiceName('Eddy (English (United Kingdom))')).toBe('Eddy')
    expect(baseVoiceName('Bad News')).toBe('Bad News')
  })
})

describe('filters', () => {
  it('by default lists the user’s languages without low-quality voices', () => {
    expect(names(voiceSections(macChromiumVoices, { lang: 'mine', hideLow: true, mine }))).toEqual({
      premium: ['Ava (Premium)'],
      enhanced: ['Zoe (Enhanced)', 'Audrey (Enhanced)'],
      standard: ['Samantha', 'Daniel', 'Thomas', 'Amélie'],
      online: ['Google US English', 'Google français'],
    })
  })

  it('filters one language', () => {
    expect(names(voiceSections(iPhoneSafariVoices, { lang: 'fr', hideLow: true, mine }))).toEqual({ enhanced: ['Audrey'], standard: ['Thomas'] })
  })

  it('keeps the chosen voice even when a filter hides it', () => {
    const s = voiceSections(macSafariVoices, { lang: 'fr', hideLow: true, mine, selected: 'com.apple.eloquence.en-US.Eddy' })
    expect(names(s)).toEqual({ standard: ['Thomas'], low: ['Eddy (English (US))'] })
  })

  it('lists every language when none of the user’s is among the voices', () => {
    const s = voiceSections(iPhoneSafariVoices, { lang: 'mine', hideLow: true, mine: ['de'] })
    expect(s.flatMap(x => x.voices).length).toBe(5)
  })

  it('derives language codes and the user’s languages', () => {
    expect(langCode('en_US')).toBe('en')
    expect(userLanguages(['fr-FR', 'fr', 'en-US'], 'en')).toEqual(['fr', 'en'])
    expect(voiceLanguages(macChromiumVoices)).toEqual(['de', 'en', 'fr', 'ja'])
  })
})
