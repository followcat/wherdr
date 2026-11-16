<script setup lang="ts">
// A field's save state (useAutosave), next to its label: a small spinner while
// it saves, then a discreet Saved ✓ that fades out. Errors show under the field.
import type { SaveState } from '~/composables/useAutosave'

defineProps<{ s?: SaveState }>()
</script>

<template>
  <span class="saved-mark" role="status" data-testid="saved-mark">
    <Transition name="saved-fade">
      <UIcon v-if="s === 'saving'" name="i-lucide-loader-circle" class="saved-spin" :aria-label="tl('Saving')" />
      <span v-else-if="s === 'saved'" class="saved-ok">{{ tl('Saved') }} <UIcon name="i-lucide-check" /></span>
    </Transition>
  </span>
</template>

<style scoped>
.saved-mark { display: inline-flex; align-items: center; min-height: 1em; margin-left: 8px; vertical-align: middle; color: var(--muted); font: 500 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.saved-ok { display: inline-flex; align-items: center; gap: 4px; color: var(--done); }
.saved-spin { animation: saved-turn 1s linear infinite; }
@keyframes saved-turn { to { transform: rotate(360deg); } }
.saved-fade-leave-active { transition: opacity .6s; }
.saved-fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .saved-spin { animation: none; } .saved-fade-leave-active { transition: none; } }
</style>
