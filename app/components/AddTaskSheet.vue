<script setup lang="ts">
// Add a task from the board: its project (the board's when filtered on one),
// title, type (each with its steps in one line), weight (Auto: its type's),
// description (markdown), the tasks of the same project it starts after, and Start now. The board reloads
// at once; a refused start is said there, the task stays added.
import type { BoardProject, Card } from '#shared/pm/board'
import type { Task } from '#shared/pm/run'
import { WEIGHTS, type Weight } from '#shared/pm/workflow'
import { projectOption } from '~/utils/projectOption'

const AUTO = 'auto'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ projects: BoardProject[], cards: Card[], project?: string }>()
const emit = defineEmits<{ added: [task: Task, refused?: string] }>()

const project = ref(props.project ?? '')
const title = ref('')
const type = ref('')
const description = ref('')
const weight = ref<Weight | typeof AUTO>(AUTO)
const after = ref<string[]>([])
const startNow = ref(false)
const busy = ref(false)
const error = ref('')
const tried = ref(false) // the field errors show once the user tried to add

const projectPick = noneModel(project)
const projectItems = computed(() => [{ label: tl('Pick a project', 'Choisis un projet'), value: NONE, disabled: true }, ...props.projects.map(p => projectOption(p))])
const types = computed(() => props.projects.find(p => p.key === project.value)?.types ?? [])
const typeItems = computed(() => types.value.map(x => ({ label: x.id, value: x.id, description: x.plan })))
const plan = computed(() => types.value.find(x => x.id === type.value)?.plan)
const WEIGHT_LABELS: Record<Weight, string> = { light: tl('Light'), standard: tl('Standard'), heavy: tl('Heavy') }
const weightItems = computed(() => {
  const auto = types.value.find(x => x.id === type.value)?.weight
  return [{ label: auto ? `${tl('Auto')}: ${auto}` : tl('Auto'), value: AUTO }, ...WEIGHTS.map(w => ({ label: WEIGHT_LABELS[w], value: w }))]
})
const afterItems = computed(() => props.cards.filter(c => c.project === project.value && c.phase !== 'done').map(c => ({ label: `${c.shown} · ${c.title}`, value: c.id })))
// A new project: its first type, and no 'after' from another project.
watch(project, () => { type.value = types.value[0]?.id ?? ''; after.value = [] }, { immediate: true })

const problems = computed(() => ({
  project: !project.value ? tl('Pick a project', 'Choisis un projet') : '',
  title: !title.value.trim() ? tl('Give it a title', 'Donne-lui un titre') : title.value.trim().length > 200 ? tl('200 characters at most', '200 caractères au plus') : '',
  type: project.value && !type.value ? tl('This project has no task type: pick a template in Settings › Projects', 'Ce projet n’a aucun type de tâche : choisis un modèle dans Réglages › Projets') : '',
}))
const valid = computed(() => !Object.values(problems.value).some(Boolean))
const shown = (k: keyof typeof problems.value) => (tried.value ? problems.value[k] : '')

async function add() {
  tried.value = true
  if (!valid.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const { task } = await api<{ task: Task }>('/api/pm/task', {
      project: project.value, title: title.value.trim(), type: type.value, description: description.value,
      ...(weight.value !== AUTO ? { weight: weight.value } : {}),
      ...(after.value.length ? { after: after.value.join(',') } : {}),
    })
    let refused: string | undefined
    if (startNow.value && !after.value.length) await startTaskApi(task.id).catch((e: Error) => { refused = e.message })
    emit('added', task, refused)
    open.value = false
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Add a task', 'Ajouter une tâche')" tall>
    <form id="add-task" class="sheet-form" data-testid="add-task" novalidate @submit.prevent="add">
      <label class="field-label">{{ tl('Project', 'Projet') }}</label>
      <ProjectSelect v-model="projectPick" :items="projectItems" size="xl" class="w-full" :aria-label="tl('Project', 'Projet')" data-testid="add-task-project" />
      <p v-if="shown('project')" class="form-error" data-testid="add-task-error">{{ shown('project') }}</p>

      <label class="field-label" for="add-task-title">{{ tl('Title', 'Titre') }}</label>
      <UInput id="add-task-title" v-model="title" size="xl" class="w-full" maxlength="200" data-testid="add-task-title" />
      <p v-if="shown('title')" class="form-error" data-testid="add-task-error">{{ shown('title') }}</p>

      <template v-if="project">
        <label class="field-label">{{ tl('Type', 'Type') }}</label>
        <USelect v-if="typeItems.length" v-model="type" :items="typeItems" size="xl" class="w-full" :aria-label="tl('Type', 'Type')" data-testid="add-task-type" />
        <p v-if="plan" class="muted add-task-plan mono" data-testid="add-task-plan">{{ plan }}</p>
        <p v-if="problems.type" class="form-error" data-testid="add-task-error">{{ problems.type }}</p>

        <label class="field-label">{{ tl('Weight') }}</label>
        <USelect v-model="weight" :items="weightItems" size="xl" class="w-full" :aria-label="tl('Weight')" data-testid="add-task-weight" />
      </template>

      <label class="field-label" for="add-task-description">{{ tl('Description', 'Description') }} <span class="muted">{{ tl('(optional, markdown)', '(facultatif, markdown)') }}</span></label>
      <UTextarea id="add-task-description" v-model="description" :rows="4" autoresize :maxrows="12" size="xl" class="w-full" maxlength="20000" data-testid="add-task-description" />

      <template v-if="afterItems.length">
        <label class="field-label">{{ tl('After', 'Après') }} <span class="muted">{{ tl('(optional)', '(facultatif)') }}</span></label>
        <USelect v-model="after" :items="afterItems" multiple size="xl" class="w-full" :placeholder="tl('Starts once these are done', 'Démarre une fois celles-ci terminées')" :aria-label="tl('After', 'Après')" data-testid="add-task-after" />
      </template>

      <label class="toggle-row">
        <span><b>{{ tl('Start now', 'Lancer tout de suite') }}</b><small>{{ after.length ? tl('it starts once the tasks above are done', 'elle démarre une fois les tâches ci-dessus terminées') : tl('its agent starts on the first step', 'son agent démarre sur la première étape') }}</small></span>
        <USwitch v-model="startNow" :disabled="!!after.length" size="xl" data-testid="add-task-start" />
      </label>
    </form>
    <template #footer>
      <div class="sheet-form">
        <p v-if="error" class="form-error" role="alert" data-testid="add-task-refused">{{ error }}</p>
        <UButton type="submit" form="add-task" block size="xl" color="primary" class="hw-cta" icon="i-lucide-plus" :loading="busy" data-testid="add-task-submit">
          {{ startNow && !after.length ? tl('Add and start', 'Ajouter et lancer') : tl('Add the task', 'Ajouter la tâche') }}
        </UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.add-task-plan { margin: 6px 2px 0; font-size: 12px; overflow-wrap: anywhere; }
</style>
