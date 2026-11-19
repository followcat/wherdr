<script setup lang="ts">
// Tasks to review: an agent's question. Its summary by Claude Haiku on top
// (pmSummary.ts, none while the pace holds it), the agent's whole last message
// folded under it (open alone when there is no summary), drawn as in the chat
// (Markdown, `wherdr` blocks, a `questions` card answered there), last; first the options of its `choices` line
// as buttons and a field for another answer. Each sends `send` with the text,
// which ReviewSheet types to the agent (POST /api/pm/answer). The button pressed alone
// loads until the server answered (the others disabled), then shows it was sent.
import type { Card } from '#shared/pm/board'
import { QUESTIONS_HOST, type QuestionsHost } from '~/utils/questionsCard'

const props = defineProps<{ card: Card, busy: boolean, sent?: string }>()
const emit = defineEmits<{ send: [text: string] }>()
const asks = computed(() => props.card.asks!)
const full = computed(() => asks.value.full || asks.value.text)
const summary = computed(() => (asks.value.tldr ? md(asks.value.tldr, { plain: true }) : ''))
const html = computed(() => md(full.value))
const options = computed(() => messageChoices(full.value))
const other = ref('')
// What was pressed: a choice's text, or 'other' (Send).
const pending = ref('')
const send = (text: string, from = text.trim()) => { if (text.trim() && !props.busy && !props.sent) { pending.value = from; emit('send', text.trim()) } }
const sending = (from: string) => props.busy && pending.value === from
// A `questions` card in the message (QuestionsCard.vue) sends all its answers at once.
provide<QuestionsHost>(QUESTIONS_HOST, {
  state: () => ({ live: !props.busy && !props.sent, given: props.sent ?? null }),
  send: (_el, text) => send(text, 'card'),
})
// Sent from the field (Send), not a choice: Sent on its button.
const sentOther = computed(() => !!props.sent && !options.value.includes(props.sent))
// A choice button drawn in the message itself answers too (its choice button loads).
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
        :icon="sent === o ? 'i-lucide-check' : undefined" :loading="sending(o)" :disabled="busy || (!!sent && sent !== o)" :data-choice="o" data-testid="review-choice" @click="send(o)">{{ o }}</UButton>
    </div>
    <form class="question-other" data-testid="review-other" @submit.prevent="send(other, 'other')">
      <UTextarea v-model="other" :rows="1" autoresize maxlength="4000" size="xl" :placeholder="tl('Another answer')" :aria-label="tl('Another answer')" data-testid="review-other-text" />
      <UButton type="submit" color="primary" size="xl" :icon="sentOther ? 'i-lucide-check' : 'i-lucide-send'" :class="{ confirmed: sentOther }" :loading="sending('other')" :disabled="busy || !other.trim() || !!sent" data-testid="review-other-send">{{ sentOther ? tl('Sent') : tl('Send') }}</UButton>
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
.question .confirmed { pointer-events: none; border-color: var(--done); background: var(--done); color: var(--bg); }
.question-other { display: flex; gap: 8px; align-items: flex-end; min-width: 0; }
.question-other > :first-child { flex: 1; min-width: 0; }
@media (max-width: 699px) {
  .question-choices > * { flex: 1 1 100%; justify-content: center; }
}
</style>
