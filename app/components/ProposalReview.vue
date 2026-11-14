<script setup lang="ts">
// The review of a project coordinator's proposed workflow change: the change
// in one line, who proposed it and the user's request behind it
// (ProposalOrigin), the change drawn on the workflow it proposes (WorkflowChart,
// one changed task type at a time), as a list, or the JSON diff,
// Refuse or Accept. An outdated proposal (the workflow changed since) is
// refused by the server: its reason shows here.
import type { CoordinatorView } from '#shared/pm/coordinator'
import { changeHeadline } from '#shared/pm/workflowChanges'

// canGoto, goto: opened from the conversation, the link back to the request.
const props = defineProps<{ c: CoordinatorView, canGoto?: boolean }>()
const emit = defineEmits<{ answered: [accepted: boolean], goto: [] }>()
const open = defineModel<boolean>('open', { default: false })
const { busy, error, answer } = useProposalAnswer(() => props.c.project, (accepted) => { open.value = false; emit('answered', accepted) })
const lines = computed(() => diffLines(props.c.proposal?.diff ?? ''))
// The diagram first; JSON when there is nothing else to show.
const view = ref<'diagram' | 'readable' | 'json'>('diagram')
const proposed = computed(() => props.c.proposal?.template)
// Nothing readable (a change the builder does not describe): the JSON diff only.
const changes = computed(() => { const c = props.c.proposal?.changes; return c && (c.all.length || c.types.length) ? c : undefined })
const VIEWS = computed(() => [...(changes.value && proposed.value ? ['diagram' as const] : []), ...(changes.value ? ['readable' as const] : []), 'json' as const])
const headline = computed(() => changeHeadline(props.c.proposal?.changes ?? { all: [], types: [] }))
// The task types it changes (a change to them all: every type).
const types = computed(() => (changes.value?.types.length ? changes.value.types.map(x => x.type) : Object.keys(proposed.value?.taskTypes ?? {})))
const type = ref('')
watch(open, (o) => { if (o) { error.value = ''; view.value = VIEWS.value[0]!; type.value = types.value[0] ?? '' } }, { immediate: true })
const VIEW_LABEL = { diagram: 'Diagram', readable: 'List', json: 'JSON' }
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Workflow change proposed')" tall wide top hide-close>
    <div class="review" data-testid="proposal-review">
      <template v-if="c.proposal">
        <p v-if="headline" class="review-headline" data-testid="proposal-headline">{{ headline }}</p>
        <ProposalOrigin :c="c" :can-goto="canGoto" @goto="emit('goto')" />
        <span class="mono-label muted">{{ tl('Proposed') }} · {{ fmtDateTime(c.proposal.at) }}</span>
        <div v-if="VIEWS.length > 1" class="segmented review-tabs" role="tablist" :style="{ '--segment-count': VIEWS.length }">
          <button v-for="k in VIEWS" :key="k" type="button" role="tab" :class="{ on: view === k }" :aria-selected="view === k" :data-testid="`proposal-view-${k}`" @click="view = k">
            <span>{{ tl(VIEW_LABEL[k]) }}</span>
          </button>
        </div>
        <template v-if="view === 'diagram' && changes && proposed">
          <div v-if="types.length > 1" class="segmented" role="tablist" :aria-label="tl('Task type')" :style="{ '--segment-count': types.length }">
            <button v-for="k in types" :key="k" type="button" role="tab" :class="{ on: type === k }" :aria-selected="type === k" :data-type="k" @click="type = k">{{ k }}</button>
          </div>
          <WorkflowChart v-if="type" :key="type" :workflow="proposed" :type="type" :changes="changes" />
        </template>
        <ProposalChanges v-else-if="changes && view === 'readable'" :changes="changes" />
        <pre v-else class="review-diff" data-testid="proposal-diff"><span v-for="(d, i) in lines" :key="i" :class="d.k">{{ d.l }}
</span></pre>
        <div class="review-actions">
          <UButton color="neutral" variant="outline" size="xl" :loading="busy === 'refuse'" :disabled="busy !== ''" data-testid="proposal-refuse" @click="answer(false)">{{ tl('Refuse') }}</UButton>
          <UButton color="primary" size="xl" :loading="busy === 'accept'" :disabled="busy !== ''" data-testid="proposal-accept" @click="answer(true)">{{ tl('Accept') }}</UButton>
        </div>
      </template>
      <p v-else-if="!error" class="muted settings-hint">{{ tl('This proposal was answered.') }}</p>
      <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
    </div>
  </AppSheet>
</template>

<style scoped>
.review { display: grid; gap: 12px; }
.review-headline { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.review-diff { margin: 0; max-height: 55vh; overflow: auto; padding: 8px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.review-diff .add { color: var(--green); }
.review-diff .del { color: var(--rose); }
.review-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
</style>
