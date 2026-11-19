<script setup lang="ts">
// A `questions` element of a `wherdr` block (utils/markdown.ts), mounted by
// ChatMarkdown in its place: each question with its options, one pick per
// question (or *Other* and the user's own words), then one Send for all, as a
// single message (utils/questionsCard.ts). An unanswered question is sent as
// `skip`; Send needs at least one answer. Keys while the focus is in the card
// (not in a field): a digit goes to that question, a letter picks that option
// and moves to the next question. `live`: it can still be answered (the
// agent's last message, not answered yet); `given`: the reply sent, shown.
import type { WherdrQuestion } from '~/utils/markdown'
import { optionLetter, questionsReply, readQuestionsReply, SKIP, type QuestionPick } from '~/utils/questionsCard'

const props = defineProps<{ items: WherdrQuestion[], live: boolean, given: string | null }>()
const emit = defineEmits<{ send: [text: string] }>()
// Sent from here: no second Send while the reply reaches the conversation.
const sent = ref(false)
const live = computed(() => props.live && !sent.value)
const root = ref<HTMLElement | null>(null)
const mine = ref<QuestionPick[]>(props.items.map(() => null))
const other = ref<boolean[]>(props.items.map(() => false))
const picks = computed(() => (props.given !== null ? readQuestionsReply(props.items, props.given) : mine.value))
const isText = (p: QuestionPick | undefined): p is { text: string } => !!p && 'text' in p && !!p.text.trim()
const answered = (p: QuestionPick | undefined) => !!p && ('option' in p || isText(p))
const chosen = (i: number, k: number) => { const p = picks.value[i]; return !!p && 'option' in p && p.option === k }
const left = computed(() => picks.value.filter(p => !answered(p)).length)
const canSend = computed(() => live.value && left.value < props.items.length)

function pick(i: number, option: number) {
  if (!live.value) return
  const was = mine.value[i]
  mine.value[i] = was && 'option' in was && was.option === option ? null : { option }
  other.value[i] = false
}
async function typeOther(i: number) {
  if (!live.value) return
  other.value[i] = !other.value[i]
  mine.value[i] = other.value[i] ? { text: '' } : null
  await nextTick()
  if (other.value[i]) root.value?.querySelector<HTMLInputElement>(`[data-other="${i}"]`)?.focus()
}
const setText = (i: number, text: string) => { mine.value[i] = { text } }
function send() {
  if (!canSend.value) return
  sent.value = true
  emit('send', questionsReply(props.items, mine.value))
}

const focusQuestion = (i: number) => root.value?.querySelector<HTMLElement>(`[data-q="${i}"] button`)?.focus()
function onKey(e: KeyboardEvent) {
  if (!live.value || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return
  const at = Number((e.target as HTMLElement).closest<HTMLElement>('[data-q]')?.dataset.q ?? 0)
  const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1
  const letter = /^[a-d]$/i.test(e.key) ? e.key.toUpperCase().charCodeAt(0) - 65 : -1
  if (digit >= 0 && digit < props.items.length) { e.preventDefault(); focusQuestion(digit) }
  else if (letter >= 0 && letter < props.items[at]!.options.length) {
    e.preventDefault()
    pick(at, letter)
    focusQuestion(Math.min(at + 1, props.items.length - 1))
    if (at === props.items.length - 1) root.value?.querySelector<HTMLElement>('[data-testid="questions-send"]')?.focus()
  }
}
</script>

<template>
  <div ref="root" class="qs" :class="{ done: !live }" role="group" :aria-label="tl('Questions')" data-testid="questions-card" @keydown="onKey">
    <div v-for="(q, i) in items" :key="i" class="qs-item" :data-q="i">
      <p class="qs-q"><span class="qs-n">{{ i + 1 }}</span>{{ q.q }}</p>
      <div class="qs-opts">
        <button v-for="(o, k) in q.options" :key="o" type="button" class="qs-opt" :disabled="!live"
          :aria-pressed="chosen(i, k)" :data-testid="`questions-opt-${i}-${k}`" @click="pick(i, k)">
          <span class="qs-key" aria-hidden="true">{{ optionLetter(k) }}</span>{{ o }}
        </button>
        <button v-if="live" type="button" class="qs-opt qs-other-btn" :aria-pressed="!!other[i]" :data-testid="`questions-other-${i}`" @click="typeOther(i)">{{ tl('Other…') }}</button>
      </div>
      <input v-if="live && other[i]" class="qs-input" :data-other="i" maxlength="400" :placeholder="tl('Your answer')" :aria-label="tl('Your answer')"
        :value="isText(mine[i]) ? (mine[i] as { text: string }).text : ''" @input="setText(i, ($event.target as HTMLInputElement).value)" @keydown.enter="!imeComposing($event) && ($event.preventDefault(), send())">
      <p v-else-if="isText(picks[i])" class="qs-given">↳ {{ (picks[i] as { text: string }).text }}</p>
      <p v-else-if="given !== null && !answered(picks[i])" class="qs-given">{{ SKIP }}</p>
    </div>
    <div v-if="live" class="qs-foot">
      <span class="qs-left">{{ left ? tl(`${left} unanswered, sent as skip`) : '' }}</span>
      <button type="button" class="qs-send mono-btn" :disabled="!canSend" data-testid="questions-send" @click="send">
        <UIcon name="i-lucide-arrow-up" />{{ tl('Send') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.qs { display: grid; gap: 12px; max-width: 620px; min-width: 0; margin: .3em 0 .9em; padding: 12px; border: 1px solid var(--line); border-left: 2px solid var(--accent); background: var(--surface); }
.qs.done { border-left-color: var(--line); }
.qs-item { display: grid; gap: 6px; min-width: 0; }
.qs-q { display: flex; gap: 8px; margin: 0; overflow-wrap: anywhere; }
.qs-n { flex: none; min-width: 1.4em; color: var(--accent); font: 500 12px/1.6 var(--mono); }
.done .qs-n { color: var(--muted); }
.qs-opts { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.qs-opt {
  display: inline-flex; align-items: baseline; gap: 6px; min-height: 36px; max-width: 100%; padding: 6px 12px;
  font: inherit; font-size: 13px; line-height: 1.3; text-align: left; overflow-wrap: anywhere;
  color: var(--text); background: none; border: 1px solid var(--line); border-radius: 0; cursor: pointer;
}
.qs-key { color: var(--muted); font: 500 11px/1 var(--mono); }
.qs-opt:is(:hover, :focus-visible):not(:disabled) { border-color: var(--accent); background: var(--surface-2); outline: 0; }
.qs-opt[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.qs-opt[aria-pressed="true"] .qs-key { color: var(--accent); }
.qs-opt:disabled { color: var(--dim); cursor: default; }
.qs-opt:disabled[aria-pressed="true"] { color: var(--text-2); }
.qs-opt:disabled[aria-pressed="true"]::before { content: "✓"; color: var(--accent); }
.qs-other-btn { color: var(--muted); }
.qs-input { width: min(100%, 420px); min-height: 36px; padding: 6px 10px; font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 0; outline: 0; }
.qs-input:focus { border-color: var(--accent); }
.qs-given { margin: 0; color: var(--text-2); font-size: 13px; overflow-wrap: anywhere; }
.qs-foot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-width: 0; }
.qs-left { color: var(--muted); font-size: 12px; }
.qs-send {
  display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px;
  color: var(--on-accent); background: var(--accent); border: 1px solid var(--accent); border-radius: 0; cursor: pointer;
}
.qs-send:disabled { color: var(--dim); background: none; border-color: var(--line); cursor: default; }
.qs-send:focus-visible { outline: 1px solid var(--text); outline-offset: 2px; }
@media (pointer: coarse) { .qs-opt, .qs-send, .qs-input { min-height: 44px; } }
</style>
