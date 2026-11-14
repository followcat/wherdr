<script setup lang="ts">
// Set up project management, one step per screen: turn it on, a project and
// its coordinator's agent, then meet that coordinator, which sets up the
// workflow with the user (no template here: the project sheet keeps that for
// advanced users). Each step does the thing here; it opens at the first step
// left (setupResume) for `project`, or the project setupProject picks; with
// `adding` (Settings › Projects › Add project), at step 2 on a new project
// (SetupProject). The first screen can hand the setup to Alfred instead.
import type { PmOverview } from '#shared/pm/project'
import type { RepoVisibility } from '#shared/pm/visibility'
import { isCoordinatorProgram } from '#shared/pm/coordinator'
import { SETUP_STEPS, coordinatorStart, setupDone, setupProject, setupResume, type SetupStepId } from '#shared/pm/setup'
import { projectOption } from '~/utils/projectOption'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ project?: string, adding?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const data = ref<PmOverview | null>(null)
const key = ref<string>()
const fresh = ref(false) // a new project is being added: none picked by default
const index = ref(0)
const first = ref(0) // the step it opened on when adding: nothing before it to go back to
const busy = ref(false)
const error = ref('')

const done = computed(() => setupDone(data.value, key.value, coordinators.value, started.value))
const step = computed<SetupStepId | undefined>(() => SETUP_STEPS[index.value])
const p = computed(() => data.value?.projects.find(x => x.key === key.value))
const coord = computed(() => coordinators.value.find(c => c.project === key.value))
const pane = computed(() => (coord.value ? coordinatorPane(coord.value) : undefined))
const started = computed(() => coordinatorStart(pane.value))

async function load() {
  const [o] = await Promise.all([api<PmOverview>('/api/pm/overview'), loadCoordinators()])
  data.value = o
  // The one picked here, else the one asked, else the first with a step left.
  key.value = [key.value, props.project].find(k => k && o.projects.some(x => x.key === k)) ?? (fresh.value ? undefined : setupProject(o, coordinators.value))
}
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await fn(); await load(); emit('changed') }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
watch(open, (o) => {
  if (!o) return
  data.value = null
  key.value = undefined
  fresh.value = !!props.adding
  error.value = ''
  load().then(() => {
    index.value = fresh.value ? Number(done.value.enable) : setupResume(done.value)
    first.value = fresh.value ? index.value : 0
  }, (e) => { error.value = (e as Error).message })
}, { immediate: true })

// 2. A project: added here (SetupProject), then its repository's visibility,
// which the user may correct, and its coordinator's agent and model.
function addProject() { fresh.value = true; key.value = undefined }
function added(k: string) { fresh.value = false; key.value = k; run(async () => {}) }
const VISIBILITY = [{ label: 'Repository: not checked', value: 'unknown', disabled: true }, { label: 'Public repository', value: 'public' }, { label: 'Private repository', value: 'private' }]
const visibilityItems = computed(() => VISIBILITY.map(v => ({ ...v, label: tl(v.label) })))
const setVisibility = (value: string) => run(() => api('/api/pm/project-visibility', { key: key.value, value }))
const visibility = (v?: RepoVisibility) => v?.value ?? 'unknown'
const projectItems = computed(() => (data.value?.projects ?? []).filter(x => x.git !== false).map(x => projectOption(x)))
watch(key, (k, old) => { if (old && k) run(async () => {}) })
const agents = computed(() => offerCoordinators(undefined, key.value))
const agent = ref('')
const model = ref('') // empty: the agent's default
// Its name, prefilled with the project's; saved when changed ('' or the project's name: follows it).
const coordName = ref('')
watch(p, x => { coordName.value = x ? x.coordinatorName || x.name : '' }, { immediate: true })
function saveCoordName() {
  const v = coordName.value.trim()
  if (p.value && v !== (p.value.coordinatorName || p.value.name)) run(() => api('/api/pm/project-update', { key: key.value, coordinatorName: v === p.value!.name ? '' : v }))
}
watch(agents, a => { if (!a.some(x => x === agent.value)) agent.value = a[0] ?? '' }, { immediate: true })

// 3. Its coordinator: started with that agent, asked to set up how the user
// works, then its conversation; while it runs, its conversation only.
const meet = () => run(async () => {
  const m = model.value.trim()
  await meetCoordinator(key.value!, isCoordinatorProgram(agent.value) ? { program: agent.value, ...(m ? { model: m } : {}) } : undefined)
  open.value = false
})

// Instead: Alfred's conversation, with the setup asked of it.
const toAlfred = () => run(async () => {
  await askAlfred(ALFRED_SETUP_PROMPT)
  open.value = false
})

const TITLE: Record<SetupStepId, string> = {
  enable: 'Turn on project management',
  project: 'Your project',
  coordinator: 'Meet your coordinator',
}
const BODY: Record<SetupStepId, string> = {
  enable: 'Tasks then follow the workflow of their project. Off, nothing is changed.',
  project: 'A git repository on one of your machines: each task gets its own worktree. Pushes and pull requests need a remote (origin). wherdr checks whether it is public.',
  coordinator: 'Your coordinator looks at the project, then its first message proposes how you work: the checks before a merge, the reviews, who merges. Accept it or refuse it, and change any of it later by talking to it or to Alfred.',
}
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Set up projects')" wide hide-close>
    <div class="setup" data-testid="setup-wizard" :data-step="step ?? 'done'">
      <div class="setup-progress" :style="{ '--steps': SETUP_STEPS.length }" role="progressbar" :aria-valuenow="index" aria-valuemin="0" :aria-valuemax="SETUP_STEPS.length" :aria-label="tl('Setup progress')">
        <i v-for="(s, i) in SETUP_STEPS" :key="s" :class="{ done: done[s], here: i === index }" />
      </div>
      <template v-if="step">
        <p class="mono-label" data-testid="setup-count">{{ tl(`Step ${index + 1} of ${SETUP_STEPS.length}`) }}</p>
        <h2 class="display">{{ tl(TITLE[step]) }}</h2>
        <p class="muted">{{ tl(BODY[step]) }}</p>
      </template>
      <p v-if="!data && !error" class="muted">{{ tl('Loading…') }}</p>

      <template v-else-if="step === 'enable'">
        <UButton v-if="!done.enable" size="xl" color="primary" class="hw-cta" icon="i-lucide-power" :loading="busy" data-testid="setup-enable" @click="run(() => api('/api/pm/enabled', { enabled: true }))">{{ tl('Turn on') }}</UButton>
        <p v-else class="setup-ok" data-testid="setup-ok">{{ tl('Project management is on.') }}</p>
        <UButton size="lg" color="neutral" variant="ghost" class="setup-secondary" icon="i-lucide-message-circle" :loading="busy" data-testid="setup-alfred" @click="toAlfred">{{ tl('Let Alfred guide me') }}</UButton>
      </template>

      <template v-else-if="step === 'project'">
        <SetupProject v-if="!p" :projects="data?.projects ?? []" @added="added" />
        <template v-else>
          <ProjectSelect v-if="projectItems.length > 1" v-model="key" :items="projectItems" size="xl" class="w-full" :aria-label="tl('Project')" data-testid="setup-project" />
          <p class="setup-ok" data-testid="setup-ok">{{ p.name }} <span class="mono-label">{{ p.key }}</span></p>
          <USelect :model-value="visibility(p.visibility)" :items="visibilityItems" size="xl" class="w-full" :disabled="busy" :aria-label="tl('Repository')" data-testid="setup-visibility" @update:model-value="v => setVisibility(String(v))" />
          <small v-if="visibility(p.visibility) !== 'unknown'" class="muted" data-testid="setup-public-note">{{ tl('Public: its coordinator and tasks keep private paths, names and secrets out of it.') }}</small>
          <template v-if="!coord?.terminal && agents.length">
            <label class="field-label" for="setupCoordName">{{ tl('Coordinator name') }}</label>
            <UInput id="setupCoordName" v-model="coordName" size="xl" class="w-full" maxlength="80" :placeholder="p.name" data-testid="setup-coordinator-name" @change="saveCoordName" />
            <span class="field-label">{{ tl('Its coordinator') }}</span>
            <AgentPicker v-model="agent" :programs="agents" />
            <label class="field-label" for="setupModel">{{ tl('Model') }}</label>
            <UInput id="setupModel" v-model="model" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" maxlength="64" :placeholder="tl('default model')" data-testid="setup-model" />
            <small class="muted">{{ tl('Empty: the agent’s default model, also changed later in its conversation.') }}</small>
          </template>
          <UButton size="xl" color="neutral" variant="outline" icon="i-lucide-plus" data-testid="setup-another" @click="addProject">{{ tl('Add another project') }}</UButton>
        </template>
      </template>

      <template v-else-if="step === 'coordinator'">
        <p v-if="started === 'starting'" class="muted" data-testid="setup-starting">{{ tl('Your coordinator is starting…') }}</p>
        <p v-else-if="started === 'asks'" class="setup-ok" data-testid="setup-asks">{{ tl('Your coordinator asks a question before it starts: answer it in its conversation.') }}</p>
        <p v-else-if="started === 'runs'" class="setup-ok" data-testid="setup-ok">{{ tl('Your coordinator runs.') }}</p>
        <p v-else-if="!agent" class="muted" data-testid="setup-no-agent">{{ tl('No offered agent can coordinate: check Settings › Agents.') }}</p>
        <UButton size="xl" color="primary" class="hw-cta" :icon="started === 'none' ? 'i-lucide-play' : 'i-lucide-message-circle'" :loading="busy" :disabled="started === 'none' && !agent" data-testid="setup-meet" @click="meet">{{ started === 'none' ? tl(`Start with ${kindLabel(agent)}`) : started === 'asks' ? tl('Answer its question') : tl('Open its conversation') }}</UButton>
      </template>

      <template v-else-if="data">
        <h2 class="display">{{ tl('Set up') }}</h2>
        <p class="muted" data-testid="setup-complete">{{ tl('Every step is done. Add another project from Settings › Projects.') }}</p>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
    </div>
    <template #footer>
      <div class="setup-nav">
        <UButton v-if="index > first" size="xl" color="neutral" variant="outline" icon="i-lucide-chevron-left" data-testid="setup-back" @click="index--">{{ tl('Back') }}</UButton>
        <UButton v-if="step" size="xl" color="primary" class="setup-next" :disabled="!done[step]" data-testid="setup-next" @click="index++">{{ tl(index === SETUP_STEPS.length - 1 ? 'Finish' : 'Next') }}</UButton>
        <UButton v-else size="xl" color="primary" class="setup-next" data-testid="setup-close" @click="open = false">{{ tl('Close') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.setup { display: grid; gap: 12px; padding-bottom: 12px; }
.setup h2 { margin: 0; font-size: 22px; }
.setup p { margin: 0; }
.setup-progress { display: grid; grid-template-columns: repeat(var(--steps), 1fr); gap: 4px; }
.setup-progress i { height: 4px; background: var(--line); }
.setup-progress i.done { background: var(--done); }
.setup-progress i.here { box-shadow: inset 0 -2px 0 var(--accent); }
.setup-ok { color: var(--text-2); }
.setup-nav { display: flex; justify-content: space-between; gap: 8px; }
.setup-nav > * { min-height: 44px; }
/* Alone (no Back on the first step): Next stays on the right. */
.setup-nav > .setup-next { margin-left: auto; }
/* Disabled: like a disabled main button, not a dimmed solid one that still looks active. */
.setup-nav > button:disabled { background: var(--bg); color: var(--dim); box-shadow: inset 0 0 0 1px var(--line); opacity: 1; }
.setup-secondary { justify-self: center; min-height: 44px; color: var(--text-2); }
</style>
