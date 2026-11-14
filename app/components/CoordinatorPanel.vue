<script setup lang="ts">
// The coordinator window's content (CoordinatorButton): which agent answers the
// coordinator, Alfred included (its default changed in one gesture), a warning when
// its kept conversation ran with another agent (resuming it makes that agent the default),
// and a project coordinator's autopilot (Alfred has none), under its name and
// what it is. Not its proposed workflow change: a card in its conversation.
// On the board (`open`), also the button that opens or starts it; a stopped
// conversation (its terminal ended) can be resumed instead.
// A project coordinator's window has the autopilot's tabs: its agent in Settings
// (saved with them, CoordinatorAutopilot), opening its conversation in Activity. Alfred's (Bare): its agent, then the rest.
import type { FunctionalComponent } from 'vue'
import type { CoordinatorView } from '#shared/pm/coordinator'
import CoordinatorAutopilot from '~/components/CoordinatorAutopilot.vue'

const props = defineProps<{ c: CoordinatorView, open?: boolean }>()
const busy = ref(false)
const error = ref('')

// Its default: the one set for it, else the user's first agent (Settings › Agents).
const agent = computed(() => coordinatorAgent(props.c))
const agentName = (a?: { program: string }) => (a ? kindLabel(a.program) : '')
const pane = computed(() => coordinatorPane(props.c))
const stopped = computed(() => coordinatorStopped(props.c))
// The kept conversation is another agent's: warn, a new one first.
const other = computed(() => coordinatorMismatch(props.c))

async function act(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try { await fn(); await loadCoordinators() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
const agentItems = computed(() => alfredPrograms.value.map(p => ({ label: kindLabel(p), value: p })))
// Alfred's program no longer offered on wherdr's machine: said, never replaced silently.
const unoffered = computed(() => (props.c.main && agent.value && !alfredPrograms.value.includes(agent.value.program) ? agentName(agent.value) : ''))
const setDefault = (program: string) => act(() => api('/api/pm/coordinator-agent', { project: props.c.project, program }))
const fresh = () => act(async () => { const p = await launchCoordinator(props.c.project, agent.value); if (props.c.main) await loadAlfred(); if (p) await navigateTo(panePath(p.id)) })
const resumeStopped = () => act(async () => { const p = await launchCoordinator(props.c.project, 'resume'); if (props.c.main) await loadAlfred(); if (p) await navigateTo(panePath(p.id)) })
// Alfred: the agent resumed becomes its default, so the warning does not come back.
const resume = () => {
  resumeCoordinator(props.c.terminal!)
  if (props.c.main && props.c.ran) void act(async () => { await api('/api/pm/coordinator-agent', { project: props.c.project, program: props.c.ran!.program }); await loadAlfred() })
  if (props.open && pane.value) navigateTo(panePath(pane.value.id))
}
const openIt = () => (pane.value ? navigateTo(panePath(pane.value.id)) : fresh())

const Bare: FunctionalComponent<{ c: CoordinatorView }> = (_, { slots }) => [slots.settings?.(), slots.activity?.()]
Bare.props = ['c', 'withAgent']
const auto = ref<InstanceType<typeof CoordinatorAutopilot>>()
// Unsaved autopilot settings: asked before the window closes (Alfred has none).
defineExpose({ leave: () => (props.c.main || !auto.value ? Promise.resolve(true) : auto.value.leave()) })
</script>

<template>
  <div class="coord" data-testid="coordinator-panel">
    <component :is="c.main ? Bare : CoordinatorAutopilot" ref="auto" :c="c" :with-agent="!c.main">
      <template #settings>
        <template v-if="c.main">
          <div class="coord-field">
            <span class="field-label">{{ tl(`${coordinatorName(c)}’s agent`) }}</span>
            <USelect :model-value="agent?.program" :items="agentItems" size="lg" class="coord-agent w-full" :disabled="busy" :aria-label="tl('Default agent')" data-testid="coordinator-agent" @update:model-value="v => setDefault(String(v))" />
          </div>
          <p v-if="unoffered" class="coord-note muted" data-testid="coordinator-unoffered">{{ tl(`${unoffered} is no longer offered on this machine (Settings › Agents): pick another agent, or offer it again.`) }}</p>
        </template>
      </template>
      <template #activity>
        <PartHead v-if="!c.main" part="autopilot" :project="c.project" />
        <div v-if="open && !other" class="coord-head">
          <UButton v-if="stopped" color="primary" size="lg" :loading="busy" data-testid="coordinator-resume-stopped" @click="resumeStopped">
            {{ tl('Resume the conversation') }}
          </UButton>
          <UButton :color="stopped ? 'neutral' : 'primary'" :variant="stopped ? 'outline' : 'solid'" size="lg" :loading="busy" data-testid="coordinator-open" @click="openIt">
            {{ pane ? tl('Open') : stopped ? tl('New conversation') : tl(`Start with ${agentName(agent)}`) }}
          </UButton>
        </div>
        <div v-if="other && c.ran" class="term-banner coord-warn" data-testid="coordinator-other-agent">
          <UIcon name="i-lucide-triangle-alert" class="term-banner-icon" />
          <span class="coord-warn-text">{{ tl(`The previous conversation used ${agentName(c.ran)}. The default is ${agentName(agent)}.`) }}</span>
          <UButton size="xs" color="warning" :loading="busy" data-testid="coordinator-new" @click="fresh">{{ tl(`New conversation with ${agentName(agent)}`) }}</UButton>
          <UButton size="xs" color="warning" variant="outline" data-testid="coordinator-resume" @click="resume">{{ tl(`Resume with ${agentName(c.ran)}`) }}</UButton>
        </div>
        <p v-if="error" class="error coord-error">{{ error }}</p>
      </template>
    </component>
  </div>
</template>

<style scoped>
.coord { display: grid; gap: 12px; }
.coord-head { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.coord-head > * { flex: 1 1 160px; }
/* A computer: the buttons as wide as their words, not across the tab. */
@media (min-width: 640px) { .coord-head > * { flex: 0 1 auto; } }
.coord-field { display: grid; gap: 4px; min-width: 0; max-width: 420px; }
.coord-warn { flex-wrap: wrap; }
.coord-warn-text { flex: 1 1 calc(100% - 40px); }
.coord :deep(.coord-agent) { min-width: 0; max-width: 100%; }
.coord-error, .coord-note { margin: 0; }
</style>
