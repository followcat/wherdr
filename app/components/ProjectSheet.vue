<script setup lang="ts">
// A project's sheet (Settings › Projects › a row): tabs, the one shown in the
// URL (`tab=`). General: name, base branch, repository visibility, the agents
// its tasks start with (the workflow's prefs), where its workflow came from.
// Workflow: ProjectWorkflow, its own entries first in the ⋯ menu. The ⋯ menu
// removes the project. Automations and Autopilot reuse the components shown
// elsewhere; Guards is coming.
import type { Project, TemplateInfo } from '#shared/pm/project'
import { shownKey } from '#shared/pm/projectKey'
import type { LogEntry } from '#shared/pm/templateText'
import type { Prefs, Template } from '#shared/pm/workflow'
import ProjectWorkflow from '~/components/ProjectWorkflow.vue'
import type { RepoVisibility } from '#shared/pm/visibility'
import { PROJECT_TABS, type ProjectTab } from '~/utils/projectTabs'

const props = defineProps<{ project: Project, tab: ProjectTab, templates: TemplateInfo[] }>()
const emit = defineEmits<{ tab: [tab: ProjectTab], close: [], changed: [] }>()
const open = ref(true)
const p = computed(() => props.project)
const TAB_LABEL: Record<ProjectTab, string> = { general: 'General', workflow: 'Workflow', guards: 'Guards', automations: 'Automations', autopilot: 'Autopilot' }

const workflow = ref<Template | null>(null)
const log = ref<LogEntry[]>([])
const loaded = ref(false)
const error = ref('')
const busy = ref('')
const form = reactive({ name: '', key: '', base: '', agent: '', model: '', reviewAgent: '', reviewModel: '' })
async function load() {
  const r = await api<{ workflow: Template | null, log: LogEntry[] }>(`/api/pm/project?key=${encodeURIComponent(p.value.key)}`)
  workflow.value = r.workflow
  log.value = r.log
  const prefs: Prefs = r.workflow?.prefs ?? {}
  Object.assign(form, { name: p.value.name, key: shownKey(p.value), base: p.value.base ?? '', agent: prefs.agent ?? '', model: prefs.model ?? '', reviewAgent: prefs.reviewAgent ?? '', reviewModel: prefs.reviewModel ?? '' })
  loaded.value = true
}
onMounted(() => { load().catch((e) => { error.value = (e as Error).message }); loadCoordinators() })

async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn(); emit('changed') }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const save = () => run('save', async () => {
  const { name, key, base, ...prefs } = form
  await api('/api/pm/project-update', { key: p.value.key, name, base, ...(key.toUpperCase() !== shownKey(p.value) ? { newKey: key } : {}), ...(workflow.value ? { prefs } : {}) })
  await load()
  toast(tl('Saved'))
})

// The working branch: a remote branch of the repo, or a name typed in.
const branches = ref<string[] | null>(null)
const loadBranches = async () => {
  if (branches.value) return
  try { branches.value = (await api<{ branches: string[] }>(`/api/pm/branches?key=${encodeURIComponent(p.value.key)}`)).branches }
  catch (e) { branches.value = []; error.value = (e as Error).message }
}
const branchItems = computed(() => [
  { label: tl('Current branch of the repo', 'Branche actuelle du dépôt'), value: NONE },
  ...[...new Set([...(form.base ? [form.base] : []), ...(branches.value ?? [])])].map(b => ({ label: b, value: b })),
])

// The user's override (public or private), or wherdr's check again.
const setVisibility = (body: { value: string } | { check: true }) => run('vis', () => api('/api/pm/project-visibility', { key: p.value.key, ...body }))
const visibilityNote = (v?: RepoVisibility) => !v ? tl('Not checked yet', 'Pas encore vérifié')
  : v.by === 'user' ? tl('Set by you', 'Choisi par vous')
  : `${v.value === 'unknown' ? tl('Not found', 'Introuvable') : tl('Checked', 'Vérifié')} ${new Date(v.at).toLocaleDateString()}`
const visibilityItems = (v?: RepoVisibility) => [
  ...((v?.value ?? 'unknown') === 'unknown' ? [{ label: tl('Repository: unknown', 'Dépôt : inconnu'), value: 'unknown', disabled: true }] : []),
  { label: tl('Public repository', 'Dépôt public'), value: 'public' },
  { label: tl('Private repository', 'Dépôt privé'), value: 'private' },
]

// The agents its tasks start with: the offered programs, or the workflow's default.
const agentItems = computed(() => [
  { label: tl('Default'), value: NONE },
  ...[...new Set([...offerAgents().filter(k => k !== 'shell'), form.agent, form.reviewAgent].filter(Boolean))].map(k => ({ label: kindLabel(k), value: k })),
])
const agentModel = (k: 'agent' | 'reviewAgent') => computed({ get: () => orNone(form[k]), set: (v: string) => { form[k] = fromNone(v) } })
const agent = agentModel('agent')
const reviewAgent = agentModel('reviewAgent')
const base = computed({ get: () => orNone(form.base), set: (v: string) => { form.base = fromNone(String(v)) } })

// The workflow changed (saved, started over): reload it here and the list.
const workflowChanged = () => { load().catch((e) => { error.value = (e as Error).message }); emit('changed') }
const workflowTab = ref<InstanceType<typeof ProjectWorkflow>>()

const coordinator = computed(() => projectCoordinators.value.find(c => c.project === p.value.key))
const menu = (): MenuItem[] => [
  ...(props.tab === 'workflow' && workflowTab.value ? [...workflowTab.value.menu(), { kind: 'separator' as const }] : []),
  { label: tl(`Remove ${p.value.name}`), icon: 'i-lucide-trash-2', danger: true, run: remove },
]
async function remove() {
  if (!(await askConfirm(tl(`Remove ${p.value.name} from wherdr? Its folder, branches and tasks' worktrees stay on the machine.`), tl('Remove')))) return
  await run('rm', () => api('/api/pm/project-remove', { key: p.value.key }))
  if (!error.value) open.value = false
}
</script>

<template>
  <AppSheet v-model:open="open" :title="p.name" tall wide hide-close @closed="emit('close')">
    <div class="project-sheet" data-testid="project-sheet">
      <div class="project-head">
        <span class="pm-id"><small class="mono-label">{{ shownKey(p) }}</small><small class="pm-path">{{ ltr(shortPath(p.path)) }}</small></span>
        <SpaceMenu :items="menu" :title="p.name" :label="tl(`Options of ${p.name}`)" />
      </div>
      <div class="segmented project-tabs" role="tablist" :style="{ '--segment-count': PROJECT_TABS.length }">
        <button v-for="k in PROJECT_TABS" :id="`project-tab-${k}`" :key="k" type="button" role="tab" :class="{ on: tab === k }" :aria-selected="tab === k" :data-tab="k" @click="emit('tab', k)">
          <span>{{ tl(TAB_LABEL[k]) }}</span>
        </button>
      </div>

      <div class="project-panel" role="tabpanel" :aria-labelledby="`project-tab-${tab}`" data-testid="project-panel">
        <form v-if="tab === 'general'" class="sheet-form" @submit.prevent="save">
          <label class="field-label" for="pmName">{{ t('Name') }}</label>
          <UInput id="pmName" v-model="form.name" size="xl" class="w-full" maxlength="80" data-testid="pm-name" />

          <label class="field-label" for="pmKey">{{ tl('Key') }}</label>
          <span class="pm-field">
            <UInput id="pmKey" v-model="form.key" size="lg" class="pm-key mono" maxlength="10" autocomplete="off" data-testid="pm-key" @update:model-value="v => (form.key = String(v).toUpperCase())" />
            <small class="muted">{{ tl('Task ids start with it. Every task, old ones too, shows the new key; links and commands with a former key still work.') }}</small>
          </span>

          <span class="field-label">{{ tl('Base branch') }}</span>
          <span class="pm-field">
            <USelectMenu
            v-model="base" :items="branchItems" value-key="value" size="lg" class="pm-base-pick mono" create-item
            :search-input="{ placeholder: tl('Branch name', 'Nom de branche'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
            :aria-label="tl('Base branch')" data-testid="pm-base" @update:open="o => o && loadBranches()" @create="v => (form.base = v.trim())"
          />
          <small class="muted">{{ tl('New tasks start their worktree from it, and a step that names no branch opens its PR to it or merges into it. Unset: the repo\'s current branch. Running tasks keep theirs.') }}</small>
          </span>

          <template v-if="workflow">
            <span class="field-label">{{ tl('Agents') }}</span>
            <div class="pm-prefs">
              <span class="muted">{{ tl('Worker') }}</span>
              <USelect v-model="agent" :items="agentItems" size="lg" :aria-label="tl('Worker agent')" data-testid="pm-agent" />
              <UInput v-model="form.model" size="lg" class="mono" :placeholder="tl('default model')" :aria-label="tl('Worker model')" maxlength="80" />
              <span class="muted">{{ tl('Reviewer') }}</span>
              <USelect v-model="reviewAgent" :items="agentItems" size="lg" :aria-label="tl('Reviewer agent')" />
              <UInput v-model="form.reviewModel" size="lg" class="mono" :placeholder="tl('default model')" :aria-label="tl('Reviewer model')" maxlength="80" />
            </div>
          </template>
          <p v-else-if="loaded" class="muted settings-hint">{{ tl('No workflow yet: tasks cannot start until the project starts from a template.') }}</p>
          <UButton type="submit" size="xl" color="primary" variant="solid" class="hw-cta" :loading="busy === 'save'" :disabled="!loaded || busy !== ''" data-testid="pm-save">{{ tl('Save') }}</UButton>

          <span class="field-label pm-later">{{ tl('Repository') }}</span>
          <span class="pm-vis">
            <USelect
              :model-value="p.visibility?.value ?? 'unknown'" :items="visibilityItems(p.visibility)" size="lg" :disabled="busy !== ''" :aria-label="tl(`Repository of ${p.name}`, `Dépôt de ${p.name}`)"
              data-testid="pm-visibility" @update:model-value="v => setVisibility({ value: String(v) })"
            />
            <small class="mono-label">{{ visibilityNote(p.visibility) }}</small>
            <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-refresh-cw" :loading="busy === 'vis'" :disabled="busy !== ''" data-testid="pm-visibility-check" @click="setVisibility({ check: true })">{{ tl('Check again', 'Revérifier') }}</UButton>
          </span>
          <span class="field-label">{{ tl('Template') }}</span>
          <small class="muted" data-testid="pm-from">{{ p.from ? tl(`Based on: ${p.from.template} v${p.from.version}. Information only: changes to the template do not reach the project. To start over from a template: Workflow › ⋯.`) : tl('No template yet: start from one in the Workflow tab.') }}</small>
        </form>
        <ProjectWorkflow v-else-if="tab === 'workflow' && loaded" ref="workflowTab" :project="p" :workflow="workflow" :log="log" :templates="templates" @changed="workflowChanged" @templates="emit('changed')" />
        <ProjectAutomations v-else-if="tab === 'automations'" :project="p.key" :name="p.name" />
        <template v-else-if="tab === 'autopilot'">
          <CoordinatorAutopilot v-if="coordinator" :c="coordinator" />
          <p v-else class="muted settings-hint">{{ tl('This project has no coordinator yet.') }}</p>
          <UButton to="/settings?section=pacing" color="neutral" variant="ghost" size="lg" icon="i-lucide-gauge">{{ tl('Pace of every account') }}</UButton>
        </template>
        <p v-else class="muted settings-hint" data-testid="pm-coming">{{ tl('Coming soon.') }}</p>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </div>
    </div>
  </AppSheet>
</template>

<style scoped>
.project-sheet { display: grid; gap: 14px; }
.project-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-id { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.pm-field { display: grid; gap: 4px; }
.pm-base-pick { width: min(100%, 320px); }
.pm-key { width: min(100%, 160px); }
.pm-path { color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; overflow-wrap: anywhere; }
.pm-later { margin-top: 18px; }
.pm-prefs { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 8px 10px; }
.pm-vis { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
</style>
