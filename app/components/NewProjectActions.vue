<script setup lang="ts">
// "New" sheet › Project, footer: open the project's coordinator when it
// runs with the chosen agent, else start it (same API and rules as the
// CoordinatorPanel: a running conversation of another agent offers a new
// conversation first, or resuming it). A project being added (draft) is
// saved first (with a copy of the template or example it picked as its workflow), then its coordinator starts.
import { isCoordinatorProgram, sameAgent } from '#shared/pm/coordinator'
import { draftBody, draftGit, type ProjectDraft } from '#shared/pm/newProject'

const props = defineProps<{ project: string, agent: string, draft?: ProjectDraft | null }>()
const emit = defineEmits<{ done: [], added: [key: string] }>()
const busy = ref(false)
const error = ref('')

const c = computed(() => coordinators.value.find(x => x.project === props.project))
const fallback = computed(() => (c.value ? coordinatorAgent(c.value) : undefined))
const chosen = computed(() => (isCoordinatorProgram(props.agent) ? { program: props.agent } : fallback.value))
const ready = computed(() => !!props.draft?.probe && !!props.draft.key.trim() && (!!props.draft.template || !draftGit(props.draft)))
const agentName = (a: { program: string }) => kindLabel(a.program)
const pane = computed(() => (c.value ? coordinatorPane(c.value) : undefined))
// Its conversation runs with another agent than the chosen one (a resume the
// user already chose for the default agent is no longer asked).
const other = computed(() => !!pane.value && !!c.value?.ran && !sameAgent(c.value.ran, chosen.value)
  && !(sameAgent(chosen.value, fallback.value) && resumedCoordinators.value.includes(c.value.terminal!)))

function go(id: string) {
  haptic()
  emit('done')
  navigateTo(panePath(id))
}
async function add(d: ProjectDraft) {
  const git = draftGit(d)
  const { project } = await api<{ project: { key: string } }>('/api/pm/project', draftBody(d, d.template))
  if (git) try { localStorage.setItem('wherdr.lastTemplate', d.template) } catch {}
  await loadCoordinators()
  emit('added', project.key) // a failed start is tried again on the project, not added twice
  return project.key
}
async function start() {
  const d = props.draft
  if ((!d && !c.value) || !chosen.value) return
  busy.value = true
  error.value = ''
  try {
    const p = await launchCoordinator(d ? await add(d) : c.value!.project, chosen.value)
    if (p) go(p.id)
    else emit('done')
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
function resume() {
  resumeCoordinator(c.value!.terminal!)
  go(pane.value!.id)
}
</script>

<template>
  <div class="sheet-form coord-new-actions" data-testid="coordinator-actions">
    <p v-if="error" class="form-error">{{ error }}</p>
    <UButton v-if="draft" block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :loading="busy" :disabled="!ready || !chosen" data-testid="project-start" @click="start">
      {{ tl('Start', 'Lancer') }}
    </UButton>
    <template v-else-if="c && other && c.ran">
      <p class="coord-warn muted" data-testid="coordinator-other-agent">
        {{ tl(`Its conversation runs with ${agentName(c.ran)}.`, `Sa conversation tourne avec ${agentName(c.ran)}.`) }}
      </p>
      <UButton block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :loading="busy" data-testid="coordinator-new" @click="start">
        {{ tl(`New conversation with ${agentName(chosen!)}`, `Nouvelle conversation avec ${agentName(chosen!)}`) }}
      </UButton>
      <UButton block size="xl" color="neutral" variant="outline" :disabled="busy" data-testid="coordinator-resume" @click="resume">
        {{ tl(`Resume with ${agentName(c.ran)}`, `Reprendre avec ${agentName(c.ran)}`) }}
      </UButton>
    </template>
    <UButton v-else-if="pane" block size="xl" color="primary" class="hw-cta" icon="i-lucide-arrow-right" data-testid="coordinator-open" @click="go(pane.id)">
      {{ tl('Open', 'Ouvrir') }}
    </UButton>
    <UButton
      v-else block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :loading="busy" :disabled="!(c?.template || c?.git === false) || !chosen"
      data-testid="coordinator-start" @click="start"
    >
      {{ chosen ? tl(`Start with ${agentName(chosen)}`, `Lancer avec ${agentName(chosen)}`) : tl('Start', 'Lancer') }}
    </UButton>
  </div>
</template>

<style scoped>
.coord-new-actions { display: grid; gap: 8px; }
.coord-warn { margin: 0 2px; font-size: 13px; }
</style>
