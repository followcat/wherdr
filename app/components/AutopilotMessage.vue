<script setup lang="ts">
defineProps<{ text: string }>()
const emit = defineEmits<{ copy: [text: string] }>()
const canHover = ref(false)
const hovered = ref(false)
const focused = ref(false)
const showCopy = computed(() => canHover.value && (hovered.value || focused.value))
let media: MediaQueryList | undefined
function updatePointer() {
  canHover.value = media?.matches ?? false
  hovered.value = false
  focused.value = false
}
function focusOut(event: FocusEvent) {
  focused.value = event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)
}
onMounted(() => {
  media = window.matchMedia('(hover: hover) and (pointer: fine)')
  updatePointer()
  media.addEventListener('change', updatePointer)
})
onBeforeUnmount(() => media?.removeEventListener('change', updatePointer))
</script>

<template>
  <div class="msg-autopilot" @mouseenter="hovered = true" @mouseleave="hovered = false" @focusin="focused = true" @focusout="focusOut">
    <div class="msg-system"><span>{{ t('Autopilot') }}</span></div>
    <div class="msg-autopilot-body">
      <div class="msg-autopilot-text"><FoldText>{{ text }}</FoldText></div>
      <UButton v-show="canHover" class="msg-autopilot-copy" :style="{ opacity: showCopy ? 1 : 0, pointerEvents: showCopy ? 'auto' : 'none' }" icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" :aria-label="t('Copy message')" @click="emit('copy', text)" />
    </div>
  </div>
</template>
