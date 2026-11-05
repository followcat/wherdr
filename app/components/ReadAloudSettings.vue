<script setup lang="ts">
// Settings › Conversation › Read aloud: Off or the device's voices, which
// voice, and a Test (composables/useReadAloud.ts). Kept on this device.
import { deviceVoices, readAloudEngine, readAloudSupported, readAloudVoice, speak, speakingId, stopSpeaking } from '~/composables/useReadAloud'

const engineItems = computed(() => [
  { label: tl('Off', 'Désactivée'), description: tl('No Play button under replies.', 'Pas de bouton Lire sous les réponses.'), value: 'off' },
  { label: tl('Voices of this device', 'Voix de cet appareil'), description: tl('Free, spoken by the device. Default.', 'Gratuit, lu par l’appareil. Par défaut.'), value: 'device', disabled: !readAloudSupported },
])
// The select drops an item whose value is '': the system voice gets a name here.
const SYSTEM = 'system-default'
const voice = computed({ get: () => readAloudVoice.value || SYSTEM, set: (v: string) => { readAloudVoice.value = v === SYSTEM ? '' : v } })
// Voices marked "online" (Chrome's Google voices) send the text to their vendor.
const voiceItems = computed(() => [
  { label: tl('System default', 'Voix par défaut du système'), value: SYSTEM, lang: '' },
  ...deviceVoices.value.map(v => ({ label: v.name, value: v.voiceURI, lang: v.localService ? v.lang : `${v.lang} · ${tl('online', 'en ligne')}` })),
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
      <label class="settings-toggle read-aloud-voice-row">
        <span><b>{{ tl('Voice', 'Voix') }}</b><small>{{ tl('On iPhone, better voices are downloaded in Settings › Accessibility › Spoken Content › Voices, then appear here.', 'Sur iPhone, de meilleures voix se téléchargent dans Réglages › Accessibilité › Contenu énoncé › Voix, puis apparaissent ici.') }}</small></span>
        <USelectMenu
          v-model="voice" :items="voiceItems" value-key="value" :filter-fields="['label', 'lang']" size="lg" class="read-aloud-voice"
          :search-input="{ placeholder: tl('Search a voice or language', 'Chercher une voix ou une langue'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
          :aria-label="tl('Voice', 'Voix')" data-testid="read-aloud-voice"
        >
          <template #item-trailing="{ item }">
            <span class="mono read-aloud-lang">{{ item.lang }}</span>
          </template>
        </USelectMenu>
      </label>
      <div class="read-aloud-actions">
        <UButton color="neutral" variant="outline" size="lg" :icon="testing ? 'i-lucide-square' : 'i-lucide-volume-2'" :label="testing ? tl('Stop', 'Arrêter') : tl('Test', 'Tester')" data-testid="read-aloud-test" @click="test" />
      </div>
    </template>
    <p v-if="!readAloudSupported" class="muted settings-hint">{{ tl('This browser has no voices.', 'Ce navigateur n’a pas de voix.') }}</p>
  </div>
</template>

<style scoped>
.read-aloud-voice-row { flex-direction: column; align-items: stretch; gap: 10px; }
.read-aloud-voice { width: 100%; }
.read-aloud-lang { font-size: 11px; color: var(--muted); white-space: nowrap; }
.read-aloud-actions { display: flex; margin-top: 12px; }
</style>
