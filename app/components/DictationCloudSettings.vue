<script setup lang="ts">
// Settings › Conversation › Dictation › Online (OpenRouter): the key, kept on
// the wherdr server and never shown again (only its last 4 characters), then
// this device's model, ZDR and pane terms, a Test button and the privacy note.
// The model list is OpenRouter's speech-to-text models, fetched by the server
// once a key is saved (GET /api/dictation/models), searched here.
import { FALLBACK_CLOUD_MODELS, type DictationModel } from '#shared/dictationModels'
import { readCloudOptions, writeCloudOptions } from '~/utils/dictation/cloudOptions'
import { TAKE_RATE } from '~/utils/dictation/engine'

interface KeyStatus { set: boolean, last4?: string, env?: boolean }
const status = ref<KeyStatus | null>(null)
const keyInput = ref('')
const replacing = ref(false)
const busy = ref(false)
const testResult = ref<{ ok: boolean, text: string } | null>(null)
const opts = reactive(readCloudOptions())
watch(opts, o => writeCloudOptions({ ...o }))

const models = ref<DictationModel[]>(FALLBACK_CLOUD_MODELS)
// A saved model missing from the list (gone from OpenRouter) stays shown.
const modelItems = computed(() => {
  const list = models.value.some(m => m.id === opts.model) ? models.value : [{ id: opts.model, name: opts.model }, ...models.value]
  return list.map(m => ({ value: m.id, label: m.name, description: m.id, price: m.perMinute }))
})
const price = (n: number) => tl(`$${n} / min`, `${String(n).replace('.', ',')} $ / min`)

async function loadModels() {
  try { models.value = (await api<{ models: DictationModel[] }>('/api/dictation/models')).models }
  catch { /* keep the list we have */ }
}

async function load() {
  try { status.value = await api<KeyStatus>('/api/dictation/status') }
  catch (e) { toast((e as Error).message, true) }
  if (status.value?.set) loadModels()
}
onMounted(load)

async function save() {
  busy.value = true
  try {
    status.value = await api<KeyStatus>('/api/dictation/key', { key: keyInput.value })
    keyInput.value = ''
    replacing.value = false
    testResult.value = null
    loadModels()
  } catch (e) { toast((e as Error).message, true) }
  finally { busy.value = false }
}

async function remove() {
  busy.value = true
  try {
    const r = await fetch('/api/dictation/key', { method: 'DELETE' })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    status.value = data
    testResult.value = null
  } catch (e) { toast((e as Error).message, true) }
  finally { busy.value = false }
}

// One second of silence through the relay: the key, the model and ZDR at once.
async function test() {
  busy.value = true
  testResult.value = null
  try {
    const { cloudTranscribe } = await import('~/utils/dictation/cloud')
    const r = await cloudTranscribe({ pcm: new Float32Array(TAKE_RATE), seconds: 1 }, { terms: [], signal: AbortSignal.timeout(60_000) }, { ...opts })
    testResult.value = { ok: true, text: tl(`Key valid · $${(r.cost ?? 0).toFixed(6)} · ${r.ms} ms`, `Clé valide · ${(r.cost ?? 0).toFixed(6)} $ · ${r.ms} ms`) }
  } catch (e) { testResult.value = { ok: false, text: (e as Error).message } }
  finally { busy.value = false }
}
</script>

<template>
  <div class="dictation-cloud" data-testid="dictation-cloud">
    <div class="dictation-cloud-key">
      <span class="dictation-cloud-label">{{ tl('OpenRouter key', 'Clé OpenRouter') }}</span>
      <template v-if="status?.set && !replacing">
        <code data-testid="dictation-key-mask">••••••••{{ status.last4 }}</code>
        <small v-if="status.env" class="muted">{{ tl('Set by OPENROUTER_API_KEY on the server.', 'Définie par OPENROUTER_API_KEY sur le serveur.') }}</small>
        <span v-else class="dictation-cloud-actions">
          <UButton color="neutral" variant="outline" size="sm" :label="tl('Replace', 'Remplacer')" @click="replacing = true" />
          <UButton color="error" variant="outline" size="sm" :label="tl('Remove', 'Retirer')" :loading="busy" @click="remove" />
        </span>
      </template>
      <form v-else-if="status" class="dictation-cloud-actions" @submit.prevent="save">
        <UInput
          v-model="keyInput" type="password" size="lg" class="mono dictation-cloud-input" autocomplete="off" autocapitalize="none" autocorrect="off" :spellcheck="false"
          placeholder="sk-or-v1-…" maxlength="256" :aria-label="tl('OpenRouter key', 'Clé OpenRouter')" data-testid="dictation-key-input"
        />
        <UButton type="submit" color="primary" size="lg" :label="tl('Save', 'Enregistrer')" :loading="busy" :disabled="!keyInput.trim()" />
        <UButton v-if="replacing" color="neutral" variant="ghost" size="lg" :label="t('Cancel')" @click="replacing = false" />
      </form>
    </div>
    <label class="settings-toggle dictation-cloud-model-row">
      <span><b>{{ tl('Model', 'Modèle') }}</b><small>{{ tl('OpenRouter’s speech-to-text models, once the key is saved. Whisper turbo costs about $0.0002 a minute.', 'Les modèles de transcription d’OpenRouter, une fois la clé enregistrée. Whisper turbo coûte environ 0,0002 $ la minute.') }}</small></span>
      <USelectMenu
        v-model="opts.model" :items="modelItems" value-key="value" :filter-fields="['label', 'value']" size="lg" class="dictation-cloud-model"
        :search-input="{ placeholder: tl('Search a model', 'Chercher un modèle'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
        :aria-label="tl('Model', 'Modèle')" data-testid="dictation-model"
      >
        <template #item-trailing="{ item }">
          <DictationModelPrice :id="item.value" :price="item.price === undefined ? undefined : price(item.price)" />
        </template>
      </USelectMenu>
    </label>
    <label class="settings-toggle">
      <span><b>{{ tl('Zero data retention (ZDR)', 'Aucune conservation (ZDR)') }}</b><small>{{ tl('Only providers that keep nothing. A model without one fails: Test shows it.', 'Seulement les fournisseurs qui ne gardent rien. Un modèle sans eux échoue : Tester le montre.') }}</small></span>
      <USwitch v-model="opts.zdr" color="success" size="xl" />
    </label>
    <label class="settings-toggle">
      <span><b>{{ tl('Send pane terms', 'Envoyer les termes du panneau') }}</b><small>{{ tl('Agent, machine and folder names, to recognise them better.', 'Noms d’agent, de machine et de dossier, pour mieux les reconnaître.') }}</small></span>
      <USwitch v-model="opts.terms" color="success" size="xl" />
    </label>
    <div class="dictation-cloud-actions">
      <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-audio-lines" :label="tl('Test', 'Tester')" :loading="busy" :disabled="!status?.set" data-testid="dictation-test" @click="test" />
      <small v-if="testResult" :class="testResult.ok ? 'muted' : 'dictation-cloud-error'" role="status">{{ testResult.text }}</small>
    </div>
    <p class="muted settings-lead">
      {{ tl('The audio leaves your network: the wherdr server sends each take to OpenRouter, then to the model’s provider. With ZDR, only providers that keep nothing are used. The key stays on the wherdr server and is never sent back to the browser.', 'L’audio quitte ton réseau : le serveur wherdr envoie chaque prise à OpenRouter, puis au fournisseur du modèle. Avec ZDR, seuls les fournisseurs qui ne gardent rien sont utilisés. La clé reste sur le serveur wherdr et n’est jamais renvoyée au navigateur.') }}
    </p>
  </div>
</template>

<style scoped>
.dictation-cloud { margin-top: 12px; }
.dictation-cloud-key { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 13px 16px; background: var(--bg-2); border: 1px solid var(--line); border-bottom: 0; }
.dictation-cloud-label { font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); width: 100%; }
.dictation-cloud-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dictation-cloud > .dictation-cloud-actions { margin-top: 12px; }
.dictation-cloud-input { flex: 1 1 220px; min-width: 0; }
/* The list's names are long: the select gets a row of its own. */
.dictation-cloud-model-row { flex-direction: column; align-items: stretch; gap: 10px; }
.dictation-cloud-model { width: 100%; }
.dictation-cloud-error { color: var(--rose); }
.dictation-cloud .settings-lead { margin-top: 12px; }
</style>
