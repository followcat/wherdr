<script setup lang="ts">
// An automation the coordinator or Alfred proposed (`wherdr pm automation
// propose`): new, changed or removed, what it does (its whole prompt: Accept
// saves all of it), when it fires;
// Accept / Refuse while it waits, else its outcome. In the conversation that
// proposed it (ChatView) and in the project's Automations tab.
import type { AutomationProposal } from '#shared/pm/automations'

const props = defineProps<{ p: AutomationProposal }>()
const emit = defineEmits<{ answered: [] }>()
const busy = ref<'' | 'accept' | 'refuse'>('')
const error = ref('')
const a = computed(() => props.p.automation)
const title = computed(() => ({ add: tl('New automation'), change: tl('Automation change'), remove: tl('Automation removal') })[props.p.action])
const by = computed(() => (props.p.by === 'main' ? alfred.value?.name || 'Alfred' : `${props.p.by} ${coordinatorNameOf(props.p.by) || tl('coordinator')}`))
const outcome = computed(() => props.p.outcome && `${({ accepted: tl('Accepted'), refused: tl('Refused'), replaced: tl('Replaced') })[props.p.outcome]} · ${fmtDateTime(props.p.answeredAt ?? props.p.at)}`)

async function send(accept: boolean) {
  if (busy.value) return
  busy.value = accept ? 'accept' : 'refuse'
  error.value = ''
  try { await api('/api/pm/automation-proposal', { project: props.p.project, id: props.p.id, accept }); emit('answered') }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = ''; await loadCoordinators() }
}
</script>

<template>
  <div class="ap-card" :class="{ answered: p.outcome }" data-testid="automation-proposal">
    <span class="mono-label ap-title">{{ title }} · {{ p.project }}</span>
    <b class="ap-name">{{ a.name }}</b>
    <template v-if="p.action !== 'remove'">
      <small class="mono-label ap-when" data-testid="automation-proposal-when">{{ automationTrigger(a) }}</small>
      <p class="ap-prompt">{{ a.prompt }}</p>
    </template>
    <small class="muted">{{ tl('Proposed by') }} {{ by }} · {{ fmtDateTime(p.at) }}</small>
    <p v-if="outcome" class="ap-outcome" :class="p.outcome === 'accepted' ? 'ok' : 'no'" data-testid="automation-proposal-outcome">{{ outcome }}</p>
    <div v-else class="ap-actions">
      <UButton color="neutral" variant="outline" size="lg" :loading="busy === 'refuse'" :disabled="busy !== ''" data-testid="automation-proposal-refuse" @click="send(false)">{{ tl('Refuse') }}</UButton>
      <UButton color="primary" size="lg" :loading="busy === 'accept'" :disabled="busy !== ''" data-testid="automation-proposal-accept" @click="send(true)">{{ tl('Accept') }}</UButton>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.ap-card { display: grid; gap: 4px; margin: 4px 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--blocked); background: var(--surface); min-width: 0; }
.ap-card.answered { border-left-color: var(--line); }
.ap-title { color: var(--text); }
.ap-name, .ap-prompt { overflow-wrap: anywhere; }
.ap-when { color: var(--accent); }
.ap-prompt { margin: 0; white-space: pre-wrap; }
.ap-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.ap-outcome { margin: 0; font: 12px/1.4 var(--font-mono); }
.ap-outcome.ok { color: var(--green); }
.ap-outcome.no { color: var(--muted); }
@media (max-width: 599px) { .ap-actions > * { flex: 1 1 auto; } }
</style>
