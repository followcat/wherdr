<script setup lang="ts">
// A model's price in a dictation model picker, or, when OpenRouter gives no
// plain price for it (per hour, per token for audio…), a link to its page
// there: the unit is never guessed.
import { openRouterPage } from '#shared/dictationModels'

defineProps<{ id: string, price?: string }>()
</script>

<template>
  <span v-if="price" class="mono dictation-model-price">{{ price }}</span>
  <a
    v-else class="mono dictation-model-price dictation-model-link" :href="openRouterPage(id)" target="_blank" rel="noopener noreferrer"
    @pointerdown.stop @click.stop
  >{{ tl('Price: see OpenRouter', 'Prix : voir OpenRouter') }}</a>
</template>

<style scoped>
.dictation-model-price { font-size: 11px; color: var(--muted); white-space: nowrap; }
.dictation-model-link { text-decoration: underline; text-underline-offset: 2px; }
.dictation-model-link:hover { color: var(--text); }
</style>
