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
// there with Accept / Refuse (as the chat's card) and See all changes, the
// review (ProposalReview), opened at once when the URL asks (`review=1`).
// Workflow and Autopilot start with their name, what each is and a link to the
// other (PartHead).
import type { Project } from '#shared/pm/project'
import { PROJECT_COLORS, shownKey } from '#shared/pm/projectKey'
import { ARCHIVE_DAYS, archiveDays } from '#shared/pm/archive'
import { liftShared, type SharedField } from '#shared/pm/workspace'
import type { LogEntry } from '#shared/pm/templateText'
import { SETUP_TIMEOUT, checkSetup, isRelPath, type Prefs, type Template, type WorkflowError, type WorktreeSetup } from '#shared/pm/workflow'
import { missingBaseNote, workflowBase } from '#shared/pm/run'
import { STATE_EVENTS, type OnStateChange, type StateEvent } from '#shared/pm/onState'
import ProjectWorkflow from '~/components/ProjectWorkflow.vue'
import type { RepoVisibility } from '#shared/pm/visibility'
import { PROJECT_TABS, PROJECT_TAB_LABEL as TAB_LABEL, type ProjectTab } from '~/utils/projectTabs'
import { projectTarget, uiTarget } from '#shared/uiTargets'
import { showHalo, waitForElement } from '~/utils/uiHalo'

// projects: every project, for the other projects its coordinator may act on (ProjectReach).
const props = defineProps<{ project: Project, tab: ProjectTab, review?: boolean, projects?: Project[] }>()
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
const form = reactive({ name: '', coordinatorName: '', key: '', color: '', base: '', branchName: '', commitMessage: '', onStateCommand: '', onStateEvents: ['done'] as string[], archiveAfter: '', deleteBranch: true, agent: '', model: '', reviewAgent: '', reviewModel: '', reviewFallbackAgent: '', reviewFallbackModel: '', reach: {} as Record<string, string> })
const others = computed(() => (props.projects ?? []).filter(x => x.key !== p.value.key))
// The sheet's latest copy of the project (a save answers before the prop follows).
const last = shallowRef(props.project)
watch(() => props.project, (v) => { last.value = v })
async function read() {
  const r = await api<{ workflow: Template | null, inherited?: string, log: LogEntry[], ready?: Record<string, string> }>(`/api/pm/project?key=${encodeURIComponent(p.value.key)}`)
  workflow.value = r.workflow
  inherited.value = r.inherited ?? ''
  log.value = r.log
  ready.value = r.ready ?? {}
}
async function load(x = p.value) {
  await read()
  filling = true
  fill(x, workflow.value?.prefs ?? {})
  fillSetup(workflow.value?.worktree)
  fillInstr(x)
  sentWas = snap(fields())
  filling = false
  keyInput.value = form.key
  loaded.value = true
}
// A workspace's base, branch name, archive delay and delete-branch are in its shared settings (liftShared).
const fill = (raw: Project, prefs: Prefs, x = liftShared(raw)) => Object.assign(form, { name: x.name, coordinatorName: x.coordinatorName ?? '', key: shownKey(x), color: x.color ?? '', base: x.base ?? '', branchName: x.branchName ?? '', commitMessage: (x.kind === 'workspace' ? x.shared?.commitMessage : x.commitMessage) ?? '', ...onStateForm(x.kind === 'workspace' ? x.shared?.onStateChange : x.onStateChange), archiveAfter: String(archiveDays(x)), deleteBranch: x.deleteBranch !== false, agent: prefs.agent ?? '', model: prefs.model ?? '', reviewAgent: prefs.reviewAgent ?? '', reviewModel: prefs.reviewModel ?? '', reviewFallbackAgent: prefs.reviewFallbackAgent ?? '', reviewFallbackModel: prefs.reviewFallbackModel ?? '', reach: Object.fromEntries((x.reach ?? []).map(r => [r.project, r.level])) })
// The On state change command and its events (none set: done ticked, for a first command).
const onStateForm = (o?: OnStateChange) => ({ onStateCommand: o?.command ?? '', onStateEvents: o ? [...o.events] : ['done'] })
const onStateBody = () => ({ command: form.onStateCommand, events: form.onStateEvents })
const STATE_LABEL: Record<StateEvent, string> = { started: 'Starts', waits: 'Waits for you', done: 'Done', failed: 'Fails or is stopped' }
const toggleEvent = (e: StateEvent, on: boolean) => { form.onStateEvents = STATE_EVENTS.filter(x => (x === e ? on : form.onStateEvents.includes(x))) }
// The worktree setup: paths one per line (or comma separated). Folders to
// share: empty is node_modules (no `share`), noShare is none (`share: []`).
const setup = reactive({ copy: '', share: '', noShare: false, lockfile: '', command: '', timeout: '' })
const fillSetup = (w: WorktreeSetup = {}) => Object.assign(setup, { copy: (w.copy ?? []).join('\n'), share: (w.share ?? []).join('\n'), noShare: !!w.share && !w.share.length, lockfile: w.lockfile ?? '', command: w.command ?? '', timeout: w.timeout ?? '' })
const paths = (v: string) => v.split(/[\n,]/).map(x => x.trim()).filter(Boolean)
const setupBody = () => ({ copy: paths(setup.copy), share: setup.noShare ? [] : paths(setup.share).length ? paths(setup.share) : undefined, lockfile: setup.lockfile.trim(), command: setup.command.trim(), timeout: setup.timeout.trim() })
// Workspace instructions files (workspace.ts), on a workspace or a member:
// inherit (the workspace's, or on a workspace the default), off ([]), or these files.
const wsKind = computed(() => (p.value.kind === 'workspace' ? 'workspace' : p.value.workspace ? 'member' : ''))
// rootSkills: the root's .claude/skills in its members' worktrees (a workspace's only).
const instr = reactive({ instrMode: 'inherit', instrFiles: '', rootSkills: 'default' })
const fillInstr = (x: Project) => {
  const list = x.workspace ? ((x.overrides ?? []).includes('instructionsFiles') ? x.instructionsFiles ?? [] : undefined) : x.shared?.instructionsFiles
  Object.assign(instr, { instrMode: !list ? 'inherit' : list.length ? 'files' : 'off', instrFiles: (list ?? []).join('\n'), rootSkills: x.shared?.rootSkills === false ? 'off' : 'default' })
}
const skillItems = computed(() => [{ label: tl('Default: the root\'s .claude/skills'), value: 'default' }, { label: tl('None'), value: 'off' }])
const instrBody = () => (instr.instrMode === 'off' ? [] : instr.instrMode === 'files' && paths(instr.instrFiles).length ? paths(instr.instrFiles) : null)
const instrItems = computed(() => [
  { label: wsKind.value === 'workspace' ? tl('Default: AGENTS.md, else CLAUDE.md') : tl(`${wsName.value}'s`), value: 'inherit' },
  { label: tl('These files'), value: 'files' },
  { label: tl('None'), value: 'off' },
])
// The server's own rules on the setup (empty fields dropped), each error under its field.
const invalid = (): Record<string, string> => {
  const errs: WorkflowError[] = []
  checkSetup(Object.fromEntries(Object.entries(setupBody()).filter(([, v]) => v !== '' && v !== undefined)), errs)
  const out = Object.fromEntries(errs.map(e => [e.path.replace('worktree.', ''), tl(`${e.message[0]!.toUpperCase()}${e.message.slice(1)}.`)]))
  const files = instr.instrMode === 'files' ? paths(instr.instrFiles) : []
  if (files.length > 10 || !files.every(isRelPath)) out.instrFiles = tl('Up to 10 paths under the workspace\'s root (no *, no .., not absolute).')
  return out
}

// A member's settings: each one follows its workspace (shown "From <workspace>")
// until changed here (ProjectFollow); "Use <workspace>'s" clears that one and
// fills the form again from the project the server answers.
const wsName = computed(() => (props.projects ?? []).find(x => x.key === p.value.workspace)?.name ?? p.value.workspace ?? '')
const follows = (f: SharedField) => !!p.value.workspace && !(last.value.overrides ?? []).includes(f)
const followed = (x: Project) => {
  last.value = x
  emit('changed')
  load(x).catch((e) => { error.value = (e as Error).message })
}

// Every field saves by itself (useAutosave): the whole form in one call, each
// field's Saved mark on its group (agent and model together, key and color).
// Only the fields the user changed are sent: a member's other fields keep
// following its workspace (its working branch, agents, worktree setup...),
// and an unchanged agent never writes a workflow.
const fields = () => {
  const { name, coordinatorName, key: _k, color: _c, base, branchName, commitMessage, onStateCommand: _oc, onStateEvents: _oe, archiveAfter, deleteBranch, reach, ...prefs } = form
  return { name, coordinatorName, base, branchName, commitMessage, onStateChange: onStateBody(), archiveAfter: Number(archiveAfter), deleteBranch, reach: Object.entries(reach).map(([project, level]) => ({ project, level })), ...(workflow.value ? { prefs, worktree: setupBody() } : {}), ...(wsKind.value ? { instructionsFiles: instrBody() } : {}), ...(wsKind.value === 'workspace' ? { rootSkills: instr.rootSkills !== 'off' } : {}) } as Record<string, unknown>
}
const snap = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]))
let sentWas: Record<string, string> = {}
const send = async () => {
  const { key, color } = form
  const was = last.value
  const changed = Object.fromEntries(Object.entries(fields()).filter(([k, v]) => JSON.stringify(v) !== sentWas[k]))
  const r = await api<{ project: Project }>('/api/pm/project-update', { key: was.key, ...changed, ...(color && color !== was.color ? { color } : {}), ...(key.toUpperCase() !== shownKey(was) ? { newKey: key } : {}) })
  sentWas = { ...sentWas, ...snap(changed) }
  // The form keeps what was typed; the shared lists that show its key, color and agents are read again.
  last.value = r.project
  emit('changed')
  await read()
  loadCoordinators()
  loadTaskAgents()
}
const auto = useAutosave(send, invalid)
const GROUP: Record<string, string> = { instrFiles: 'instrMode', color: 'key', agent: 'worker', model: 'worker', reviewAgent: 'reviewer', reviewModel: 'reviewer', reviewFallbackAgent: 'fallback', reviewFallbackModel: 'fallback', noShare: 'share', onStateCommand: 'onState', onStateEvents: 'onState' }
// The key is typed in keyInput and saved only on blur or Enter (commitKey): a
// pause mid-rename would make a partial key a real rename and a former key for good.
const keyInput = ref('')
const commitKey = () => { form.key = keyInput.value }
const TYPED = ['name', 'coordinatorName', 'branchName', 'commitMessage', 'onStateCommand', 'model', 'reviewModel', 'reviewFallbackModel', 'copy', 'share', 'lockfile', 'command', 'timeout', 'instrFiles']
let filling = false
for (const [o, keys] of [[form, Object.keys(form)], [setup, Object.keys(setup)], [instr, Object.keys(instr)]] as const)
  for (const k of keys) watch(() => JSON.stringify((o as Record<string, unknown>)[k]), () => { if (!filling) auto.change(GROUP[k] ?? k, !TYPED.includes(k)) }, { flush: 'sync' })
onMounted(() => { load().catch((e) => { error.value = (e as Error).message }); loadCoordinators() })

async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn(); emit('changed') }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
// How long a done task stays in Done before it is archived.
const archiveItems = ARCHIVE_DAYS.map(d => ({ label: d ? tl(`${d} day${d > 1 ? 's' : ''}`) : tl('Never'), value: String(d) }))

// The working branch: a remote branch of the repo, or a name typed in.
const branches = ref<string[] | null>(null)
const head = ref<{ current: string, local: string[] } | null>(null) // its current branch and local ones, once read
const loadBranches = async () => {
  if (branches.value) return
  try {
    const r = await api<{ branches: string[], current: string, local: string[] }>(`/api/pm/branches?key=${encodeURIComponent(p.value.key)}`)
    branches.value = r.branches
    head.value = { current: r.current, local: r.local }
  }
  catch (e) { branches.value = []; error.value = (e as Error).message }
}
// A member following its workspace's working branch, which its repository lacks: tasks start from its current one (pmLaunch).
// Only once read (a failed read says nothing); a repository without origin has no remote branch.
const baseMissing = computed(() => (follows('base') && form.base && head.value && !branches.value?.includes(form.base) && !head.value.local.includes(form.base) ? missingBaseNote(form.base, head.value.current) : ''))
watch(() => loaded.value && follows('base') && !!form.base, (v) => { if (v) loadBranches() }, { immediate: true })
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
// No working branch set: the branch its workflow opens PRs to, where tasks then start.
const fromWorkflow = computed(() => (form.base ? undefined : Object.keys(workflow.value?.taskTypes ?? {}).map(k => workflowBase(workflow.value, k)).find(Boolean)))
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
// Accept / Refuse on the Workflow tab's proposal row, as on its card in the chat.
const { busy: answerBusy, error: answerError, answer } = useProposalAnswer(() => p.value.key, reviewed)
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
        <form v-if="tab === 'general'" class="sheet-form" :aria-busy="busy !== '' || auto.busy.value" data-testid="pm-general" @submit.prevent="commitKey(); auto.flush()" @focusout="commitKey(); auto.flush()">
          <p v-if="wsKind === 'member'" class="muted pm-follow-intro" data-testid="pm-follow-intro">{{ tl(`Settings come from ${wsName} unless you change one here.`) }}</p>
          <div class="pm-cols">
            <span class="pm-col">
              <label class="field-label" for="pmName">{{ t('Name') }}<SavedMark :s="auto.state.name" /></label>
              <UInput id="pmName" v-model="form.name" size="xl" class="w-full" maxlength="80" data-testid="pm-name" />
              <small v-if="auto.errors.name" class="form-error pm-field-error" role="alert">{{ t(auto.errors.name) }}</small>
            </span>
            <span class="pm-col">
              <label class="field-label" for="pmKey">{{ tl('Key') }}<SavedMark :s="auto.state.key" /></label>
              <span class="pm-field">
                <span class="pm-key-row">
                  <UInput id="pmKey" v-model="keyInput" size="lg" class="pm-key mono" maxlength="10" autocomplete="off" data-testid="pm-key" @update:model-value="v => (keyInput = String(v).toUpperCase())" />
                  <ProjectBadge :text="keyInput || shownKey(p)" :color="form.color" />
                </span>
                <span class="pm-colors" role="radiogroup" :aria-label="tl('Color')" data-testid="pm-colors">
                  <button
                    v-for="c in PROJECT_COLORS" :key="c" type="button" role="radio" class="pm-color" :class="{ on: form.color === c }" :aria-checked="form.color === c" :aria-label="tl(c)" :title="tl(c)"
                    :style="{ '--key-c': projectColorVar(c) }" :data-color="c" @click="form.color = c"
                  ><i /></button>
                </span>
                <small v-if="auto.errors.key" class="form-error pm-field-error" role="alert">{{ t(auto.errors.key) }}</small>
                <small class="muted">{{ tl('Task ids start with it. Every task, old ones too, shows the new key; links and commands with a former key still work.') }}</small>
              </span>
            </span>
          </div>

          <label class="field-label" for="pmCoordName">{{ tl('Coordinator name') }}<SavedMark :s="auto.state.coordinatorName" /></label>
          <span class="pm-field">
            <UInput id="pmCoordName" v-model="form.coordinatorName" size="lg" class="w-full" maxlength="80" :placeholder="form.name" data-testid="pm-coordinator-name" />
            <small v-if="auto.errors.coordinatorName" class="form-error pm-field-error" role="alert">{{ t(auto.errors.coordinatorName) }}</small>
            <small class="muted">{{ tl('Shown after the key badge in the sidebar and its conversation. Empty: the project’s name.') }}</small>
          </span>

          <template v-if="others.length">
            <span class="field-label">{{ tl('Other projects this coordinator may act on') }}<SavedMark :s="auto.state.reach" /></span>
            <span class="pm-field">
              <ProjectReach v-model="form.reach" :projects="others" />
              <small v-if="auto.errors.reach" class="form-error pm-field-error" role="alert">{{ t(auto.errors.reach) }}</small>
              <small class="muted">{{ tl('Read: it lists and reads their tasks. Act: it also adds, starts, stops and edits them, and tells their agents. Their guards, merges, approvals, settings and autopilot stay with their own coordinator and you. Each action is in their log, and their coordinator is told.') }}</small>
            </span>
          </template>

          <span class="field-label">{{ tl('Base branch') }}<SavedMark :s="auto.state.base" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="base" :workspace="wsName" @followed="followed" />
            <USelectMenu
            v-model="base" :items="branchItems" value-key="value" size="lg" class="pm-base-pick mono" create-item
            :search-input="{ placeholder: tl('Branch name', 'Nom de branche'), autocomplete: 'off', ui: { base: 'pointer-coarse:text-[16px]' } }"
            :aria-label="tl('Base branch')" data-testid="pm-base" @update:open="o => o && loadBranches()" @create="v => (form.base = v.trim())"
          />
          <small v-if="auto.errors.base" class="form-error pm-field-error" role="alert">{{ t(auto.errors.base) }}</small>
          <small class="muted">{{ tl('New tasks start their worktree from it, and a step that names no branch opens its PR to it or merges into it. Unset: the branch the workflow opens its PRs to, else the repo\'s default branch. Running tasks keep theirs.') }}</small>
          <small v-if="fromWorkflow" class="muted" data-testid="pm-base-workflow">{{ tl(`No working branch set: using ${fromWorkflow} from the workflow.`) }}</small>
          <small v-if="baseMissing" class="pm-on-state-warn" data-testid="pm-base-missing">{{ tl(baseMissing) }}</small>
          </span>

          <span class="field-label">{{ tl('Branch name') }}<SavedMark :s="auto.state.branchName" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="branchName" :workspace="wsName" @followed="followed" />
            <UInput v-model="form.branchName" size="lg" class="pm-base-pick mono" placeholder="task/{id}" :aria-label="tl('Branch name')" maxlength="80" data-testid="pm-branch-name" />
            <small v-if="auto.errors.branchName" class="form-error pm-field-error" role="alert">{{ t(auto.errors.branchName) }}</small>
            <small class="muted">{{ tl('Each new task\'s branch. Fields: {id}, {tag} (the card\'s ticket key, else the task id), {type} (bugfix or feature), {slug} (from the title). Example: {type}/{tag}-{slug}.') }}</small>
          </span>

          <span class="field-label">{{ tl('Commit message') }}<SavedMark :s="auto.state.commitMessage" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="commitMessage" :workspace="wsName" @followed="followed" />
            <UInput v-model="form.commitMessage" size="lg" class="pm-base-pick mono" placeholder="{tag}: {title}" :aria-label="tl('Commit message')" maxlength="120" data-testid="pm-commit-message" />
            <small v-if="auto.errors.commitMessage" class="form-error pm-field-error" role="alert">{{ t(auto.errors.commitMessage) }}</small>
            <small class="muted">{{ tl('The commit title of a squash merge, and of the merge commit a land makes. Fields: those of the branch name, and {title}. A field left empty drops with its separator. Unset: the usual message.') }}</small>
          </span>

          <span class="field-label">{{ tl('On state change') }}<SavedMark :s="auto.state.onState" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="onStateChange" :workspace="wsName" @followed="followed" />
            <UInput v-model="form.onStateCommand" size="lg" class="pm-base-pick mono" placeholder="./scripts/tracker-sync.sh" :aria-label="tl('On state change')" maxlength="2000" data-testid="pm-on-state" />
            <span class="pm-on-state-events">
              <UCheckbox v-for="e in STATE_EVENTS" :key="e" :model-value="form.onStateEvents.includes(e)" :label="tl(STATE_LABEL[e])" size="lg" :data-testid="`pm-on-state-${e}`" @update:model-value="v => toggleEvent(e, v === true)" />
            </span>
            <small v-if="auto.errors.onState" class="form-error pm-field-error" role="alert">{{ t(auto.errors.onState) }}</small>
            <small class="muted">{{ tl('A shell command run in the project\'s clone on its home machine when a task changes state, once per task and event, 30 s at most; its result goes to the task\'s log. The facts come as WHERDR_TASK_ID, WHERDR_TASK_TAG, WHERDR_TASK_TITLE, WHERDR_TASK_STATE, WHERDR_TASK_PR and WHERDR_PROJECT.') }}</small>
            <small class="pm-on-state-warn">{{ tl('It runs with your rights on that machine.') }}</small>
          </span>

          <span class="field-label">{{ tl('Archive done tasks after') }}<SavedMark :s="auto.state.archiveAfter" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="archiveAfter" :workspace="wsName" @followed="followed" />
            <USelect v-model="form.archiveAfter" :items="archiveItems" size="lg" class="pm-base-pick" :aria-label="tl('Archive done tasks after')" data-testid="pm-archive-after" />
            <small v-if="auto.errors.archiveAfter" class="form-error pm-field-error" role="alert">{{ t(auto.errors.archiveAfter) }}</small>
            <small class="muted">{{ tl('A done task leaves the Done column after this time; the column\'s footer lists archived tasks. Its branch, PR and log stay.') }}</small>
          </span>

          <template v-if="wsKind">
            <span class="field-label" data-ui-target="project.instructions">{{ tl('Workspace instructions files') }}<SavedMark :s="auto.state.instrMode" /></span>
            <span class="pm-field">
              <ProjectFollow :project="last" field="instructionsFiles" :workspace="wsName" @followed="followed" />
              <USelect v-model="instr.instrMode" :items="instrItems" size="lg" class="pm-base-pick" :aria-label="tl('Workspace instructions files')" data-testid="pm-ws-files-mode" />
              <UTextarea v-if="instr.instrMode === 'files'" v-model="instr.instrFiles" :rows="2" autoresize size="lg" class="w-full mono" placeholder="AGENTS.md" :aria-label="tl('Paths under the workspace\'s root, one per line')" maxlength="2000" data-testid="pm-ws-files" />
              <small v-if="auto.errors.instrFiles" class="form-error pm-field-error" role="alert">{{ t(auto.errors.instrFiles) }}</small>
              <small class="muted">{{ wsKind === 'workspace' ? tl('Files at the workspace\'s root that the worker and the reviewer of every member\'s task get after the workflow\'s instructions, read again at each step.') : tl('Files at the workspace\'s root that this project\'s workers and reviewers get after the workflow\'s instructions.') }}</small>
            </span>
            <template v-if="wsKind === 'workspace'">
              <span class="field-label">{{ tl('Workspace skills') }}<SavedMark :s="auto.state.rootSkills" /></span>
              <span class="pm-field">
                <USelect v-model="instr.rootSkills" :items="skillItems" size="lg" class="pm-base-pick" :aria-label="tl('Workspace skills')" data-testid="pm-ws-skills" />
                <small class="muted">{{ tl('Skills of the root that the worker and the reviewer of every member\'s task find, linked in its worktree and never committed; a member\'s own skill of the same name wins.') }}</small>
              </span>
            </template>
          </template>

          <span class="field-label">{{ tl('Delete the task\'s branch after its merge') }}<SavedMark :s="auto.state.deleteBranch" /></span>
          <span class="pm-field">
            <ProjectFollow :project="last" field="deleteBranch" :workspace="wsName" @followed="followed" />
            <USwitch v-model="form.deleteBranch" size="lg" :aria-label="tl('Delete the task\'s branch after its merge')" data-testid="pm-delete-branch" />
            <small v-if="auto.errors.deleteBranch" class="form-error pm-field-error" role="alert">{{ t(auto.errors.deleteBranch) }}</small>
            <small class="muted">{{ tl('Once its PR is merged, wherdr deletes the task\'s remote branch, unless a commit came after the merge, another open PR uses it, or it is protected or a base. Off: branches stay.') }}</small>
          </span>

          <template v-if="workflow">
            <ProjectFollow :project="last" field="prefs" class="pm-later" :workspace="wsName" :own-workflow="!inherited" @followed="followed" />
            <div class="pm-cols">
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Worker') }}<SavedMark :s="auto.state.worker" /></span>
                <USelect v-model="agent" :items="agentItems" size="lg" class="w-full" :aria-label="tl('Worker agent')" data-testid="pm-agent" />
                <UInput v-model="form.model" size="lg" class="w-full mono" :placeholder="tl('default model')" :aria-label="tl('Worker model')" maxlength="80" />
                <small v-if="auto.errors.worker" class="form-error pm-field-error" role="alert">{{ t(auto.errors.worker) }}</small>
              </span>
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Reviewer') }}<SavedMark :s="auto.state.reviewer" /></span>
                <USelect v-model="reviewAgent" :items="agentItems" size="lg" class="w-full" :aria-label="tl('Reviewer agent')" />
                <UInput v-model="form.reviewModel" size="lg" class="w-full mono" :placeholder="tl('default model')" :aria-label="tl('Reviewer model')" maxlength="80" />
                <small v-if="auto.errors.reviewer" class="form-error pm-field-error" role="alert">{{ t(auto.errors.reviewer) }}</small>
              </span>
              <span class="pm-col pm-agent">
                <span class="field-label">{{ tl('Fallback') }}<SavedMark :s="auto.state.fallback" /></span>
                <USelect v-model="fallbackAgent" :items="fallbackItems" size="lg" class="w-full" :aria-label="tl('Reviewer fallback agent')" data-testid="pm-fallback-agent" />
                <UInput v-model="form.reviewFallbackModel" size="lg" class="w-full mono" :placeholder="tl('model, or same')" :aria-label="tl('Reviewer fallback model')" maxlength="80" />
                <small v-if="auto.errors.fallback" class="form-error pm-field-error" role="alert">{{ t(auto.errors.fallback) }}</small>
              </span>
            </div>
          </template>
          <small v-if="workflow" class="muted">{{ tl('Fallback: the reviewer started instead while the reviewer\'s account is out of quota. None: reviews wait for it.') }}</small>
          <template v-if="workflow">
            <span class="field-label pm-later">{{ tl('Worktree setup') }}</span>
            <ProjectFollow :project="last" field="worktree" :workspace="wsName" :own-workflow="!inherited" @followed="followed" />
            <!-- Help first, then a two-column grid (one column on the phone) with
                 no hole: Share no folder takes a full row, Time limit the left cell. -->
            <span class="pm-help muted" data-testid="pm-setup-help">
              <small>{{ tl('Prepared before a task\'s first worker.') }}</small>
              <small>{{ tl('Files to copy: ignored files taken from the project\'s clone (a tracked or missing one is skipped).') }}</small>
              <small>{{ tl('Folders to share: taken from the clone while the lockfile is the same in both; otherwise the setup command runs, at most 10m. Empty: node_modules.') }}</small>
            </span>
            <div class="pm-setup">
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmCopy">{{ tl('Files to copy') }}<SavedMark :s="auto.state.copy" /></label>
                <UTextarea id="pmCopy" v-model="setup.copy" :rows="2" autoresize size="lg" class="w-full mono" placeholder=".env" maxlength="4000" data-testid="pm-setup-copy" />
                <small v-if="auto.errors.copy" class="form-error pm-field-error" role="alert">{{ t(auto.errors.copy) }}</small>
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmShare">{{ tl('Folders to share') }}<SavedMark :s="auto.state.share" /></label>
                <UTextarea id="pmShare" v-model="setup.share" :rows="2" autoresize size="lg" class="w-full mono" placeholder="node_modules" maxlength="4000" :disabled="setup.noShare" data-testid="pm-setup-share" />
                <small v-if="auto.errors.share" class="form-error pm-field-error" role="alert">{{ t(auto.errors.share) }}</small>
              </span>
              <label class="toggle-row pm-wide">
                <span><b>{{ tl('Share no folder') }}</b><small>{{ tl('The setup command always runs') }}</small></span>
                <USwitch v-model="setup.noShare" size="xl" data-testid="pm-setup-no-share" />
              </label>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmCommand">{{ tl('Setup command') }}<SavedMark :s="auto.state.command" /></label>
                <UInput id="pmCommand" v-model="setup.command" size="lg" class="w-full mono" placeholder="npm ci --prefer-offline" maxlength="500" data-testid="pm-setup-command" />
                <small v-if="auto.errors.command" class="form-error pm-field-error" role="alert">{{ t(auto.errors.command) }}</small>
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmLock">{{ tl('Lockfile') }}<SavedMark :s="auto.state.lockfile" /></label>
                <UInput id="pmLock" v-model="setup.lockfile" size="lg" class="w-full mono" placeholder="package-lock.json" maxlength="200" data-testid="pm-setup-lockfile" />
                <small v-if="auto.errors.lockfile" class="form-error pm-field-error" role="alert">{{ t(auto.errors.lockfile) }}</small>
              </span>
              <span class="pm-col pm-agent">
                <label class="field-label" for="pmTimeout">{{ tl('Time limit') }}<SavedMark :s="auto.state.timeout" /></label>
                <UInput id="pmTimeout" v-model="setup.timeout" size="lg" class="w-full mono" :placeholder="SETUP_TIMEOUT" maxlength="4" data-testid="pm-setup-timeout" />
                <small v-if="auto.errors.timeout" class="form-error pm-field-error" role="alert">{{ t(auto.errors.timeout) }}</small>
              </span>
            </div>
          </template>
          <p v-else-if="loaded" class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one.') }}</p>

          <span class="field-label pm-later">{{ tl('Repository') }}</span>
          <span class="pm-vis">
            <USelect
              :model-value="p.visibility?.value ?? 'unknown'" :items="visibilityItems(p.visibility)" size="lg" :disabled="busy !== ''" :aria-label="tl(`Repository of ${p.name}`, `Dépôt de ${p.name}`)"
              data-testid="pm-visibility" @update:model-value="v => setVisibility({ value: String(v) })"
            />
            <small class="mono-label">{{ visibilityNote(p.visibility) }}</small>
            <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-refresh-cw" :loading="busy === 'vis'" :disabled="busy !== ''" data-testid="pm-visibility-check" @click="setVisibility({ check: true })">{{ tl('Check again', 'Revérifier') }}</UButton>
          </span>
          <template v-if="p.from">
            <span class="field-label">{{ tl('Template') }}</span>
            <small class="muted" data-testid="pm-from">{{ tl(`Based on: ${p.from.template} v${p.from.version}. Information only: changes to the template do not reach the project. To change the workflow, ask the project\'s coordinator.`) }}</small>
          </template>
        </form>
        <template v-if="tab === 'general'">
          <span class="field-label pm-later">{{ tl('Machines') }}</span>
          <ProjectFollow :project="last" field="machines" :workspace="wsName" @followed="followed" />
          <ProjectMachines :project="p" :ready="ready" :workspace="wsName" @changed="emit('changed')" />
          <span class="field-label pm-later">{{ tl('Shown in') }}</span>
          <ProjectShownIn :project="p" />
        </template>
        <template v-if="tab === 'workflow'">
          <PartHead part="workflow" :project="p.key" class="pm-part" />
        </template>
        <div v-if="tab === 'workflow' && coordinator?.proposal" class="settings-card pm-proposal" data-testid="workflow-proposal">
          <span class="pm-proposal-head">
            <span class="card-state blocked" aria-hidden="true"><i /></span>
            <span class="pm-proposal-text">{{ tl('Change proposed by the coordinator') }}</span>
          </span>
          <span class="pm-proposal-actions">
            <UButton color="neutral" variant="ghost" size="lg" data-testid="workflow-proposal-review" @click="reviewOpen = true">{{ tl('See all changes') }}</UButton>
            <span class="pm-proposal-gap" />
            <UButton color="neutral" variant="outline" size="lg" :loading="answerBusy === 'refuse'" :disabled="answerBusy !== ''" data-testid="workflow-proposal-refuse" @click="answer(false)">{{ tl('Refuse') }}</UButton>
            <UButton color="primary" size="lg" :loading="answerBusy === 'accept'" :disabled="answerBusy !== ''" data-testid="workflow-proposal-accept" @click="answer(true)">{{ tl('Accept') }}</UButton>
          </span>
          <p v-if="answerError" class="form-error" role="alert">{{ t(answerError) }}</p>
        </div>
        <p v-if="tab === 'guards' && loaded && inherited" class="muted settings-hint" data-testid="pm-inherited">{{ tl(`Runs the workflow of workspace ${inherited}, whose guards apply too. A change saved here gives this project its own.`) }}</p>
        <ProjectWorkflow v-if="tab === 'workflow' && loaded" ref="workflowTab" data-ui-target="project.workflow" :project="p" :workflow="workflow" :log="log" :inherited="inherited" :workspace="wsName" @changed="workflowChanged" />
        <template v-else-if="tab === 'guards' && loaded">
          <ProjectGuards v-if="workflow" data-ui-target="project.guards" :project="p" :workflow="workflow" @changed="workflowChanged" />
          <p v-else class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one.') }}</p>
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
/* The global hint pulls itself up under a settings group's heading (-20px):
   under the tab bar, and in the tabs' own content, it flows like the rest. */
.project-panel :deep(.settings-hint) { margin: 0 2px 12px; }
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
.pm-follow-intro { margin: 0 2px 14px; }
/* A field's save error, right under it. */
.pm-field-error { display: block; margin: 4px 2px 0; font-size: 13px; }
.pm-on-state-events { display: flex; flex-wrap: wrap; gap: 0 16px; }
.pm-on-state-events > * { min-height: 44px; align-items: center; }
.pm-on-state-warn { color: var(--ui-warning); }
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
.pm-proposal { display: grid; gap: 8px; width: 100%; margin-bottom: 12px; padding: 12px 16px; }
.pm-proposal-head { display: flex; align-items: center; gap: 10px; color: var(--blocked); }
.pm-proposal-text { flex: 1; min-width: 0; color: var(--text); }
.pm-proposal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pm-proposal-gap { flex: 1 1 0; }
@media (max-width: 599px) { .pm-proposal-actions > :not(.pm-proposal-gap) { flex: 1 1 auto; } .pm-proposal-gap { display: none; } }
.pm-vis { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
</style>
