<script setup lang="ts">
// A project's sheet (Settings › Projects › a row): tabs, the one shown in the
// URL (`tab=`). General: name, key and color, the other projects its coordinator may act on (ProjectReach), base branch, branch name, when done tasks are archived, repository visibility, the agents
// its tasks start with (the workflow's prefs), its worktree setup (the
// workflow's `worktree`: files copied, folders shared, a setup command), where its workflow came from,
// the machines its tasks may run on (ProjectMachines) and the home tab that
// shows it (ProjectShownIn).
// Workflow: ProjectWorkflow (read only, its chart), its own entries first in the ⋯ menu. The ⋯ menu
// removes the project. Guards: ProjectGuards. Automations: ProjectAutomations,
// this project's only. Autopilot: CoordinatorAutopilot, the one in the
// coordinator window (both read the shared coordinators, so a save in one
// shows in the other), and a link to the pace of every account. A
// coordinator's proposed workflow change: a badge on Workflow, its first row
// there opens the review (ProposalReview), at once when the URL asks (`review=1`).
// Workflow and Autopilot start with their name, what each is and a link to the
// other (PartHead).
import type { Project, TemplateInfo } from '#shared/pm/project'
import { PROJECT_COLORS, shownKey } from '#shared/pm/projectKey'
import { ARCHIVE_DAYS, archiveDays } from '#shared/pm/archive'
import type { LogEntry } from '#shared/pm/templateText'
import { SETUP_TIMEOUT, type Prefs, type Template, type WorktreeSetup } from '#shared/pm/workflow'
import ProjectWorkflow from '~/components/ProjectWorkflow.vue'
import type { RepoVisibility } from '#shared/pm/visibility'
import { PROJECT_TABS, PROJECT_TAB_LABEL as TAB_LABEL, type ProjectTab } from '~/utils/projectTabs'
import { projectTarget, uiTarget } from '#shared/uiTargets'
import { showHalo, waitForElement } from '~/utils/uiHalo'

// projects: every project, for the other projects its coordinator may act on (ProjectReach).
const props = defineProps<{ project: Project, tab: ProjectTab, templates: TemplateInfo[], review?: boolean, projects?: Project[] }>()
const emit = defineEmits<{ tab: [tab: ProjectTab], close: [], changed: [] }>()
const shown = ref(true)
// Unsaved autopilot settings (CoordinatorAutopilot): asked before the sheet closes or the tab changes.
const autopilot = ref<{ leave: () => Promise<boolean> }>()
const keep = async () => !(props.tab === 'autopilot' && autopilot.value && !(await autopilot.value.leave()))
const open = computed({ get: () => shown.value, set: async (v: boolean) => { if (v || (await keep())) shown.value = v } })
const pickTab = async (k: ProjectTab) => { if (k !== props.tab && (await keep())) emit('tab', k) }
const p = computed(() => props.project)

const workflow = ref<Template | null>(null)
const inherited = ref('') // a member's workspace, when it runs that workspace's workflow
const log = ref<LogEntry[]>([])
const ready = ref<Record<string, string>>({}) // each other machine's last readiness check
const loaded = ref(false)
const error = ref('')
const busy = ref('')
const form = reactive({ name: '', coordinatorName: '', key: '', color: '', base: '', branchName: '', archiveAfter: '', deleteBranch: true, agent: '', model: '', reviewAgent: '', reviewModel: '', reviewFallbackAgent: '', reviewFallbackModel: '', reach: {} as Record<string, string> })
const others = computed(() => (props.projects ?? []).filter(x => x.key !== p.value.key))
async function load() {
  const r = await api<{ workflow: Template | null, inherited?: string, log: LogEntry[], ready?: Record<string, string> }>(`/api/pm/project?key=${encodeURIComponent(p.value.key)}`)
  workflow.value = r.workflow
  inherited.value = r.inherited ?? ''
  log.value = r.log
  ready.value = r.ready ?? {}
  fill(p.value, r.workflow?.prefs ?? {})
  fillSetup(r.workflow?.worktree)
  loaded.value = true
  saved.value = snapshot()
}
// Save is enabled only once a field differs from what was loaded or saved.
const snapshot = () => JSON.stringify([form, setup])
const saved = ref('')
const dirty = computed(() => loaded.value && snapshot() !== saved.value)
const fill = (x: Project, prefs: Prefs) => Object.assign(form, { name: x.name, coordinatorName: x.coordinatorName ?? '', key: shownKey(x), color: x.color ?? '', base: x.base ?? '', branchName: x.branchName ?? '', archiveAfter: String(archiveDays(x)), deleteBranch: x.deleteBranch !== false, agent: prefs.agent ?? '', model: prefs.model ?? '', reviewAgent: prefs.reviewAgent ?? '', reviewModel: prefs.reviewModel ?? '', reviewFallbackAgent: prefs.reviewFallbackAgent ?? '', reviewFallbackModel: prefs.reviewFallbackModel ?? '', reach: Object.fromEntries((x.reach ?? []).map(r => [r.project, r.level])) })
// The worktree setup: paths one per line (or comma separated). Folders to
// share: empty is node_modules (no `share`), noShare is none (`share: []`).
const setup = reactive({ copy: '', share: '', noShare: false, lockfile: '', command: '', timeout: '' })
const fillSetup = (w: WorktreeSetup = {}) => Object.assign(setup, { copy: (w.copy ?? []).join('\n'), share: (w.share ?? []).join('\n'), noShare: !!w.share && !w.share.length, lockfile: w.lockfile ?? '', command: w.command ?? '', timeout: w.timeout ?? '' })
const paths = (v: string) => v.split(/[\n,]/).map(x => x.trim()).filter(Boolean)
const setupBody = () => ({ copy: paths(setup.copy), share: setup.noShare ? [] : paths(setup.share).length ? paths(setup.share) : undefined, lockfile: setup.lockfile.trim(), command: setup.command.trim(), timeout: setup.timeout.trim() })
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
  const { name, coordinatorName, key, color, base, branchName, archiveAfter, deleteBranch, reach, ...prefs } = form
  const r = await api<{ project: Project }>('/api/pm/project-update', { key: p.value.key, name, coordinatorName, base, branchName, archiveAfter: Number(archiveAfter), deleteBranch, reach: Object.entries(reach).map(([project, level]) => ({ project, level })), ...(color && color !== p.value.color ? { color } : {}), ...(key.toUpperCase() !== shownKey(p.value) ? { newKey: key } : {}), ...(workflow.value ? { prefs, worktree: setupBody() } : {}) })
  // The prop is refreshed only after `changed`: the form takes the saved
  // project, and the shared lists that show its key and color are read again.
  await load()
  fill(r.project, workflow.value?.prefs ?? {})
  saved.value = snapshot()
  loadCoordinators()
  loadTaskAgents()
  toast(tl('Saved'))
})

// How long a done task stays in Done before it is archived.
const archiveItems = ARCHIVE_DAYS.map(d => ({ label: d ? tl(`${d} day${d > 1 ? 's' : ''}`) : tl('Never'), value: String(d) }))

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
  ...[...new Set([...offerAgents().filter(k => k !== 'shell'), form.agent, form.reviewAgent, form.reviewFallbackAgent].filter(Boolean))].map(k => ({ label: kindLabel(k), value: k })),
])
// The fallback has no default: none, or the agent the user picks.
const fallbackItems = computed(() => [{ label: tl('None'), value: NONE }, ...agentItems.value.slice(1)])
const agentModel = (k: 'agent' | 'reviewAgent' | 'reviewFallbackAgent') => computed({ get: () => orNone(form[k]), set: (v: string) => { form[k] = fromNone(v) } })
const agent = agentModel('agent')
const reviewAgent = agentModel('reviewAgent')
const fallbackAgent = agentModel('reviewFallbackAgent')
const base = computed({ get: () => orNone(form.base), set: (v: string) => { form.base = fromNone(String(v)) } })

// The workflow changed (saved, started over): reload it here and the list.
const workflowChanged = () => { load().catch((e) => { error.value = (e as Error).message }); emit('changed') }
const workflowTab = ref<InstanceType<typeof ProjectWorkflow>>()

const coordinator = computed(() => projectCoordinators.value.find(c => c.project === p.value.key))
const reviewOpen = ref(!!props.review)
// A project target (`&target=project.guards`, shared/uiTargets.ts): its tab's
// part, highlighted once shown (utils/uiHalo.ts).
const route = useRoute()
const sheet = ref<HTMLElement | null>(null)
let endHalo = () => {}
watch(() => `${props.tab}|${route.query.target}|${!!sheet.value}`, async () => {
  endHalo()
  const id = uiTarget(route.query.target)
  if (!id || !projectTarget(id) || !sheet.value) return
  const el = await waitForElement(sheet.value, `[data-ui-target="${id}"]`)
  if (el && uiTarget(route.query.target) === id) { el.scrollIntoView({ block: 'nearest' }); endHalo = showHalo(el) }
}, { immediate: true })
onBeforeUnmount(() => endHalo())
const reviewed = (accepted: boolean) => { if (accepted) workflowChanged() }
const menu = (): MenuItem[] => [
  ...(props.tab === 'workflow' && workflowTab.value ? [...workflowTab.value.menu(), { kind: 'separator' as const }] : []),
  { label: tl(`Remove ${p.value.name}`), icon: 'i-lucide-trash-2', danger: true, run: remove },
]
async function remove() {
  if (!(await askConfirm(tl(`Remove ${p.value.name} from wherdr? Its folder, branches and tasks' worktrees stay on the machine.`), tl('Remove')))) return
  await run('rm', () => api('/api/pm/project-remove', { key: p.value.key }))
  if (!error.value) shown.value = false
}
</script>

<template>
  <AppSheet v-model:open="open" :title="p.name" tall wide hide-close @closed="emit('close')">
    <div ref="sheet" class="project-sheet" data-testid="project-sheet">
      <div class="project-head">
        <span class="pm-id"><small class="mono-label">{{ shownKey(p) }}</small><small class="pm-path">{{ ltr(shortPath(p.path)) }}</small></span>
        <SpaceMenu :items="menu" :title="p.name" :label="tl(`Options of ${p.name}`)" />
      </div>
      <div class="segmented project-tabs" role="tablist" :style="{ '--segment-count': PROJECT_TABS.length }">
        <button v-for="k in PROJECT_TABS" :id="`project-tab-${k}`" :key="k" type="button" role="tab" :class="{ on: tab === k }" :aria-selected="tab === k" :data-tab="k" @click="pickTab(k)">
          <span>{{ tl(TAB_LABEL[k]) }}</span>
          <span v-if="k === 'workflow' && coordinator?.proposal" class="card-state blocked project-tab-badge" :aria-label="tl('A change to review')" data-testid="workflow-badge"><i /></span>
        </button>
      </div>

      <div class="project-panel" role="tabpanel" :aria-labelledby="`project-tab-${tab}`" data-testid="project-panel">
        <form v-if="tab === 'general'" class="sheet-form" :aria-busy="busy !== ''" data-testid="pm-general" @submit.prevent="save">
          <div class="pm-cols">
            <span class="pm-col">
              <label class="field-label" for="pmName">{{ t('Name') }}</label>
              <UInput id="pmName" v-model="form.name" size="xl" class="w-full" maxlength="80" data-testid="pm-name" />
            </span>
            <span class="pm-col">
              <label class="field-label" for="pmKey">{{ tl('Key') }}</label>
              <span class="pm-field">
                <span class="pm-key-row">
                  <UInput id="pmKey" v-model="form.key" size="lg" class="pm-key mono" maxlength="10" autocomplete="off" data-testid="pm-key" @update:model-value="v => (form.key = String(v).toUpperCase())" />
                  <ProjectBadge :text="form.key || shownKey(p)" :color="form.color" />
                </span>
                <span class="pm-colors" role="radiogroup" :aria-label="tl('Color')" data-testid="pm-colors">
                  <button
                    v-for="c in PROJECT_COLORS" :key="c" type="button" role="radio" class="pm-color" :class="{ on: form.color === c }" :aria-checked="form.color === c" :aria-label="tl(c)" :title="tl(c)"
                    :style="{ '--key-c': projectColorVar(c) }" :data-color="c" @click="form.color = c"
                  ><i /></button>
                </span>
                <small class="muted">{{ tl('Task ids start with it. Every task, old ones too, shows the new key; links and commands with a former key still work.') }}</small>
              </span>
            </span>
          </div>

          <label class="field-label" for="pmCoordName">{{ tl('Coordinator name') }}</label>
          <span class="pm-field">
            <UInput id="pmCoordName" v-model="form.coordinatorName" size="lg" class="w-full" maxlength="80" :placeholder="form.name" data-testid="pm-coordinator-name" />
            <small class="muted">{{ tl('Shown after the key badge in the sidebar and its conversation. Empty: the project’s name.') }}</small>
          </span>

          <template v-if="others.length">
            <span class="field-label">{{ tl('Other projects this coordinator may act on') }}</span>
            <span class="pm-field">
              <ProjectReach v-model="form.reach" :projects="others" />
              <small class="muted">{{ tl('Read: it lists and reads their tasks. Act: it also adds, starts, stops and edits them, and tells their agents. Their guards, merges, approvals, settings and autopilot stay with their own coordinator and you. Each action is in their log, and their coordinator is told.') }}</small>
            </span>
          </template>

          <span class="field-label">{{ tl('Base branch') }}</span>
          <span class="pm-field">
            <USelectMenu
            v-model="base" :items="branchItems" value-key="value" size="lg" class="pm-base-pick mono" create-item
            :search-input="{ placeholder: tl('Branch name', 'Nom de branche'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
            :aria-label="tl('Base branch')" data-testid="pm-base" @update:open="o => o && loadBranches()" @create="v => (form.base = v.trim())"
          />
          <small class="muted">{{ tl('New tasks start their worktree from it, and a step that names no branch opens its PR to it or merges into it. Unset: the repo\'s current branch. Running tasks keep theirs.') }}</small>
          </span>

          <span class="field-label">{{ tl('Branch name') }}</span>
          <span class="pm-field">
            <UInput v-model="form.branchName" size="lg" class="pm-base-pick mono" placeholder="task/{id}" :aria-label="tl('Branch name')" maxlength="80" data-testid="pm-branch-name" />
            <small class="muted">{{ tl('Each new task\'s branch. Fields: {id}, {tag} (the card\'s ticket key, else the task id), {type} (bugfix or feature), {slug} (from the title). Example: {type}/{tag}-{slug}.') }}</small>
          </span>

          <span class="field-label">{{ tl('Archive done tasks after') }}</span>
          <span class="pm-field">
            <USelect v-model="form.archiveAfter" :items="archiveItems" size="lg" class="pm-base-pick" :aria-label="tl('Archive done tasks after')" data-testid="pm-archive-after" />
            <small class="muted">{{ tl('A done task leaves the Done column after this time; the column\'s footer lists archived tasks. Its branch, PR and log stay.') }}</small>
          </span>

          <span class="field-label">{{ tl('Delete the task\'s branch after its merge') }}</span>
          <span class="pm-field">
            <USwitch v-model="form.deleteBranch" color="success" size="lg" :aria-label="tl('Delete the task\'s branch after its merge')" data-testid="pm-delete-branch" />
            <small class="muted">{{ tl('Once its PR is merged, wherdr deletes the task\'s remote branch, unless a commit came after the merge, another open PR uses it, or it is protected or a base. Off: branches stay.') }}</small>
          </span>

          <template v-if="workflow">
            <div class="pm-cols">
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Worker') }}</span>
                <USelect v-model="agent" :items="agentItems" size="lg" class="w-full" :aria-label="tl('Worker agent')" data-testid="pm-agent" />
                <UInput v-model="form.model" size="lg" class="w-full mono" :placeholder="tl('default model')" :aria-label="tl('Worker model')" maxlength="80" />
              </span>
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Reviewer') }}</span>
                <USelect v-model="reviewAgent" :items="agentItems" size="lg" class="w-full" :aria-label="tl('Reviewer agent')" />
                <UInput v-model="form.reviewModel" size="lg" class="w-full mono" :placeholder="tl('default model')" :aria-label="tl('Reviewer model')" maxlength="80" />
              </span>
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Fallback') }}</span>
                <USelect v-model="fallbackAgent" :items="fallbackItems" size="lg" class="w-full" :aria-label="tl('Reviewer fallback agent')" data-testid="pm-fallback-agent" />
                <UInput v-model="form.reviewFallbackModel" size="lg" class="w-full mono" :placeholder="tl('model, or same')" :aria-label="tl('Reviewer fallback model')" maxlength="80" />
              </span>
            </div>
          </template>
          <small v-if="workflow" class="muted">{{ tl('Fallback: the reviewer started instead while the reviewer\'s account is out of quota. None: reviews wait for it.') }}</small>
          <template v-if="workflow">
            <span class="field-label pm-later">{{ tl('Worktree setup') }}</span>
            <!-- Help first, then a two-column grid (one column on the phone) with
                 no hole: Share no folder takes a full row, Time limit the left cell. -->
            <span class="pm-help muted" data-testid="pm-setup-help">
              <small>{{ tl('Prepared before a task\'s first worker.') }}</small>
              <small>{{ tl('Files to copy: ignored files taken from the project\'s clone (a tracked or missing one is skipped).') }}</small>
              <small>{{ tl('Folders to share: taken from the clone while the lockfile is the same in both; otherwise the setup command runs, at most 10m. Empty: node_modules.') }}</small>
            </span>
            <div class="pm-setup">
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmCopy">{{ tl('Files to copy') }}</label>
                <UTextarea id="pmCopy" v-model="setup.copy" :rows="2" autoresize size="lg" class="w-full mono" placeholder=".env" maxlength="4000" data-testid="pm-setup-copy" />
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmShare">{{ tl('Folders to share') }}</label>
                <UTextarea id="pmShare" v-model="setup.share" :rows="2" autoresize size="lg" class="w-full mono" placeholder="node_modules" maxlength="4000" :disabled="setup.noShare" data-testid="pm-setup-share" />
              </span>
              <label class="toggle-row pm-wide">
                <span><b>{{ tl('Share no folder') }}</b><small>{{ tl('The setup command always runs') }}</small></span>
                <USwitch v-model="setup.noShare" color="success" size="xl" data-testid="pm-setup-no-share" />
              </label>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmCommand">{{ tl('Setup command') }}</label>
                <UInput id="pmCommand" v-model="setup.command" size="lg" class="w-full mono" placeholder="npm ci --prefer-offline" maxlength="500" data-testid="pm-setup-command" />
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmLock">{{ tl('Lockfile') }}</label>
                <UInput id="pmLock" v-model="setup.lockfile" size="lg" class="w-full mono" placeholder="package-lock.json" maxlength="200" />
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmTimeout">{{ tl('Time limit') }}</label>
                <UInput id="pmTimeout" v-model="setup.timeout" size="lg" class="w-full mono" :placeholder="SETUP_TIMEOUT" maxlength="4" />
              </span>
            </div>
          </template>
          <p v-else-if="loaded" class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one, or start from a template.') }}</p>
          <div class="pm-save">
            <UButton type="submit" size="xl" color="primary" variant="solid" class="hw-cta" :loading="busy === 'save'" :disabled="!dirty || busy !== ''" data-testid="pm-save">{{ tl('Save') }}</UButton>
          </div>

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
          <small class="muted" data-testid="pm-from">{{ p.from ? tl(`Based on: ${p.from.template} v${p.from.version}. Information only: changes to the template do not reach the project. To change the workflow, ask the project\'s coordinator.`) : tl('No template yet: start from one in the Workflow tab.') }}</small>
        </form>
        <template v-if="tab === 'general'">
          <span class="field-label pm-later">{{ tl('Machines') }}</span>
          <ProjectMachines :project="p" :ready="ready" @changed="emit('changed')" />
          <span class="field-label pm-later">{{ tl('Shown in') }}</span>
          <ProjectShownIn :project="p" />
        </template>
        <template v-if="tab === 'workflow'">
          <PartHead part="workflow" :project="p.key" class="pm-part" />
        </template>
        <button v-if="tab === 'workflow' && coordinator?.proposal" type="button" class="settings-card pm-proposal" data-testid="workflow-proposal" @click="reviewOpen = true">
          <span class="card-state blocked" aria-hidden="true"><i /></span>
          <span class="pm-proposal-text">{{ tl('Change proposed by the coordinator') }}</span>
          <span class="mono-label">{{ tl('Review') }}</span>
          <UIcon name="i-lucide-chevron-right" />
        </button>
        <p v-if="(tab === 'workflow' || tab === 'guards') && loaded && inherited" class="muted settings-hint" data-testid="pm-inherited">{{ tl(`Runs the workflow of workspace ${inherited}, whose guards apply too. A change saved here gives this project its own.`) }}</p>
        <ProjectWorkflow v-if="tab === 'workflow' && loaded" ref="workflowTab" data-ui-target="project.workflow" :project="p" :workflow="workflow" :log="log" :templates="templates" @changed="workflowChanged" @templates="emit('changed')" />
        <template v-else-if="tab === 'guards' && loaded">
          <ProjectGuards v-if="workflow" data-ui-target="project.guards" :project="p" :workflow="workflow" @changed="workflowChanged" />
          <p v-else class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one, or start from a template.') }}</p>
        </template>
        <ProjectAutomations v-else-if="tab === 'automations'" :project="p.key" :name="p.name" />
        <template v-else-if="tab === 'autopilot'">
          <PartHead part="autopilot" :project="p.key" class="pm-part" />
          <CoordinatorAutopilot v-if="coordinator" ref="autopilot" data-ui-target="project.autopilot" :c="coordinator" />
          <p v-else-if="coordinatorsLoaded" class="muted settings-hint">{{ tl('This project has no coordinator yet.') }}</p>
          <UButton to="/settings?section=pacing" color="neutral" variant="ghost" size="lg" icon="i-lucide-gauge">{{ tl('Pace of every account') }}</UButton>
        </template>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </div>
    </div>
    <ProposalReview v-if="coordinator" v-model:open="reviewOpen" :c="coordinator" @answered="reviewed" />
  </AppSheet>
</template>

<style scoped>
.project-sheet { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.project-panel { min-width: 0; }
.project-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-id { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.pm-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.pm-base-pick { width: min(100%, 320px); }
.pm-key { width: min(100%, 160px); }
.pm-key-row { display: flex; align-items: center; gap: 10px; }
/* The palette: small squares, each in a 44 px button; the picked one framed.
   Each square sits at its button's start (3 px in, for the frame), so the first
   lines up with the fields above and the row never exceeds the sheet's width. */
.pm-colors { display: flex; flex-wrap: wrap; }
.pm-color { display: grid; place-items: center start; width: 44px; height: 44px; padding: 0 0 0 3px; border: 0; background: none; cursor: pointer; }
.pm-color i { width: 20px; height: 20px; background: var(--key-c); box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px transparent; }
.pm-color.on i { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--text); }
.pm-color:focus-visible { outline: 1px solid var(--accent); outline-offset: -4px; }
.pm-path { color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; overflow-wrap: anywhere; }
.pm-later { margin-top: 18px; }
/* Save: its own row under the fields, never inline in a text. */
.pm-save { display: flex; margin-top: 16px; }
/* The worktree setup: short help lines, then two columns at most (one on the
   phone, under 540 px) filled in order; a .pm-wide item takes a whole row. */
.pm-help { display: grid; gap: 2px; margin-bottom: 10px; }
.pm-setup { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, max(260px, calc(50% - 10px))), 1fr)); gap: 12px 20px; align-items: start; }
.pm-wide { grid-column: 1 / -1; }
.pm-setup .toggle-row { margin-top: 0; }
/* Two fields side by side where there is room (name and key, worker and
   reviewer), one under the other on the phone. */
.pm-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 0 20px; align-items: start; }
.pm-col { display: grid; min-width: 0; }
.pm-agent { gap: 8px; }
.pm-agent .field-label { margin-bottom: 0; }
.pm-part { margin-bottom: 12px; }
.project-tab-badge { margin-left: 6px; }
.pm-proposal { display: flex; align-items: center; gap: 10px; width: 100%; margin-bottom: 12px; padding: 12px 16px; text-align: left; color: var(--blocked); }
.pm-proposal-text { flex: 1; min-width: 0; color: var(--text); }
.pm-vis { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
</style>
