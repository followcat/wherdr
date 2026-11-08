<script setup lang="ts">
// Settings › Conversation › Read aloud: Off or the device's voices, which
// voice, and a Test (composables/useReadAloud.ts). Kept on this device.
// The voice list is filtered by language and quality, in sections best first
// (utils/speech/voicePicker.ts); the chosen voice always stays listed.
import { deviceVoices, readAloudEngine, readAloudHideLow, readAloudSupported, readAloudVoice, readAloudVoiceLang, speak, speakingId, stopSpeaking } from '~/composables/useReadAloud'
import { language } from '~/utils/i18n'
import { languageName, langCode, userLanguages, voiceLanguages, voiceSections, type VoiceQuality } from '~/utils/speech/voicePicker'

const engineItems = computed(() => [
  { label: tl('Off', 'Désactivée'), description: tl('No Play button under replies.', 'Pas de bouton Lire sous les réponses.'), value: 'off' },
  { label: tl('Voices of this device', 'Voix de cet appareil'), description: tl('Free, spoken by the device. Default.', 'Gratuit, lu par l’appareil. Par défaut.'), value: 'device', disabled: !readAloudSupported },
])
// The select drops an item whose value is '': the system voice gets a name here.
const SYSTEM = 'system-default'
const voice = computed({ get: () => readAloudVoice.value || SYSTEM, set: (v: string) => { readAloudVoice.value = v === SYSTEM ? '' : v } })

const nameOf = (code: string) => languageName(code, language)
const mine = computed(() => userLanguages(typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language], language))
const present = computed(() => voiceLanguages(deviceVoices.value, nameOf))
const langItems = computed(() => {
  const own = mine.value.filter(l => present.value.includes(l)).map(nameOf)
  return [
    ...(own.length ? [{ label: `${tl('My languages', 'Mes langues')} (${own.join(', ')})`, value: 'mine' }] : []),
    { label: tl('All languages', 'Toutes les langues'), value: 'all' },
    ...present.value.map(code => ({ label: nameOf(code), value: code })),
  ]
})
// A kept filter whose language is gone (another device's voices) falls back to 'mine'.
const langFilter = computed({
  get: () => langItems.value.some(i => i.value === readAloudVoiceLang.value) ? readAloudVoiceLang.value : langItems.value[0]!.value,
  set: (v: string) => { readAloudVoiceLang.value = v },
})

const SECTION_LABELS: Record<VoiceQuality, () => string> = {
  premium: () => tl('Premium', 'Premium'),
  enhanced: () => tl('Enhanced', 'Améliorée'),
  standard: () => tl('Standard', 'Standard'),
  // Chrome's Google voices, Edge's online voices: the text goes to their vendor.
  online: () => tl('Online · sends the text to its vendor', 'En ligne · envoie le texte à son éditeur'),
  low: () => tl('Low quality', 'Basse qualité'),
}
interface VoiceItem { label: string, value?: string, lang?: string, langName?: string, type?: 'label' }
const voiceItems = computed<VoiceItem[][]>(() => [
  [{ label: tl('System default', 'Voix par défaut du système'), value: SYSTEM, lang: '' }],
  ...voiceSections(deviceVoices.value, { lang: langFilter.value, hideLow: readAloudHideLow.value, mine: mine.value, selected: readAloudVoice.value })
    .map(s => [
      { type: 'label' as const, label: SECTION_LABELS[s.quality]() },
      ...s.voices.map(v => ({ label: v.name, value: v.voiceURI, lang: v.lang, langName: nameOf(langCode(v.lang)) })),
    ]),
])
const testing = computed(() => speakingId.value === 'settings:test')
function test() {
  if (testing.value) return stopSpeaking()
  speak('settings:test', tl('This is how agent replies will sound. A code block is not read; the voice says: code block.', 'Voici comment les réponses des agents seront lues. Un bloc de code n’est pas lu ; la voix dit : bloc de code.'))
}
</script>

<template>
  <div data-testid="read-aloud-settings">
    <URadioGroup v-model="readAloudEngine" :items="engineItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
    <template v-if="readAloudEngine === 'device'">
      <div class="settings-toggle read-aloud-voice-row">
        <span><b>{{ tl('Voice', 'Voix') }}</b><small>{{ tl('Siri voices cannot be used by browsers. Better voices are downloaded in System Settings › Accessibility › Spoken Content › System voice › Manage voices (Mac) or Settings › Accessibility › Spoken Content › Voices (iPhone); then quit the browser (Cmd+Q on Mac) and reopen it.', 'Les voix Siri ne sont pas accessibles aux navigateurs. De meilleures voix se téléchargent dans Réglages Système › Accessibilité › Contenu énoncé › Voix du système › Gérer les voix (Mac) ou Réglages › Accessibilité › Contenu énoncé › Voix (iPhone) ; quitte ensuite le navigateur (Cmd+Q sur Mac) et rouvre-le.') }}</small></span>
        <div class="read-aloud-filters">
          <USelect
            v-model="langFilter" :items="langItems" value-key="value" size="lg" class="read-aloud-lang-filter"
            :aria-label="tl('Language', 'Langue')" data-testid="read-aloud-lang"
          />
          <UCheckbox v-model="readAloudHideLow" :label="tl('Hide low-quality voices', 'Masquer les voix de basse qualité')" color="primary" size="lg" data-testid="read-aloud-hide-low" />
        </div>
        <USelectMenu
          v-model="voice" :items="voiceItems" value-key="value" :filter-fields="['label', 'lang', 'langName']" size="lg" class="read-aloud-voice"
          :search-input="{ placeholder: tl('Search a voice or language', 'Chercher une voix ou une langue'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
          :ui="{ label: 'read-aloud-section' }"
          :aria-label="tl('Voice', 'Voix')" data-testid="read-aloud-voice"
        >
          <template #item-trailing="{ item }">
            <span class="mono read-aloud-lang">{{ item.lang }}</span>
          </template>
        </USelectMenu>
      </div>
      <div class="read-aloud-actions">
        <UButton color="neutral" variant="outline" size="lg" :icon="testing ? 'i-lucide-square' : 'i-lucide-volume-2'" :label="testing ? tl('Stop', 'Arrêter') : tl('Test', 'Tester')" data-testid="read-aloud-test" @click="test" />
      </div>
    </template>
    <p v-if="!readAloudSupported" class="muted settings-hint">{{ tl('This browser has no voices.', 'Ce navigateur n’a pas de voix.') }}</p>
  </div>
</template>

<style scoped>
.read-aloud-voice-row { flex-direction: column; align-items: stretch; gap: 10px; }
.read-aloud-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; }
.read-aloud-lang-filter { min-width: 220px; flex: 0 1 auto; }
.read-aloud-voice { width: 100%; }
.read-aloud-lang { font-size: 11px; color: var(--muted); white-space: nowrap; }
.read-aloud-actions { display: flex; margin-top: 12px; }
</style>

<style>
/* Section titles inside the voice menu (teleported, so not scoped). */
.read-aloud-section { font: 500 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
</style>
