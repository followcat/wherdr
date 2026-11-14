<script setup lang="ts">
// Open the agent, on the task sheet and in Tasks to review, whatever the step:
// the conversation of the agent holding the step if it runs, else the worker's
// (Card.agents, each role's agent still running, found on screen here). Both the
// worker and the reviewer running: a small menu, Worker or Reviewer. None: the
// button stays, disabled, with why (Agent is terminated): a tooltip on hover,
// a short muted line under it on a tap (a phone has no hover).
// primary: an agent's question, the one thing to do (else secondary, never
// competing with Approve or Merge). opened: the conversation is opening.
import type { Card } from '#shared/pm/board'
import type { Pane } from '#shared/types'

const props = defineProps<{ card: Card, primary?: boolean }>()
const emit = defineEmits<{ opened: [] }>()

const find = (address?: string): Pane | undefined => (address ? herdrState.value?.panes.find(p => p.coreAddress === address) : undefined)
const worker = computed(() => find(props.card.agents?.worker))
const reviewer = computed(() => find(props.card.agents?.reviewer))
const one = computed(() => (props.card.holder === 'reviewer' ? reviewer.value ?? worker.value : worker.value ?? reviewer.value))
const both = computed(() => !!worker.value && !!reviewer.value)
const label = computed(() => (!both.value && one.value && one.value === reviewer.value ? tl('Open the reviewer') : tl('Open the agent')))

function go(p?: Pane) {
  if (!p) return
  emit('opened')
  navigateTo(panePath(p.id))
}
const items = computed(() => [
  { label: tl('Worker'), icon: 'i-lucide-hammer', onSelect: () => go(worker.value) },
  { label: tl('Reviewer'), icon: 'i-lucide-search-check', onSelect: () => go(reviewer.value) },
])
const hint = ref(false)
watch(one, () => { hint.value = false })
</script>

<template>
  <UDropdownMenu v-if="both" :items="items" :content="{ align: 'start' }" :ui="{ content: 'hw-dropdown' }">
    <UButton :color="primary ? 'primary' : 'neutral'" :variant="primary ? 'solid' : 'outline'" size="xl" icon="i-lucide-terminal" trailing-icon="i-lucide-chevron-down" data-testid="agent-open-menu">{{ label }}</UButton>
  </UDropdownMenu>
  <UButton v-else-if="one" :color="primary ? 'primary' : 'neutral'" :variant="primary ? 'solid' : 'outline'" size="xl" icon="i-lucide-terminal" data-testid="agent-open" @click="go(one)">{{ label }}</UButton>
  <div v-else class="agent-off" data-testid="agent-off" @click="hint = !hint">
    <span class="agent-off-trigger" :title="tl('Agent is terminated')">
      <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-terminal" disabled :aria-describedby="hint ? `agent-off-${card.id}` : undefined" data-testid="agent-open">{{ label }}</UButton>
    </span>
    <small v-if="hint" :id="`agent-off-${card.id}`" class="muted" role="status" data-testid="agent-off-hint">{{ tl('Agent is terminated') }}</small>
  </div>
</template>

<style scoped>
.agent-off { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; justify-items: stretch; }
.agent-off-trigger { display: grid; }
/* The disabled button lets its hover and tap through to the hint's trigger. */
.agent-off-trigger > * { pointer-events: none; justify-content: center; }
.agent-off small { font-size: 12px; text-align: center; }
@media (min-width: 700px) { .agent-off { justify-items: start; } .agent-off small { text-align: start; } }
</style>
