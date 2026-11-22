<script setup lang="ts">
// Open the agent, on the task sheet and in Tasks to review, whatever the step:
// the conversation of the agent holding the step if it runs, else the worker's
// (Card.agents, each role's agent still running, found on screen here). Both the
// worker and the reviewer running: a small menu, Worker or Reviewer. None: the
// button stays, disabled, with why (Agent is terminated): a tooltip on hover,
// a short muted line under it on a tap (a phone has no hover). A worker the
// engine released (Card.released): a click asks first (closed then to free
// memory, its conversation comes back as it was); Reopen starts it again with
// its conversation and no message, then opens it.
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

// The released worker: started again, opened once its pane is on screen.
const released = computed(() => !one.value && props.card.released !== undefined)
const releasedText = computed(() => {
  const at = props.card.released ? new Date(props.card.released).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return tl(`This agent was closed${at ? ` at ${at}` : ''} to free memory on its machine. Reopen it and its conversation comes back as it was.`)
})
const waking = ref(false)
const wakeError = ref('')
const woken = computed(() => herdrState.value?.panes.find(p => p.task === props.card.id && p.role === 'worker'))
async function wake() {
  if (!(await askConfirm(releasedText.value, tl('Reopen'), 'primary'))) return
  waking.value = true
  wakeError.value = ''
  try {
    await api('/api/pm/worker-wake', { id: props.card.id })
    taskChanged()
  }
  catch (e) { wakeError.value = (e as Error).message; waking.value = false }
}
watch(woken, (p) => { if (p && waking.value) { waking.value = false; go(p) } })
</script>

<template>
  <UDropdownMenu v-if="both" :items="items" :content="{ align: 'start' }" :ui="{ content: 'hw-dropdown' }">
    <UButton :color="primary ? 'primary' : 'neutral'" :variant="primary ? 'solid' : 'outline'" size="xl" icon="i-lucide-terminal" trailing-icon="i-lucide-chevron-down" data-testid="agent-open-menu">{{ label }}</UButton>
  </UDropdownMenu>
  <UButton v-else-if="one" :color="primary ? 'primary' : 'neutral'" :variant="primary ? 'solid' : 'outline'" size="xl" icon="i-lucide-terminal" data-testid="agent-open" @click="go(one)">{{ label }}</UButton>
  <div v-else-if="released" class="agent-off" data-testid="agent-released">
    <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-terminal" :loading="waking" data-testid="agent-wake" @click="wake">{{ label }}</UButton>
    <small v-if="wakeError" class="form-error" role="status" data-testid="agent-wake-error">{{ wakeError }}</small>
  </div>
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
