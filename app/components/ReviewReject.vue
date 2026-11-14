<script setup lang="ts">
// Reject in the review sheet: what to change, the screenshots that are wrong
// (tap to pick, ShotPicker) and the user's own ones (added from a file or pasted,
// POST /api/pm/user-shot, picked at once). The sheet sends it all back to the
// task's worker (Send back, POST /api/pm/step-back with the shots).
import type { Card } from '#shared/pm/board'

const props = defineProps<{ card: Card, busy: boolean }>()
const emit = defineEmits<{ send: [note: string, shots: string[]], cancel: [] }>()

// The newest step's screenshots, then the user's own.
const theirs = computed(() => { const s = shotSteps(props.card)[0]; return s ? props.card.state!.shots![s.id]!.map(x => x.file) : [] })
const mine = ref<string[]>([])
const files = computed(() => [...theirs.value, ...mine.value])
const note = ref('')
const picked = ref<string[]>([])
const adding = ref(false)
const error = ref('')
const TYPES = ['image/png', 'image/jpeg', 'image/webp']

async function add(list: Iterable<File>) {
  const images = [...list].filter(f => TYPES.includes(f.type))
  if (!images.length) return
  adding.value = true
  error.value = ''
  try {
    for (const f of images) {
      const r = await fetch(`/api/pm/user-shot?task=${encodeURIComponent(props.card.id)}`, { method: 'POST', headers: { 'content-type': f.type }, body: f })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || `HTTP ${r.status}`))
      mine.value = [...mine.value, d.file]
      picked.value = [...picked.value, d.file]
    }
  }
  catch (e) { error.value = (e as Error).message }
  finally { adding.value = false }
}
const onFile = (e: Event) => { const i = e.target as HTMLInputElement; add(i.files ?? []); i.value = '' }
const onPaste = (e: ClipboardEvent) => { const f = [...e.clipboardData?.files ?? []]; if (f.length) { e.preventDefault(); add(f) } }
const input = ref<HTMLInputElement | null>(null)
</script>

<template>
  <form class="reject" data-testid="review-reject" @submit.prevent="emit('send', note.trim(), picked)" @paste="onPaste">
    <p class="mono-label">{{ tl('Reject') }}</p>
    <p class="muted">{{ tl('It goes back to its worker with your note and the screenshots you pick.') }}</p>
    <UTextarea v-model="note" :rows="3" autoresize maxlength="2000" size="xl" :placeholder="tl('What to change')" autofocus data-testid="review-reject-note" />
    <span class="field-label">{{ tl('Screenshots that are wrong') }} <span class="muted">{{ tl('(optional)') }}</span></span>
    <ShotPicker v-if="files.length" v-model="picked" :task="card.id" :files="files" />
    <input ref="input" type="file" :accept="TYPES.join(',')" multiple hidden data-testid="review-reject-file" @change="onFile">
    <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-image-plus" class="reject-add" :loading="adding" data-testid="review-reject-add" @click="input?.click()">{{ tl('Add a screenshot (or paste one)') }}</UButton>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="reject-actions">
      <UButton type="submit" color="error" size="xl" icon="i-lucide-undo-2" :loading="busy" :disabled="!note.trim() || adding" data-testid="review-reject-send">{{ tl('Send back') }}</UButton>
      <UButton color="neutral" variant="outline" size="xl" :disabled="busy" @click="emit('cancel')">{{ t('Cancel') }}</UButton>
    </div>
  </form>
</template>

<style scoped>
.reject { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--danger); }
.reject p { margin: 0; }
.reject-add { justify-self: start; }
.reject-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 699px) {
  .reject-actions > * { flex: 1 1 auto; justify-content: center; }
}
</style>
