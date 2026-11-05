<script setup lang="ts">
// Play / Stop under an agent reply (composables/useReadAloud.ts). Hidden when
// read aloud is off in Settings or the browser has no voices.
import { readAloudEngine, speak, speakingId, stopSpeaking } from '~/composables/useReadAloud'

const props = defineProps<{ id: string, text: string }>()
const playing = computed(() => speakingId.value === props.id)
function toggle() {
  if (playing.value) stopSpeaking()
  else speak(props.id, props.text)
}
</script>

<template>
  <button
    v-if="readAloudEngine !== 'off'" type="button" class="msg-reply read-aloud" :class="{ playing }"
    :aria-pressed="playing" data-testid="read-aloud" @click="toggle"
  >
    <UIcon :name="playing ? 'i-lucide-square' : 'i-lucide-volume-2'" />
    <span>{{ playing ? tl('Stop', 'Arrêter') : tl('Play', 'Lire') }}</span>
  </button>
</template>
