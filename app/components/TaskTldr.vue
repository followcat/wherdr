<script setup lang="ts">
// What To do shows before the user decides: the task's TL;DR by Claude Haiku
// (pmSummary.ts), Markdown, then the slot (a visual merge's screenshots) and a
// link to the full reports in Comments. No TL;DR (none yet, or a new one
// waiting for the pace): the worker's and the reviewer's notes, as before.
import type { Card } from '#shared/pm/board'

const props = defineProps<{ card: Card, worker?: string, review?: string }>()
const emit = defineEmits<{ comments: [] }>()
const html = computed(() => (props.card.tldr ? md(props.card.tldr, { plain: true }) : ''))
</script>

<template>
  <section v-if="html" class="tldr" data-testid="todo-tldr">
    <span class="mono-label">{{ tl('TL;DR') }}</span>
    <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
    <div class="md-body tldr-md" v-html="html" />
  </section>
  <template v-else>
    <p v-if="card.tldrWaits" class="mono-label muted" data-testid="todo-tldr-waits">{{ tl('TL;DR waits for the pace') }}</p>
    <TaskNotes v-if="worker || review" :worker="worker" :review="review" />
  </template>
  <slot />
  <button v-if="html" type="button" class="tldr-more mono-label" data-testid="todo-comments" @click="emit('comments')">{{ tl('Full reports in Comments') }} →</button>
</template>

<style scoped>
.tldr { display: grid; gap: 6px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-left: 2px solid var(--accent); background: var(--surface); }
.tldr-md { overflow-wrap: anywhere; color: var(--text); }
.tldr-md :deep(:is(p, ul, ol)) { margin: 0 0 .4em; }
.tldr-md :deep(:last-child) { margin-bottom: 0; }
.tldr-more { justify-self: start; align-self: flex-start; min-height: 32px; padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; }
.tldr-more:hover { text-decoration: underline; }
</style>
