<script setup lang="ts">
// The coordinator's proposed workflow change, in its conversation after the
// message that made it: titled 'Workflow change' with what a workflow is, what
// changes in one line, the proposed workflow drawn small with its changes marked
// (WorkflowChart, the first changed task type; a tap opens the review), who proposed it and the
// user's request behind it (ProposalOrigin), Accept / Refuse and See all
// changes (ProposalReview). answer: an answered one instead (accepted, refused,
// replaced): what it changed, the outcome, by whom, when.
// canGoto, goto: in the conversation, the link back to that request.
import type { CoordinatorView, ProposalAnswer } from '#shared/pm/coordinator'
import { changeHeadline } from '#shared/pm/workflowChanges'

const props = defineProps<{ c: CoordinatorView, answer?: ProposalAnswer, canGoto?: boolean }>()
const emit = defineEmits<{ goto: [] }>()
const review = ref(false)
const { busy, error, answer: send } = useProposalAnswer(() => props.c.project)
const pending = computed(() => (props.answer ? undefined : props.c.proposal))
const summary = computed(() => (pending.value ? [changeHeadline(pending.value.changes ?? { all: [], types: [] })].filter(Boolean) : props.answer?.summary ?? []))
// The task type drawn: the first one changed.
const drawn = computed(() => pending.value?.changes?.types[0]?.type ?? Object.keys(pending.value?.template?.taskTypes ?? {})[0])
const outcome = computed(() => {
  const a = props.answer
  if (!a) return ''
  const what = ({ accepted: tl('Accepted'), refused: tl('Refused'), replaced: tl('Replaced') } as Record<string, string>)[a.outcome] ?? tl('Refused: the workflow changed since')
  return `${what} ${a.by === 'user' || !a.by ? tl('by you') : `${tl('by')} ${a.by}`} · ${fmtDateTime(a.at)}`
})
</script>

<template>
  <div class="proposal-card" :class="{ answered: !pending }" data-testid="proposal-card">
    <PartHead part="workflow" :title="tl('Workflow change')" />
    <p v-for="(l, i) in summary" :key="i" class="proposal-line" data-testid="proposal-headline">{{ l }}</p>
    <div v-if="pending?.template && drawn" class="proposal-chart" role="button" tabindex="0" :aria-label="tl('See all changes')" data-testid="proposal-chart" @click="review = true" @keydown.enter.prevent="review = true" @keydown.space.prevent="review = true">
      <WorkflowChart :workflow="pending.template" :type="drawn" :changes="pending.changes" compact />
    </div>
    <template v-if="pending">
      <ProposalOrigin :c="c" :can-goto="canGoto" @goto="emit('goto')" />
      <div class="proposal-actions">
        <UButton color="neutral" variant="ghost" size="lg" data-testid="proposal-see" @click="review = true">{{ tl('See all changes') }}</UButton>
        <span class="proposal-gap" />
        <UButton color="neutral" variant="outline" size="lg" :loading="busy === 'refuse'" :disabled="busy !== ''" data-testid="proposal-card-refuse" @click="send(false)">{{ tl('Refuse') }}</UButton>
        <UButton color="primary" size="lg" :loading="busy === 'accept'" :disabled="busy !== ''" data-testid="proposal-card-accept" @click="send(true)">{{ tl('Accept') }}</UButton>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      <ProposalReview v-model:open="review" :c="c" :can-goto="canGoto" @goto="review = false; emit('goto')" />
    </template>
    <p v-else class="proposal-outcome" :class="answer?.outcome === 'accepted' ? 'ok' : 'no'" data-testid="proposal-outcome">{{ outcome }}</p>
  </div>
</template>

<style scoped>
.proposal-card { display: grid; gap: 6px; margin: 4px 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--blocked); background: var(--surface); }
.proposal-card.answered { border-left-color: var(--line); }
.proposal-chart { min-width: 0; padding: 8px 0 4px; cursor: pointer; }
.proposal-chart:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.proposal-line { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.proposal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 4px; }
.proposal-gap { flex: 1 1 0; }
.proposal-outcome { margin: 0; font: 12px/1.4 var(--font-mono); }
.proposal-outcome.ok { color: var(--green); }
.proposal-outcome.no { color: var(--muted); }
@media (max-width: 599px) { .proposal-actions > :not(.proposal-gap) { flex: 1 1 auto; } .proposal-gap { display: none; } }
</style>
