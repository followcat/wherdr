<script setup lang="ts">
// "New" sheet › Project, footer: start the coordinator of a project whose
// coordinator does not run (the form lists only those), with the chosen agent.
// A project being added (draft) is saved first (the minimal default
// workflow), then its coordinator starts and proposes one.
import { isCoordinatorProgram } from '#shared/pm/coordinator'
import { draftBody, type ProjectDraft } from '#shared/pm/newProject'

const props = defineProps<{ project: string, agent: string, draft?: ProjectDraft | null }>()
const emit = defineEmits<{ done: [], added: [key: string] }>()
const busy = ref(false)
const error = ref('')

const c = computed(() => coordinators.value.find(x => x.project === props.project))
const chosen = computed(() => (isCoordinatorProgram(props.agent) ? { program: props.agent } : c.value ? coordinatorAgent(c.value) : undefined))
const ready = computed(() => (props.draft ? !!props.draft.probe && !!props.draft.key.trim() : !!c.value))

async function add(d: ProjectDraft) {
  const { project } = await api<{ project: { key: string } }>('/api/pm/project', draftBody(d))
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
    emit('done')
    if (p) { haptic(); navigateTo(panePath(p.id)) }
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <div class="sheet-form coord-new-actions" data-testid="coordinator-actions">
    <p v-if="error" class="form-error">{{ error }}</p>
    <UButton block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :loading="busy" :disabled="!ready || !chosen" :data-testid="draft ? 'project-start' : 'coordinator-start'" @click="start">
      {{ chosen ? tl(`Start with ${kindLabel(chosen.program)}`) : tl('Start', 'Lancer') }}
    </UButton>
  </div>
</template>

<style scoped>
.coord-new-actions { display: grid; gap: 8px; }
</style>
