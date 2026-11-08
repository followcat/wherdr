<script setup lang="ts">
// The coordinator window's content (CoordinatorButton): which agent answers a project
// coordinator (its default changed in one gesture; Alfred's program changes from its
// row's "Restart with…"), a warning when its kept conversation ran with another agent,
// the template change it proposed, to accept or refuse, and its autopilot.
// On the board (`open`), also the button that opens or starts it.
import type { CoordinatorView } from '#shared/pm/coordinator'

const props = defineProps<{ c: CoordinatorView, open?: boolean }>()
const busy = ref(false)
// In the conversation the diff opens on demand, so the chat stays readable on a phone.
const showDiff = ref(!!props.open)
const error = ref('')

// Its default: the one set for it, else the user's first agent (Settings › Agents).
const agent = computed(() => coordinatorAgent(props.c))
const agentName = (a?: { program: string }) => (a ? kindLabel(a.program) : '')
const pane = computed(() => coordinatorPane(props.c))
// The kept conversation is another agent's: warn, a new one first.
const other = computed(() => coordinatorMismatch(props.c))
const diff = computed(() => (props.c.proposal?.diff ?? '').split('\n').map(l => ({ l, k: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' })))

async function act(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try { await fn(); await loadCoordinators() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
const agentItems = computed(() => offerCoordinators(undefined, props.c.project).map(p => ({ label: kindLabel(p), value: p })))
const setDefault = (program: string) => act(() => api('/api/pm/coordinator-agent', { project: props.c.project, program }))
const fresh = () => act(async () => { const p = await launchCoordinator(props.c.project, agent.value); if (props.c.main) await loadAlfred(); if (p) await navigateTo(panePath(p.id)) })
const resume = () => { resumeCoordinator(props.c.terminal!); if (props.open && pane.value) navigateTo(panePath(pane.value.id)) }
const openIt = () => (pane.value ? navigateTo(panePath(pane.value.id)) : fresh())
const answer = (accept: boolean) => act(() => api('/api/pm/template-proposal', { project: props.c.project, accept }))
</script>

<template>
  <div class="coord" data-testid="coordinator-panel">
    <!-- Alfred on the board: its row (one tap opens or starts it, its program asked the first time). -->
    <AlfredRow v-if="open && c.main" banner />
    <div v-else-if="!c.main || (open && !other)" class="coord-head">
      <div v-if="!c.main" class="coord-field">
        <span class="field-label">{{ tl('Answering agent', 'Agent qui répond') }}</span>
        <USelect :model-value="agent?.program" :items="agentItems" size="lg" class="coord-agent w-full" :disabled="busy" :aria-label="tl('Default agent', 'Agent par défaut')" data-testid="coordinator-agent" @update:model-value="v => setDefault(String(v))" />
      </div>
      <UButton v-if="open && !other" color="primary" size="lg" :loading="busy" data-testid="coordinator-open" @click="openIt">
        {{ pane ? tl('Open', 'Ouvrir') : tl(`Start with ${agentName(agent)}`, `Lancer avec ${agentName(agent)}`) }}
      </UButton>
    </div>
    <div v-if="other && c.ran" class="term-banner coord-warn" data-testid="coordinator-other-agent">
      <UIcon name="i-lucide-triangle-alert" class="term-banner-icon" />
      <span class="coord-warn-text">{{ tl(`The previous conversation used ${agentName(c.ran)}. The default is ${agentName(agent)}.`, `La conversation précédente utilisait ${agentName(c.ran)}. Le défaut est ${agentName(agent)}.`) }}</span>
      <UButton size="xs" color="warning" :loading="busy" data-testid="coordinator-new" @click="fresh">{{ tl(`New conversation with ${agentName(agent)}`, `Nouvelle conversation avec ${agentName(agent)}`) }}</UButton>
      <UButton size="xs" color="warning" variant="outline" data-testid="coordinator-resume" @click="resume">{{ tl(`Resume with ${agentName(c.ran)}`, `Reprendre avec ${agentName(c.ran)}`) }}</UButton>
    </div>
    <section v-if="c.proposal" class="coord-proposal" data-testid="template-proposal">
      <div class="coord-actions">
        <span class="mono-label">{{ tl('Template change proposed', 'Changement de modèle proposé') }}</span>
        <UButton color="neutral" variant="ghost" size="lg" :aria-expanded="showDiff" data-testid="proposal-toggle" @click="showDiff = !showDiff">{{ showDiff ? tl('Hide', 'Masquer') : tl('Show diff', 'Voir le diff') }}</UButton>
        <UButton color="primary" size="lg" :loading="busy" data-testid="proposal-accept" @click="answer(true)">{{ tl('Accept', 'Accepter') }}</UButton>
        <UButton color="neutral" variant="outline" size="lg" :disabled="busy" data-testid="proposal-refuse" @click="answer(false)">{{ tl('Refuse', 'Refuser') }}</UButton>
      </div>
      <template v-if="showDiff">
        <p v-if="c.proposal.said" class="muted coord-said">{{ tl('After your message', 'Après ton message') }}: “{{ c.proposal.said }}”</p>
        <pre class="coord-diff" data-testid="proposal-diff"><span v-for="(d, i) in diff" :key="i" :class="d.k">{{ d.l }}
</span></pre>
      </template>
    </section>
    <p v-if="error" class="error coord-error">{{ error }}</p>
    <CoordinatorAutopilot :c="c" />
  </div>
</template>

<style scoped>
.coord { display: grid; gap: 12px; }
.coord-head { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.coord-head > * { flex: 1 1 160px; }
.coord-field { display: grid; gap: 4px; min-width: 0; }
.coord-warn { flex-wrap: wrap; }
.coord-warn-text { flex: 1 1 calc(100% - 40px); }
.coord-head :deep(.coord-agent) { min-width: 0; max-width: 100%; }
.coord-proposal { display: grid; gap: 6px; }
.coord-proposal p { margin: 0; overflow-wrap: anywhere; }
.coord-said { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.coord-diff { margin: 0; max-height: 30vh; overflow: auto; padding: 8px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.coord-diff .add { color: var(--green); }
.coord-diff .del { color: var(--rose); }
.coord-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.coord-actions .mono-label { flex: 1 1 100%; color: var(--muted); }
@media (min-width: 600px) { .coord-actions .mono-label { flex-basis: auto; } }
.coord-error { margin: 0; }
</style>
