<script setup lang="ts">
// The setup window's step 2: a new project from a git folder of a machine (a
// repository found there, or a path; a new or empty folder offers git init),
// its name, key and color. Added without a workflow: its coordinator sets
// one up with the user (step 3).
// Whether its repository is public is checked at once by the server; the
// wizard shows it after.
import type { Project } from '#shared/pm/project'
import { PROJECT_COLORS, defaultColor, type ProjectColor } from '#shared/pm/projectKey'
import { canGitInit, draftBody, draftGit, folderKind, proposeKey, proposeName, type FolderProbe, type ProjectDraft } from '#shared/pm/newProject'

const props = defineProps<{ projects: Project[] }>()
const emit = defineEmits<{ added: [key: string] }>()

const machines = machineChoices
const d = reactive<ProjectDraft>({ machine: machines.value?.find(m => m.local)?.key ?? '', path: '', name: '', key: '', gitInit: false, probe: null })
const color = ref<ProjectColor>(defaultColor(props.projects))
const repos = ref<string[] | null>(null)
const home = ref('')
const busy = ref(false)
const error = ref('')

watch(() => d.machine, async (m) => {
  repos.value = null
  try {
    const r = await api<{ home: string, repos: string[] }>(`/api/pm/repos?machine=${encodeURIComponent(m)}`)
    if (d.machine === m) { repos.value = r.repos.slice(0, 50); home.value = r.home }
  } catch { repos.value = [] }
}, { immediate: true })
const short = (p: string) => (home.value && p.startsWith(`${home.value}/`) ? `~${p.slice(home.value.length)}` : p)

// The folder as it stands, a moment after the last keystroke; name and key follow it until edited.
const auto = { name: '', key: '' }
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => `${d.machine}\n${d.path}`, () => {
  d.probe = null
  error.value = ''
  clearTimeout(timer)
  const name = proposeName(d.path)
  if (!d.name || d.name === auto.name) d.name = auto.name = name
  if (!d.key || d.key === auto.key) d.key = auto.key = name ? proposeKey(name, props.projects.map(p => p.key)) : ''
  if (!d.path.trim()) return
  const at = { machine: d.machine, path: d.path }
  timer = setTimeout(async () => {
    try {
      const p = await api<FolderProbe>(`/api/pm/folder?machine=${encodeURIComponent(at.machine)}&path=${encodeURIComponent(at.path)}`)
      if (d.path === at.path && d.machine === at.machine) d.probe = p
    } catch (e) { error.value = (e as Error).message }
  }, 300)
})
onBeforeUnmount(() => clearTimeout(timer))
const kind = computed(() => (d.probe ? folderKind(d.probe) : null))
// A workflow needs git: a repository, or git init on a new or empty folder.
const ready = computed(() => !!d.probe && draftGit(d) && !!d.key.trim())

async function add() {
  if (!ready.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const { project } = await api<{ project: { key: string } }>('/api/pm/project', { ...draftBody(d), color: color.value })
    emit('added', project.key)
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <form class="sheet-form setup-project" data-testid="setup-project-form" @submit.prevent="add">
    <template v-if="machines">
      <span class="field-label">{{ t('Machine') }}</span>
      <MachineChoice :machines="machines" :model-value="d.machine" @pick="m => d.machine = m.key" />
    </template>
    <span class="field-label">{{ tl('Git repositories') }}</span>
    <div v-if="repos?.length" class="setup-repos" data-testid="setup-repos">
      <button v-for="r in repos" :key="r" type="button" :class="{ on: short(r) === d.path }" @click="d.path = short(r)">
        <b>{{ proposeName(r) }}</b><small class="mono">{{ short(r) }}</small>
      </button>
    </div>
    <p v-else class="muted">{{ repos === null ? tl('Looking for repositories…') : tl('No repository found.') }}</p>
    <label class="field-label" for="setupPath">{{ tl('Or any folder') }}</label>
    <UInput id="setupPath" v-model="d.path" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" placeholder="~/projects/new-app" maxlength="1024" data-testid="setup-path" />
    <p v-if="kind && !canGitInit(kind) && kind !== 'git'" class="form-error">{{ tl('This folder has no git repository: tasks need one.') }}</p>
    <label v-if="kind && canGitInit(kind)" class="toggle-row">
      <span><b>{{ tl('Start a git repository') }}</b><small>git init</small></span>
      <USwitch v-model="d.gitInit" size="xl" />
    </label>
    <div class="setup-name-key">
      <span><label class="field-label" for="setupName">{{ t('Name') }}</label><UInput id="setupName" v-model="d.name" size="xl" class="w-full" maxlength="80" /></span>
      <span><label class="field-label" for="setupKey">{{ tl('Key') }}</label><UInput id="setupKey" v-model="d.key" size="xl" class="w-full mono" autocapitalize="characters" :spellcheck="false" maxlength="10" data-testid="setup-key" /></span>
    </div>
    <span class="field-label">{{ tl('Color') }}</span>
    <div class="setup-colors" role="radiogroup" :aria-label="tl('Color')">
      <button v-for="c in PROJECT_COLORS" :key="c" type="button" role="radio" :aria-checked="color === c" :aria-label="c" :class="{ on: color === c }" :style="{ '--swatch': projectColorVar(c) }" @click="color = c"><i /></button>
    </div>
    <UButton type="submit" size="xl" color="primary" class="hw-cta" icon="i-lucide-plus" :loading="busy" :disabled="!ready" data-testid="setup-add-project">{{ tl('Add project') }}</UButton>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </form>
</template>

<style scoped>
.setup-repos { display: grid; max-height: 200px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line); }
.setup-repos button { display: flex; align-items: baseline; gap: 10px; min-height: 44px; padding: 10px 12px; text-align: left; color: var(--text-2); }
.setup-repos button + button { border-top: 1px solid var(--line); }
.setup-repos button.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.setup-repos small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.setup-name-key { display: grid; grid-template-columns: minmax(0, 1fr) 128px; gap: 12px; }
.setup-colors { display: flex; flex-wrap: wrap; gap: 4px; }
.setup-colors button { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid transparent; }
.setup-colors button.on { border-color: var(--text); }
.setup-colors i { width: 20px; height: 20px; background: var(--swatch); }
</style>
