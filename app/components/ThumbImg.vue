<script setup lang="ts">
// One thumbnail of a message. A photo just sent from this device shows its
// local preview until the uploaded copy has loaded (utils/sentPreviews.ts).
// A failed load is retried once after a short delay, or at once when the page
// comes back to the front; still failing: a placeholder that reloads it.
import { dropPreview, previewFor } from '~/utils/sentPreviews'

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ open: [] }>()
const RETRY_MS = 1500

const attempt = ref(0)
const state = ref<'loading' | 'ok' | 'retry' | 'broken'>('loading')
const preview = ref(previewFor(props.src))
// A retry asks again under another URL: no failed answer reused.
const url = computed(() => attempt.value ? `${props.src}${props.src.includes('?') ? '&' : '?'}retry=${attempt.value}` : props.src)
let timer: ReturnType<typeof setTimeout> | undefined
let probe: HTMLImageElement | null = null

function loaded() {
  state.value = 'ok'
  if (preview.value) dropPreview(props.src)
  preview.value = null
}
function failed() {
  if (attempt.value > 0) { state.value = 'broken'; return }
  state.value = 'retry'
  timer = setTimeout(retry, RETRY_MS)
}
function retry() {
  clearTimeout(timer)
  timer = undefined
  attempt.value++
  state.value = 'loading'
}
// With a preview on screen, the uploaded copy loads out of sight.
watch(url, (u) => {
  if (!preview.value) return
  if (probe) probe.onload = probe.onerror = null
  probe = new Image()
  probe.onload = loaded
  probe.onerror = failed
  probe.src = u
}, { immediate: true })
function onVisible() { if (document.visibilityState === 'visible' && state.value === 'retry') retry() }
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
  clearTimeout(timer)
  if (probe) probe.onload = probe.onerror = null
})
</script>

<template>
  <button v-if="state === 'broken'" type="button" class="thumb-missing thumb-reload" @click="retry">
    <UIcon name="i-lucide-image-off" /><span>{{ t('Tap to reload') }}</span>
  </button>
  <img
    v-else-if="preview" class="msg-img" :src="preview" alt="" decoding="async" @click="emit('open')"
  >
  <img
    v-else class="msg-img" :class="{ 'thumb-wait': state === 'retry' }" :src="url" alt="" loading="lazy" decoding="async"
    @load="loaded" @error="failed" @click="emit('open')"
  >
</template>
