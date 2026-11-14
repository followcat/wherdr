<script setup lang="ts">
// Tasks to review: an agent's question. Its summary by Claude Haiku on top
// (pmSummary.ts, none while the pace holds it), the agent's whole last message
// folded under it (open alone when there is no summary), drawn as in the chat
// (Markdown, `wherdr` blocks), last; first the options of its `choices` line
// as buttons and a field for another answer. Each sends `send` with the text,
// which ReviewSheet types to the agent (POST /api/pm/answer).
import type { Card } from '#shared/pm/board'

const props = defineProps<{ card: Card, busy: boolean, sent?: string }>()
const emit = defineEmits<{ send: [text: string] }>()
const asks = computed(() => props.card.asks!)
const full = computed(() => asks.value.full || asks.value.text)
const summary = computed(() => (asks.value.tldr ? md(asks.value.tldr, { plain: true }) : ''))
const html = computed(() => md(full.value))
const options = computed(() => messageChoices(full.value))
const other = ref('')
const send = (text: string) => { if (text.trim() && !props.busy && !props.sent) emit('send', text.trim()) }
// A choice button drawn in the message itself answers too.
const onMessageClick = (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.q-choice')
  if (b?.dataset.a) send(b.dataset.a)
}
</script>

<template>
  <section class="question" data-testid="review-question">
    <p class="mono-label">{{ tl('Its agent asks a question') }}</p>
    <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
    <div v-if="summary" class="question-tldr md-body" data-testid="review-question-tldr" v-html="summary" />
    <div v-if="options.length" class="question-choices" role="group" :aria-label="tl('Answers')">
      <UButton v-for="o in options" :key="o" size="xl" color="neutral" variant="outline" :class="{ confirmed: sent === o }"
        :icon="sent === o ? 'i-lucide-check' : undefined" :disabled="busy || (!!sent && sent !== o)" :data-choice="o" data-testid="review-choice" @click="send(o)">{{ o }}</UButton>
    </div>
    <form class="question-other" data-testid="review-other" @submit.prevent="send(other)">
      <UTextarea v-model="other" :rows="1" autoresize maxlength="4000" size="xl" :placeholder="tl('Another answer')" :aria-label="tl('Another answer')" data-testid="review-other-text" />
      <UButton type="submit" color="primary" size="xl" icon="i-lucide-send" :loading="busy" :disabled="!other.trim() || !!sent" data-testid="review-other-send">{{ sent && !options.includes(sent) ? tl('Sent') : tl('Send') }}</UButton>
    </form>
    <details class="question-full" :open="!summary || undefined" data-testid="review-question-full">
      <summary class="mono-label"><UIcon name="i-lucide-chevron-right" class="question-fold" />{{ tl('Full question') }}</summary>
      <div class="md-body question-md" @click="onMessageClick">
        <ChatMarkdown :html="html" :typing="null" />
      </div>
    </details>
  </section>
</template>

<style scoped>
.question { display: grid; gap: 10px; min-width: 0; }
.question p { margin: 0; }
.question-tldr { padding: 10px 12px; border: 1px solid var(--line); border-left: 2px solid var(--accent); background: var(--surface); overflow-wrap: anywhere; }
.question-tldr :deep(:is(p, ul, ol)) { margin: 0 0 .4em; }
.question-tldr :deep(:last-child) { margin-bottom: 0; }
.question-full summary { display: flex; align-items: center; gap: 4px; min-height: 32px; cursor: pointer; color: var(--accent); list-style: none; }
.question-full summary::-webkit-details-marker { display: none; }
.question-fold { width: 14px; height: 14px; transition: transform .15s ease-out; }
.question-full[open] .question-fold { transform: rotate(90deg); }
.question-md { min-width: 0; padding: 4px 0 0; overflow-wrap: anywhere; }
.question-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.question-choices .confirmed { pointer-events: none; border-color: var(--done); background: var(--done); color: var(--bg); }
.question-other { display: flex; gap: 8px; align-items: flex-end; min-width: 0; }
.question-other > :first-child { flex: 1; min-width: 0; }
@media (max-width: 699px) {
  .question-choices > * { flex: 1 1 100%; justify-content: center; }
}
</style>
