<script setup lang="ts">
// "New" sheet › Project: opens on adding one from a folder of the sheet's
// machine: a git repository found there, a new or empty folder (git init
// offered, off), or any folder without git, taken as it is. Name and key come
// from the folder, editable. No template: the project gets the minimal default
// workflow and its coordinator's first reply proposes one. Below, the existing
// projects whose coordinator does not run (the sidebar has the others), to
// start it again. Then the agent to start the coordinator with.
// Its actions (NewProjectActions) sit in the sheet's footer.
import type { MachineConfig } from '#shared/types'
import { canGitInit, draftGit, folderKind, proposeKey, proposeName, shortHome, type FolderProbe, type ProjectDraft } from '#shared/pm/newProject'

const project = defineModel<string>('project', { required: true })
const agent = defineModel<string>('agent', { required: true })
const draft = defineModel<ProjectDraft | null>('draft', { required: true })
const props = defineProps<{ machine: string, machines?: MachineConfig[] | null }>()
const emit = defineEmits<{ browse: [], machine: [m: MachineConfig] }>()

const current = computed(() => projectCoordinators.value.find(c => c.project === project.value))
const choices = computed(() => (current.value ? offerCoordinators(undefined, current.value.project) : draft.value ? offerCoordinators(undefined, 'NEW') : []))
const fallback = computed(() => (current.value ? coordinatorAgent(current.value)?.program ?? '' : choices.value[0] ?? ''))
// The projects to start again: their coordinator does not run.
const stopped = computed(() => projectCoordinators.value.filter(c => !coordinatorPane(c)))
function pick(key: string) {
  if (key === project.value && !draft.value) return
  haptic()
  draft.value = null
  project.value = key
}
// Another project: its own default agent.
watch([() => current.value?.project, fallback], ([, p]) => { agent.value = p }, { immediate: true })

// ------------------------------------------------------------ add a project
const repos = ref<string[] | null>(null)
const home = ref('')
const search = ref('')
const auto = { name: '', key: '' } // the last proposal: replaced while the user has not changed it
function add(path = '') {
  project.value = ''
  if (draft.value) draft.value.path = path
  else draft.value = { machine: props.machine, path, name: '', key: '', gitInit: false, probe: null }
}
// The folder field: typing there (an existing project picked) adds a project again.
const folder = computed({ get: () => draft.value?.path ?? '', set: (v: string) => add(v) })

// The sheet's machine: its repositories.
watch(() => props.machine, async (m) => {
  if (draft.value) draft.value.machine = m
  repos.value = null
  try {
    const r = await api<{ home: string, repos: string[] }>(`/api/pm/repos?machine=${encodeURIComponent(m)}`)
    if (props.machine === m) { repos.value = r.repos; home.value = r.home }
  } catch { repos.value = [] }
}, { immediate: true })
const short = (p: string) => shortHome(p, home.value)
const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  return (repos.value ?? []).filter(p => !q || short(p).toLowerCase().includes(q)).slice(0, 50)
})

// The folder as it stands, a moment after the last keystroke.
let timer: ReturnType<typeof setTimeout> | undefined
const probeError = ref('')
watch(() => draft.value && `${draft.value.machine}\n${draft.value.path}`, () => {
  const d = draft.value
  if (!d) return
  d.probe = null
  probeError.value = ''
  clearTimeout(timer)
  const name = proposeName(d.path)
  if (!d.name || d.name === auto.name) d.name = name
  auto.name = name
  if (!d.key || d.key === auto.key) d.key = auto.key = name ? proposeKey(name, coordinators.value.map(c => c.project)) : ''
  if (!d.path.trim()) return
  const at = { machine: d.machine, path: d.path }
  timer = setTimeout(async () => {
    try {
      const p = await api<FolderProbe>(`/api/pm/folder?machine=${encodeURIComponent(at.machine)}&path=${encodeURIComponent(at.path)}`)
      if (draft.value?.path === at.path && draft.value.machine === at.machine) draft.value.probe = p
    } catch (e) { probeError.value = (e as Error).message }
  }, 300)
})
onBeforeUnmount(() => clearTimeout(timer))
// Opens on adding a project.
onMounted(() => {
  if (!draft.value) add()
  newProjectOpen.value = false
})
const kind = computed(() => (draft.value?.probe ? folderKind(draft.value.probe) : null))
// No origin (a git init folder, a local repository): what works without one.
const noRemote = computed(() => !!draft.value && draftGit(draft.value) && !draft.value.probe?.remote)
const notes = {
  git: () => tl('Git repository: each task gets its own worktree and pull request.', 'Dépôt git : chaque tâche a son worktree et sa pull request.'),
  new: () => tl('New folder: it is created at start.', 'Nouveau dossier : il est créé au lancement.'),
  empty: () => tl('Empty folder.', 'Dossier vide.'),
  plain: () => tl('Folder without git: the coordinator does the work in it directly, with no tasks.'),
}
</script>

<template>
  <div class="coord-new" data-testid="coordinator-form">
    <template v-if="machines">
      <label class="field-label">{{ t('Machine') }}</label>
      <MachineChoice :machines="machines" :model-value="machine" @pick="m => emit('machine', m)" />
    </template>
    <label class="field-label" for="projectSearch">{{ tl('Git repositories', 'Dépôts git') }}</label>
    <UInput
      id="projectSearch" v-model="search" size="xl" class="w-full" autocapitalize="none" autocorrect="off" :spellcheck="false"
      :placeholder="tl('Search the repositories', 'Chercher un dépôt')"
    />
    <div v-if="shown.length" class="coord-projects repo-list" data-testid="project-repos">
      <button v-for="p in shown" :key="p" type="button" :class="{ on: short(p) === folder }" :data-repo="p" @click="folder = short(p)">
        <span class="coord-name">{{ proposeName(p) }}</span><span class="repo-path">{{ short(p) }}</span>
      </button>
    </div>
    <p v-else class="coord-hint muted">{{ repos === null ? tl('Looking for repositories…', 'Recherche des dépôts…') : tl('No repository found.', 'Aucun dépôt trouvé.') }}</p>

    <label class="field-label" for="projectPath">{{ tl('Or any folder', 'Ou un dossier') }}</label>
    <div class="path-row">
      <UInput
        id="projectPath" v-model="folder" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false"
        placeholder="~/projects/new-app" maxlength="1024"
      />
      <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-folder-open" :aria-label="tl('Browse', 'Parcourir')" @click="add(folder); emit('browse')" />
    </div>

    <template v-if="draft">
      <p v-if="kind || probeError" class="coord-hint" :class="{ 'form-error': probeError }" data-testid="project-folder" :data-folder="kind">{{ probeError ? t(probeError) : notes[kind!]() }}</p>
      <p v-if="noRemote && draft.probe" class="coord-hint muted" data-testid="project-no-remote">
        {{ t('No remote (origin): a merge without a PR goes into a local branch; pushes and pull requests need one:') }}
        <code>git remote add origin &lt;url&gt;</code>
      </p>
      <label v-if="kind && canGitInit(kind)" class="toggle-row">
        <span><b>{{ tl('Start a git repository', 'Créer un dépôt git') }}</b><small>git init</small></span>
        <USwitch v-model="draft.gitInit" color="success" size="xl" data-testid="project-git-init" />
      </label>

      <div class="name-key">
        <span>
          <label class="field-label" for="projectName">{{ t('Name') }}</label>
          <UInput id="projectName" v-model="draft.name" size="xl" class="w-full" maxlength="80" />
        </span>
        <span>
          <label class="field-label" for="projectKey">{{ tl('Key', 'Clé') }}</label>
          <UInput id="projectKey" v-model="draft.key" size="xl" class="w-full mono" autocapitalize="characters" autocorrect="off" :spellcheck="false" maxlength="10" />
        </span>
      </div>
      <p v-if="draftGit(draft)" class="coord-hint muted">{{ tl('Its coordinator looks at the repository and proposes a workflow in its first message.') }}</p>
      <label class="field-label">{{ tl('Agent', 'Agent') }}</label>
      <AgentPicker v-model="agent" :programs="choices" />
      <p v-if="current && fallback" class="coord-hint muted">
        {{ fallback === agent ? tl('The project’s default agent.', 'L’agent par défaut du projet.') : tl(`The default stays ${kindLabel(fallback)}.`, `Le défaut reste ${kindLabel(fallback)}.`) }}
      </p>
      <p v-else-if="!fallback" class="coord-hint muted" data-testid="coordinator-no-agent">{{ tl('No offered agent can coordinate: check Settings › Agents.', 'Aucun agent proposé ne peut coordonner : vois Réglages › Agents.') }}</p>
    </template>

    <template v-if="stopped.length">
      <label class="field-label">{{ tl('Existing projects') }}</label>
      <div class="coord-projects" role="radiogroup" :aria-label="tl('Existing projects')" data-testid="project-existing">
        <button
          v-for="c in stopped" :key="c.project" type="button" role="radio" :class="{ on: !draft && c.project === project }"
          :aria-checked="!draft && c.project === project" :data-project="c.project" @click="pick(c.project)"
        >
          <span class="coord-key">{{ c.project }}</span>
          <span class="coord-name">{{ c.name }}</span>
        </button>
      </div>
    </template>
    <template v-if="current">
      <label class="field-label">{{ tl('Agent', 'Agent') }}</label>
      <AgentPicker v-model="agent" :programs="choices" />
      <p v-if="current && fallback" class="coord-hint muted">
        {{ fallback === agent ? tl('The project’s default agent.', 'L’agent par défaut du projet.') : tl(`The default stays ${kindLabel(fallback)}.`, `Le défaut reste ${kindLabel(fallback)}.`) }}
      </p>
      <p v-else-if="!fallback" class="coord-hint muted" data-testid="coordinator-no-agent">{{ tl('No offered agent can coordinate: check Settings › Agents.', 'Aucun agent proposé ne peut coordonner : vois Réglages › Agents.') }}</p>
    </template>
  </div>
</template>

<style scoped>
.coord-projects { display: grid; border: 1px solid var(--line); }
.coord-projects button {
  display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 12px; text-align: left;
  position: relative; color: var(--text-2);
}
.coord-projects button + button { border-top: 1px solid var(--line); }
.coord-projects button.on { background: var(--surface-2); color: var(--text); }
.coord-projects button.on::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 2px; background: var(--mauve); }
.coord-key { flex: none; font: 500 12px/1 var(--mono); letter-spacing: .08em; }
.coord-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.repo-list { margin-top: 8px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
/* Desktop: a wider sheet (main.css), room for more repositories. */
@media (min-width: 900px) and (min-height: 700px) { .repo-list { max-height: 360px; } }
.repo-path { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px/1.2 var(--mono); color: var(--muted); }
.path-row { display: flex; gap: 8px; }
.path-row > :last-child { flex: none; width: 48px; justify-content: center; }
.name-key { display: grid; grid-template-columns: minmax(0, 1fr) 128px; gap: 12px; }
.coord-note { margin: 14px 2px 0; font-size: 14px; color: var(--text-2); }
.coord-note a, .coord-hint a { color: var(--mauve); text-decoration: underline; }
.coord-hint { margin: 8px 2px 0; font-size: 13px; }
</style>
