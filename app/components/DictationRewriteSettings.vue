<script setup lang="ts">
// Settings › Conversation › Dictation › Rewrite, for every engine: after the
// transcript, an optional pass through a cheap OpenRouter chat model (through
// the wherdr server and its key), with an editable prompt and a personal
// dictionary. Off by default; kept on this device.
import type { TextModel } from '#shared/dictationModels'
import { DEFAULT_REWRITE_PROMPT, REWRITE_PROMPT_MAX } from '#shared/dictationRewrite'
import { readRewriteOptions, writeRewriteOptions } from '~/utils/dictation/rewrite'

const opts = reactive(readRewriteOptions())
watch(opts, o => writeRewriteOptions({ ...o }))

const keySet = ref<boolean | null>(null)
const models = ref<TextModel[]>([])
const fallback = ref('') // the server's default: the cheapest paid model

async function loadModels() {
  try {
    const r = await api<{ models: TextModel[], default?: string }>('/api/dictation/text-models')
    models.value = r.models
    fallback.value = r.default || ''
  } catch { /* keep the list we have */ }
}
onMounted(async () => {
  try { keySet.value = Boolean((await api<{ set: boolean }>('/api/dictation/status')).set) }
  catch { keySet.value = false }
  if (keySet.value) loadModels()
})

// '' follows the server's default; picking that model keeps following it.
const model = computed({
  get: () => opts.model || fallback.value,
  set: (v: string) => { opts.model = v === fallback.value ? '' : v },
})
const perM = (p: NonNullable<TextModel['perM']>) => p.in === 0 && p.out === 0
  ? tl('Free', 'Gratuit')
  : tl(`$${p.in} in · $${p.out} out / M`, `${String(p.in).replace('.', ',')} $ entrée · ${String(p.out).replace('.', ',')} $ sortie / M`)
const modelItems = computed(() => {
  // The default first; a saved model gone from OpenRouter stays shown.
  const def = models.value.filter(m => m.id === fallback.value)
  const rest = models.value.filter(m => m.id !== fallback.value)
  const list = [...(opts.model && !models.value.some(m => m.id === opts.model) ? [{ id: opts.model, name: opts.model }] : []), ...def, ...rest]
  return list.map(m => ({ value: m.id, label: m.name, description: m.id, price: m.perM ? perM(m.perM) : undefined }))
})
const defaultName = computed(() => models.value.find(m => m.id === fallback.value)?.name || fallback.value)

// The prompt field shows the default until it is edited.
const prompt = computed({
  get: () => opts.prompt || DEFAULT_REWRITE_PROMPT,
  set: (v: string) => { opts.prompt = v.trim() === DEFAULT_REWRITE_PROMPT ? '' : v },
})
const coarse = { base: 'pointer-coarse:text-[16px]' }
</script>

<template>
  <div class="dictation-rewrite" data-testid="dictation-rewrite">
    <span class="dictation-rewrite-label">{{ tl('Rewrite', 'Reformulation') }}</span>
    <label class="settings-toggle">
      <span>
        <b>{{ tl('Rewrite with a cheap model', 'Reformuler avec un modèle bon marché') }}</b>
        <small>{{ tl('After the transcript, a chat model on OpenRouter removes filler words and false starts and fixes punctuation. The text goes into the field as usual. If it fails, the raw transcript is kept.', 'Après la transcription, un modèle de chat sur OpenRouter retire les hésitations et faux départs et corrige la ponctuation. Le texte va dans le champ comme d’habitude. En cas d’échec, la transcription brute est gardée.') }}</small>
      </span>
      <USwitch v-model="opts.on" size="xl" data-testid="dictation-rewrite-on" />
    </label>
    <p v-if="keySet === false" class="dictation-rewrite-note muted" data-testid="dictation-rewrite-nokey">
      {{ tl('Needs an OpenRouter key: save it under Online above, then come back to your engine.', 'Il faut une clé OpenRouter : enregistre-la sous En ligne ci-dessus, puis reviens à ton moteur.') }}
    </p>
    <template v-if="opts.on">
      <label class="settings-toggle dictation-rewrite-col">
        <span>
          <b>{{ tl('Rewrite model', 'Modèle de reformulation') }}</b>
          <small v-if="fallback">{{ tl(`Default: the cheapest paid model right now, ${defaultName}.`, `Par défaut : le modèle payant le moins cher du moment, ${defaultName}.`) }}</small>
        </span>
        <USelectMenu
          v-model="model" :items="modelItems" value-key="value" :filter-fields="['label', 'value']" size="lg" class="w-full" virtualize
          :placeholder="tl('Save the key to load the list', 'Enregistre la clé pour charger la liste')"
          :search-input="{ placeholder: tl('Search a model', 'Chercher un modèle'), autocomplete: 'off', ui: coarse }"
          :aria-label="tl('Rewrite model', 'Modèle de reformulation')" data-testid="dictation-rewrite-model"
        >
          <template #item-trailing="{ item }">
            <DictationModelPrice :id="item.value" :price="item.price" />
          </template>
        </USelectMenu>
      </label>
      <label class="settings-toggle dictation-rewrite-col">
        <span>
          <b>{{ tl('Prompt', 'Consigne') }}</b>
          <small>{{ tl('Sent to the model with each text.', 'Envoyée au modèle avec chaque texte.') }}</small>
        </span>
        <UTextarea v-model="prompt" :rows="4" :maxrows="10" autoresize :maxlength="REWRITE_PROMPT_MAX" size="lg" class="w-full" :ui="coarse" data-testid="dictation-rewrite-prompt" />
        <UButton v-if="opts.prompt" color="neutral" variant="outline" size="sm" class="self-start" :label="tl('Reset to default', 'Revenir à la consigne par défaut')" @click="opts.prompt = ''" />
      </label>
    </template>
    <label class="settings-toggle dictation-rewrite-col">
      <span>
        <b>{{ tl('Personal dictionary', 'Dictionnaire personnel') }}</b>
        <small>{{ tl('One word or name per line (project names, people…). Given to the rewrite, and to the online engine as terms to recognise when its model takes them.', 'Un mot ou un nom par ligne (projets, personnes…). Donné à la reformulation, et au moteur en ligne comme termes à reconnaître quand son modèle les accepte.') }}</small>
      </span>
      <UTextarea
        v-model="opts.dictionary" :rows="3" :maxrows="10" autoresize size="lg" class="w-full mono" :ui="coarse" autocapitalize="none" autocorrect="off" :spellcheck="false"
        placeholder="wherdr&#10;herdr-core" data-testid="dictation-rewrite-dictionary"
      />
    </label>
  </div>
</template>

<style scoped>
.dictation-rewrite { margin-top: 20px; }
.dictation-rewrite-label { display: block; margin-bottom: 8px; font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.dictation-rewrite-col { flex-direction: column; align-items: stretch; gap: 10px; }
.dictation-rewrite-note { padding: 10px 16px; border: 1px solid var(--line); border-top: 0; font-size: 13px; }
</style>
