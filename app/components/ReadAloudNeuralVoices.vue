<script setup lang="ts">
// Settings › Conversation › Read aloud › Voice of wherdr: one row per language
// voice (voices.json, the default ones), with its size, attribution, Install /
// progress / Cancel / Delete and a Test. A reply is read by the voice of its
// language; one not installed here falls back to the device's voices.
// Install and Test show what they measured on this device (download, load,
// first sentence, speed, heap): the figures recorded in voices.json.
// Rows styled like DictationDeviceSettings.vue.
import { neuralVoice, speak, speakingId, stopSpeaking } from '~/composables/useReadAloud'
import { fmtBytes } from '~/utils/bytes'
import { cancelInstall, fetchCommand, MissingOnServer, storedBytes, watchInstall } from '~/utils/dictation/modelStore'
import type { Progress } from '~/utils/dictation/modelStore'
import { asStored, VOICES, voiceBytes } from '~/utils/speech/neuralVoice'
import type { Voice, VoiceStats } from '~/utils/speech/neuralVoice'

const voices = VOICES.filter(v => v.default)
const have = reactive<Record<string, number>>({})
const progress = reactive<Record<string, Progress | null>>({})
const errors = reactive<Record<string, string>>({})
const downloadMs = reactive<Record<string, number>>({})
const measured = reactive<Record<string, VoiceStats>>({})
const canKeep = typeof caches !== 'undefined'
const LANGS: Record<string, string> = { fr: 'French', en: 'English' }
// Spoken in the voice's own language: sample speech, not interface text.
const SAMPLES: Record<string, string> = {
  fr: 'Bonjour ! Voici comment les réponses en français seront lues.',
  en: 'Hello! This is how replies in English will sound.',
}

const installed = (v: Voice) => (have[v.id] ?? 0) >= voiceBytes(v)

async function refresh(v: Voice) {
  have[v.id] = await storedBytes(asStored(v)).catch(() => 0)
}

async function follow(v: Voice, run: Promise<void>, startedAt?: number) {
  errors[v.id] = ''
  try {
    await run
    if (startedAt != null) downloadMs[v.id] = performance.now() - startedAt
  }
  catch (e) {
    if (e instanceof MissingOnServer) errors[v.id] = `${t('The wherdr server does not have this voice’s files. On the server, in the wherdr folder, run:')} ${fetchCommand(asStored(v))}`
    else if ((e as Error).name !== 'AbortError') errors[v.id] = (e as Error).message
  }
  finally {
    progress[v.id] = null
    await refresh(v)
    await neuralVoice?.refresh()
  }
}

const onRun = (v: Voice) => (p: Progress) => {
  progress[v.id] = p
  if (!p.server) have[v.id] = p.got
}

function install(v: Voice) {
  progress[v.id] = { got: have[v.id] ?? 0, total: voiceBytes(v) }
  follow(v, neuralVoice!.install(v, onRun(v)), performance.now())
}

async function remove(v: Voice) {
  if (speakingId.value === `settings:${v.id}`) stopSpeaking()
  delete downloadMs[v.id]
  delete measured[v.id]
  await neuralVoice?.remove(v).catch(e => toast((e as Error).message, true))
  await refresh(v)
}

function test(v: Voice) {
  if (speakingId.value === `settings:${v.id}`) return stopSpeaking()
  speak(`settings:${v.id}`, SAMPLES[v.lang] ?? SAMPLES.en!, v)
}

// When a Test ends, keep what it measured.
watch(speakingId, (_now, was) => {
  const s = neuralVoice?.stats()
  if (was?.startsWith('settings:') && s && was === `settings:${s.voice}`) measured[s.voice] = { ...s }
})

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
function measures(v: Voice) {
  const s = measured[v.id]
  const parts: string[] = []
  if (downloadMs[v.id] != null) parts.push(`${t('Download')} ${secs(downloadMs[v.id]!)}`)
  if (s?.loadMs != null) parts.push(`${t('Load')} ${secs(s.loadMs)}`)
  if (s?.firstMs != null) parts.push(`${t('First sentence')} ${secs(s.firstMs)}`)
  if (s?.audioMs) parts.push(`${t('Real-time factor')} ${(s.genMs / s.audioMs).toFixed(2)}`)
  if (s?.heap) parts.push(`${t('Heap')} ${fmtBytes(s.heap)}`)
  return parts.join(' · ')
}

onMounted(async () => {
  await Promise.all(voices.map(refresh))
  for (const v of voices) {
    const run = watchInstall(v.id, onRun(v))
    if (run) follow(v, run)
  }
})

const pct = (p: Progress) => Math.floor((p.got / Math.max(1, p.total)) * 100)
</script>

<template>
  <div class="neural-voices" data-testid="read-aloud-neural">
    <div v-for="v in voices" :key="v.id" class="neural-voice" :data-voice="v.id">
      <div class="neural-voice-text">
        <b>{{ v.name }} · {{ t(LANGS[v.lang] ?? v.lang) }}</b>
        <small class="neural-voice-meta">{{ v.locale }} · {{ fmtBytes(voiceBytes(v)) }}</small>
        <small data-testid="voice-attribution">{{ v.attribution }}</small>
      </div>
      <div class="neural-voice-state" data-testid="voice-state">
        <small v-if="neuralVoice && !neuralVoice.fits(v)" class="neural-voice-error" role="status">{{ t('Too large for this device: replies in this language use the device’s voices.') }}</small>
        <template v-if="progress[v.id]">
          <progress :value="progress[v.id]!.got" :max="progress[v.id]!.total" />
          <small v-if="progress[v.id]!.server">{{ t(`Preparing on the server… ${pct(progress[v.id]!)} %`) }}</small>
          <small v-else>{{ pct(progress[v.id]!) }} % · {{ fmtBytes(progress[v.id]!.got) }} / {{ fmtBytes(progress[v.id]!.total) }}</small>
          <UButton color="neutral" variant="outline" size="md" :label="t('Cancel')" data-testid="voice-cancel" @click="cancelInstall(v.id)" />
        </template>
        <template v-else-if="installed(v)">
          <small><UIcon name="i-lucide-check" /> {{ t('Installed') }}</small>
          <UButton color="neutral" variant="outline" size="md" :icon="speakingId === `settings:${v.id}` ? 'i-lucide-square' : 'i-lucide-volume-2'" :label="speakingId === `settings:${v.id}` ? t('Stop') : t('Test')" data-testid="voice-test" @click="test(v)" />
          <UButton color="neutral" variant="ghost" size="md" icon="i-lucide-trash-2" :label="t('Delete')" data-testid="voice-delete" @click="remove(v)" />
        </template>
        <template v-else>
          <small v-if="have[v.id]">{{ t('Partly downloaded') }} · {{ fmtBytes(have[v.id]!) }}</small>
          <UButton color="primary" variant="outline" size="md" icon="i-lucide-download" :disabled="!canKeep || !neuralVoice" :label="have[v.id] ? t('Resume') : t(`Install · ${fmtBytes(voiceBytes(v))}`)" data-testid="voice-install" @click="install(v)" />
          <UButton v-if="have[v.id]" color="neutral" variant="ghost" size="md" :label="t('Delete')" data-testid="voice-delete" @click="remove(v)" />
        </template>
        <small v-if="measures(v)" class="neural-voice-measure" data-testid="voice-measure">{{ measures(v) }}</small>
        <small v-if="errors[v.id]" class="neural-voice-error" role="status">{{ errors[v.id] }}</small>
      </div>
    </div>
    <p class="muted settings-hint">{{ t('Each reply is read by the voice of its language, French or English. Until that voice is installed, the device’s voices read it. The text never leaves this device.') }}</p>
  </div>
</template>

<style scoped>
.neural-voices { margin-top: 12px; }
.neural-voice { background: var(--bg-2); border: 1px solid var(--line); }
.neural-voice + .neural-voice { border-top: 0; }
.neural-voice-text { padding: 13px 16px 8px; min-width: 0; }
.neural-voice-text b { display: block; font-weight: 600; font-size: 15px; }
.neural-voice-text small { display: block; font-size: 12.5px; color: var(--muted); margin-top: 3px; }
.neural-voice-state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 0 16px 13px; }
.neural-voice-state small { font: 500 11px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
.neural-voice-state progress { flex: 1 1 100%; height: 4px; appearance: none; border: 0; background: var(--line); accent-color: var(--accent); }
.neural-voice-state progress::-webkit-progress-bar { background: var(--line); }
.neural-voice-state progress::-webkit-progress-value { background: var(--accent); }
.neural-voice-state progress::-moz-progress-bar { background: var(--accent); }
.neural-voice-error { display: block !important; flex-basis: 100%; color: var(--rose) !important; text-transform: none !important; overflow-wrap: anywhere; }
.neural-voice-measure { flex-basis: 100%; text-transform: none !important; letter-spacing: 0 !important; }
.neural-voices .settings-hint { margin-top: 10px; }
</style>
