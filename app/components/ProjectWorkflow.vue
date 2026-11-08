<script setup lang="ts">
// The project sheet's Workflow tab: the project's own workflow (its steps per
// task type) in a form, the plan of a task type, and Save. The ⋯ menu
// (menu(), shown by the sheet) holds Edit as JSON, Change log, Save as
// template and Start over from a template. The text is the one source: the
// form writes into it, and it is checked as it changes, each problem with its line.
import { EXAMPLES } from '#shared/pm/examples'
import { planSteps } from '#shared/pm/steps'
import { templateDiff } from '#shared/pm/coordinator'
import { parseTemplateText, type LogEntry } from '#shared/pm/templateText'
import { actionField, actionLabel, describeStep, endHint, holderHint } from '#shared/pm/describe'
import { ACTIONS, ENDS, HOLDERS, MERGE_METHODS, SHOT_MODES, startOverFrom, type ActionKind, type ShotMode, type Step, type StepAction, type Template } from '#shared/pm/workflow'
import type { Project, TemplateInfo } from '#shared/pm/project'

const props = defineProps<{ project: Project, workflow: Template | null, log: LogEntry[], templates: TemplateInfo[] }>()
// changed: the workflow was saved or replaced; templates: only the library changed.
const emit = defineEmits<{ changed: [], templates: [] }>()

const text = ref('')
const type = ref('')
const busy = ref('')
const error = ref('')
// The window open over the sheet, from the ⋯ menu.
const dialog = ref<'' | 'json' | 'log' | 'save-as' | 'start'>('')
const dialogOpen = (d: typeof dialog.value) => computed({ get: () => dialog.value === d, set: (o: boolean) => { if (!o && dialog.value === d) dialog.value = '' } })
const jsonOpen = dialogOpen('json'), logOpen = dialogOpen('log'), saveAsOpen = dialogOpen('save-as'), startOpen = dialogOpen('start')

const parsed = computed(() => (text.value ? parseTemplateText(text.value) : null))
// What the form shows, even while the workflow has problems.
const shape = computed(() => {
  const v = parsed.value?.value as Template | undefined
  return v && typeof v === 'object' && v.taskTypes && typeof v.taskTypes === 'object' ? v : null
})
const types = computed(() => Object.keys(shape.value?.taskTypes ?? {}))
watch(types, (list) => { if (!list.includes(type.value)) type.value = list[0] ?? '' }, { immediate: true })
const steps = computed(() => {
  const s = shape.value?.taskTypes[type.value]?.steps
  return Array.isArray(s) ? s : null
})
const plan = computed(() => (parsed.value?.template && type.value ? planSteps(parsed.value.template, { type: type.value }) : []))

const asText = (t: unknown) => (t ? JSON.stringify(t, null, 2) + '\n' : '')
const show = (t: unknown) => { text.value = asText(t) }
// Edits not saved yet: Save as template copies the stored workflow, so it waits for a save.
const dirty = computed(() => text.value !== asText(props.workflow))
watch(() => props.workflow, show, { immediate: true })

// A form change: edit a copy of the steps and write it back as text.
function edit(fn: (list: (Step | string)[]) => void) {
  const t = structuredClone(toRaw(shape.value!))
  fn(t.taskTypes[type.value]!.steps)
  show(t)
}
const set = (i: number, key: keyof Step, v: string) => edit((list) => {
  const s = list[i] as unknown as Record<string, unknown>
  if (v || key === 'id') s[key] = v
  else delete s[key]
  // Only a step that ends with action or user runs one.
  if (key === 'ends' && v !== 'action' && v !== 'user') delete s.action
})
// The engine action: a new kind keeps the branch already typed.
const setAction = (i: number, kind: string) => edit((list) => {
  const s = list[i] as Step
  if (!kind) return void delete s.action
  const old = s.action, branch = old?.target || old?.base
  const a: StepAction = { kind: kind as ActionKind }
  const f = actionField(a.kind)
  if (f && branch) a[f] = branch
  if (a.kind === 'github.merge') Object.assign(a, old?.method ? { method: old.method } : {}, old?.checks ? { checks: old.checks } : {})
  s.action = a
})
const setActionField = (i: number, key: 'target' | 'base' | 'method' | 'checks', v: string) => edit((list) => {
  const a = (list[i] as Step).action as unknown as Record<string, unknown>
  const value = key === 'checks' ? v.split(',').map(c => c.trim()).filter(Boolean) : v.trim()
  if (value.length) a[key] = value
  else delete a[key]
})
// What happens at step i, in one sentence: the plan's step when the workflow
// is valid (it knows the guards), else the step as written.
const sayStep = (s: Step | string, i: number) => {
  const step = plan.value[i] ?? (typeof s === 'string' ? shape.value?.steps?.[s] : s)
  if (!step || typeof step !== 'object') return ''
  return describeStep(step, tl, { first: i === 0, last: i === steps.value!.length - 1 })
}
// Screenshots as evidence: none, the result only, or before and after.
const shotsOf = (s: Step) => (s.evidence?.includes('screenshots') ? s.screenshots ?? 'after' : '')
const setShots = (i: number, v: string) => edit((list) => {
  const s = list[i] as Step
  const rest = (s.evidence ?? []).filter(e => e !== 'screenshots')
  const evidence = v ? [...rest, 'screenshots' as const] : rest
  if (evidence.length) s.evidence = evidence
  else delete s.evidence
  if (v === 'before-after') s.screenshots = v
  else delete s.screenshots
})
const SHOT_LABEL: Record<ShotMode, string> = { 'after': 'Screenshots: after', 'before-after': 'Screenshots: before and after' }
const move = (i: number, by: number) => edit(list => list.splice(i + by, 0, ...list.splice(i, 1)))
const field = (e: Event) => (e.target as HTMLInputElement).value
// The selects' choices ('' = none, see utils/selectNone.ts).
const typeItems = computed(() => types.value.map(n => ({ label: n, value: n })))
const holderItems = computed(() => HOLDERS.map(h => ({ label: `${h} · ${holderHint(h, tl)}`, value: h })))
const endItems = computed(() => [{ label: `${tl('no end', 'sans fin')} · ${endHint('', tl)}`, value: NONE }, ...ENDS.map(e => ({ label: `${e} · ${endHint(e, tl)}`, value: e }))])
const actionItems = (s: Step) => [
  { label: s.ends === 'user' ? tl('No action after it', 'Aucune action ensuite') : tl('Choose an action…', 'Choisir une action…'), value: NONE },
  ...ACTIONS.map(k => ({ label: actionLabel({ ...s.action, kind: k }, tl), value: k })),
]
const methodItems = computed(() => [{ label: tl('Method: the repo’s default', 'Méthode : celle du dépôt'), value: NONE }, ...MERGE_METHODS.map(m => ({ label: m, value: m }))])
const shotItems = computed(() => [{ label: tl('No screenshots', 'Sans captures'), value: NONE }, ...SHOT_MODES.map(m => ({ label: t(SHOT_LABEL[m]), value: m }))])
const agent = (s: Step) => !!s.holder && s.holder !== 'none'

async function run(what: string, fn: () => Promise<unknown>, done: 'changed' | 'templates' = 'changed') {
  if (busy.value) return false
  busy.value = what
  error.value = ''
  try {
    await fn()
    if (done === 'changed') emit('changed')
    else emit('templates')
    return true
  }
  catch (e) { error.value = (e as Error).message; return false }
  finally { busy.value = '' }
}
// Guards are refused here: they have their own tab.
async function save() {
  if (!parsed.value?.template) return
  const workflow = parsed.value.template
  if (await run('save', () => api('/api/pm/project-workflow', { key: props.project.key, workflow }))) {
    toast(tl('Workflow saved'))
    dialog.value = ''
  }
}

// Save as template: a free id in the library, the project is untouched.
const freeId = (id: string) => {
  const taken = new Set(props.templates.map(tp => tp.id))
  let out = id
  for (let n = 1; taken.has(out); n++) out = n === 1 ? `${id}-copy` : `${id}-copy-${n}`
  return out
}
const asId = ref('')
async function saveAs() {
  const id = asId.value.trim()
  if (await run('save-as', () => api('/api/pm/template-from-project', { key: props.project.key, id }), 'templates')) {
    toast(tl(`Saved as template ${id}`))
    dialog.value = ''
  }
}

// Start over: pick a library template or an example, read what changes, confirm.
const startPick = ref('')
const startNext = ref<Template | null>(null)
const startItems = computed(() => [
  ...props.templates.map(tp => ({ label: tp.id, value: tp.id })),
  ...EXAMPLES.filter(e => !props.templates.some(tp => tp.id === e.id)).map(e => ({ label: tl(`${e.id} (example)`), value: `example:${e.id}` })),
])
async function pickStart(v: string) {
  startPick.value = v
  startNext.value = null
  error.value = ''
  try {
    const ex = EXAMPLES.find(e => `example:${e.id}` === v)
    const source = ex ? structuredClone(ex) as Template : (await api<{ template: Template }>(`/api/pm/template?id=${encodeURIComponent(v)}`)).template
    startNext.value = { ...startOverFrom(source, props.workflow), id: props.project.key.toLowerCase() }
  }
  catch (e) { error.value = (e as Error).message }
}
const startDiff = computed(() => (startNext.value ? templateDiff(props.workflow, startNext.value) : '').split('\n').filter(Boolean)
  .map(l => ({ l, k: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' })))
async function startOver() {
  const template = startPick.value
  if (await run('start', () => api('/api/pm/project-apply', { key: props.project.key, template }))) dialog.value = ''
}
const openStart = () => { startPick.value = ''; startNext.value = null; dialog.value = 'start' }

const menu = (): MenuItem[] => [
  { label: tl('Edit as JSON'), icon: 'i-lucide-braces', disabled: !text.value, run: () => (dialog.value = 'json') },
  { label: tl('Change log'), icon: 'i-lucide-history', disabled: !props.log.length, run: () => (dialog.value = 'log') },
  { label: tl('Save as template…'), icon: 'i-lucide-copy-plus', disabled: !props.workflow || dirty.value, ...(dirty.value ? { desc: tl('Save your changes first') } : {}), run: () => { asId.value = freeId(props.project.key.toLowerCase()); dialog.value = 'save-as' } },
  { label: tl('Start over from a template…'), icon: 'i-lucide-rotate-ccw', run: openStart },
]
defineExpose({ menu })
</script>

<template>
  <div class="tpl-editor" data-testid="project-workflow">
    <template v-if="text">
      <USelect v-if="types.length" v-model="type" :items="typeItems" size="lg" class="tpl-type" :aria-label="tl('Task type', 'Type de tâche')" data-testid="tpl-type" />

      <div class="settings-card tpl-steps">
        <p v-if="!steps" class="muted settings-hint">{{ tl('Fix the JSON to edit the steps here.', 'Corrige le JSON pour modifier les étapes ici.') }}</p>
        <div v-for="(s, i) in steps || []" :key="i" class="tpl-step" data-testid="tpl-step">
          <span v-if="typeof s === 'string'" class="mono-label">{{ tl(`Shared step ${s}`, `Étape partagée ${s}`) }}</span>
          <template v-else>
            <UInput size="xl" :model-value="s.id" class="mono" :aria-label="tl('Step id', 'Id de l’étape')" @update:model-value="v => set(i, 'id', String(v))" />
            <UInput size="xl" :model-value="s.column ?? ''" :placeholder="tl('Column', 'Colonne')" :aria-label="tl('Column', 'Colonne')" @update:model-value="v => set(i, 'column', String(v))" />
            <USelect :model-value="s.holder ?? 'none'" :items="holderItems" size="lg" class="tpl-pair" :aria-label="tl('Held by', 'Tenue par')" data-testid="tpl-holder" @update:model-value="v => set(i, 'holder', String(v))" />
            <USelect :model-value="orNone(s.ends)" :items="endItems" size="lg" class="tpl-pair" :aria-label="tl('Ends with', 'Finit par')" data-testid="tpl-ends" @update:model-value="v => set(i, 'ends', fromNone(v))" />
            <template v-if="s.ends === 'action' || s.ends === 'user'">
              <USelect :model-value="orNone(s.action?.kind)" :items="actionItems(s)" size="lg" class="tpl-pair" :aria-label="tl('Action', 'Action')" data-testid="tpl-action" @update:model-value="v => setAction(i, fromNone(v))" />
              <UInput v-if="s.action && actionField(s.action.kind)" size="xl" class="mono" :model-value="s.action[actionField(s.action.kind)!] ?? ''" :placeholder="actionField(s.action.kind) === 'base' ? tl('PR base branch', 'Branche de base de la PR') : tl('Branch to merge into', 'Branche où fusionner')" :aria-label="actionField(s.action.kind) === 'base' ? tl('PR base branch', 'Branche de base de la PR') : tl('Branch to merge into', 'Branche où fusionner')" data-testid="tpl-action-branch" @update:model-value="v => setActionField(i, actionField(s.action!.kind)!, String(v))" />
              <template v-if="s.action?.kind === 'github.merge'">
                <USelect :model-value="orNone(s.action.method)" :items="methodItems" size="lg" :aria-label="tl('Merge method', 'Méthode de fusion')" data-testid="tpl-action-method" @update:model-value="v => setActionField(i, 'method', fromNone(v))" />
                <UInput size="xl" class="mono" :model-value="(s.action.checks ?? []).join(', ')" :placeholder="tl('Checks that must be green', 'Checks à avoir au vert')" :aria-label="tl('Checks that must be green', 'Checks à avoir au vert')" data-testid="tpl-action-checks" @change="setActionField(i, 'checks', field($event))" />
              </template>
            </template>
            <USelect v-if="agent(s) && s.ends === 'report'" :model-value="orNone(shotsOf(s))" :items="shotItems" size="lg" :aria-label="tl('Screenshots', 'Captures')" data-testid="tpl-shots" @update:model-value="v => setShots(i, fromNone(v))" />
            <UInput size="xl" v-if="s.ends === 'user'" :model-value="s.userLabel ?? ''" class="tpl-wide" :placeholder="tl('Button text', 'Texte du bouton')" :aria-label="tl('Button text', 'Texte du bouton')" @update:model-value="v => set(i, 'userLabel', String(v))" />
            <UTextarea size="xl" v-if="agent(s)" :model-value="s.instructions ?? ''" class="tpl-wide" :rows="2" autoresize :placeholder="tl('Instructions sent to the agent', 'Consigne envoyée à l’agent')" @update:model-value="v => set(i, 'instructions', String(v))" />
          </template>
          <p class="tpl-wide tpl-say muted" data-testid="tpl-say">{{ sayStep(s, i) }}</p>
          <span class="tpl-moves">
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-arrow-up" :disabled="i === 0" :aria-label="tl('Move up', 'Monter')" @click="move(i, -1)" />
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-arrow-down" :disabled="i === steps!.length - 1" :aria-label="tl('Move down', 'Descendre')" @click="move(i, 1)" />
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="tl('Remove the step', 'Retirer l’étape')" @click="edit(list => list.splice(i, 1))" />
          </span>
        </div>
        <UButton v-if="steps" size="sm" color="neutral" variant="outline" icon="i-lucide-plus" class="tpl-add" data-testid="tpl-add" @click="edit(list => list.push({ id: `step-${list.length + 1}` }))">{{ tl('Add a step', 'Ajouter une étape') }}</UButton>
      </div>

      <ul v-if="parsed?.errors.length && !jsonOpen" class="tpl-errors" role="alert" data-testid="tpl-errors">
        <li v-for="(e, n) in parsed.errors" :key="n" class="form-error"><b>{{ tl(`Line ${e.line}`, `Ligne ${e.line}`) }}</b> · {{ e.path ? `${e.path}: ` : '' }}{{ e.message }}</li>
      </ul>

      <template v-if="plan.length">
        <h4 class="mono-label">{{ tl(`Plan of a ${type} task`, `Plan d’une tâche ${type}`) }}</h4>
        <ol class="tpl-plan" data-testid="tpl-plan">
          <li v-for="(p, n) in plan" :key="p.id">
            <b class="mono">{{ p.id }}</b> <span class="muted">{{ p.column || p.id }} · {{ p.holder || 'none' }}{{ p.ends ? ` → ${p.ends}` : '' }}</span>
            <small v-if="p.guarded" class="mono-label"> · {{ tl('merge left to you', 'fusion laissée à toi') }}</small>
            <p class="tpl-say muted">{{ describeStep(p, tl, { first: n === 0, last: n === plan.length - 1 }) }}</p>
          </li>
        </ol>
      </template>

      <UButton size="xl" color="primary" class="hw-cta" icon="i-lucide-save" :loading="busy === 'save'" :disabled="!parsed?.template || busy !== ''" data-testid="tpl-save" @click="save">{{ tl('Save') }}</UButton>
    </template>
    <template v-else>
      <p class="muted settings-hint">{{ tl('No workflow yet: tasks cannot start until the project starts from a template.') }}</p>
      <UButton size="xl" color="primary" class="hw-cta" icon="i-lucide-layout-template" data-testid="wf-start-open" @click="openStart">{{ tl('Start from a template') }}</UButton>
    </template>
    <p v-if="error && !dialog" class="form-error" role="alert">{{ t(error) }}</p>

    <AppSheet v-model:open="jsonOpen" :title="tl('Workflow JSON')" tall wide top hide-close>
      <div class="tpl-editor">
        <UTextarea size="xl" v-model="text" :rows="16" :maxrows="30" autoresize class="w-full mono" :spellcheck="false" wrap="off" :aria-label="tl('Workflow JSON')" data-testid="tpl-json" />
        <ul v-if="parsed?.errors.length" class="tpl-errors" role="alert" data-testid="tpl-json-errors">
          <li v-for="(e, n) in parsed.errors" :key="n" class="form-error"><b>{{ tl(`Line ${e.line}`, `Ligne ${e.line}`) }}</b> · {{ e.path ? `${e.path}: ` : '' }}{{ e.message }}</li>
        </ul>
        <UButton size="xl" color="primary" class="hw-cta" icon="i-lucide-save" :loading="busy === 'save'" :disabled="!parsed?.template || busy !== ''" data-testid="tpl-json-save" @click="save">{{ tl('Save') }}</UButton>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </div>
    </AppSheet>

    <AppSheet v-model:open="logOpen" :title="tl('Change log', 'Journal des changements')" tall top hide-close>
      <ul class="tpl-log" data-testid="tpl-log">
        <li v-for="e in [...log].reverse()" :key="e.version">
          <b class="mono">v{{ e.version }}</b> <span class="muted">{{ new Date(e.at).toLocaleString() }} · {{ e.by }}</span> {{ e.changes.join(', ') || tl('created', 'créé') }}
        </li>
      </ul>
    </AppSheet>

    <AppSheet v-model:open="saveAsOpen" :title="tl('Save as template')" top hide-close>
      <form class="sheet-form" @submit.prevent="saveAs">
        <label class="field-label" for="wfAsId">{{ tl('Template id') }}</label>
        <UInput id="wfAsId" v-model="asId" size="xl" class="w-full mono" maxlength="60" data-testid="wf-save-as-id" />
        <small class="muted">{{ tl('A copy of this workflow joins the library. The project keeps its own workflow.') }}</small>
        <UButton type="submit" size="xl" color="primary" class="hw-cta" :loading="busy === 'save-as'" :disabled="!asId.trim() || busy !== ''" data-testid="wf-save-as">{{ tl('Save as template') }}</UButton>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </form>
    </AppSheet>

    <AppSheet v-model:open="startOpen" :title="tl('Start over from a template')" tall wide top hide-close>
      <div class="tpl-editor">
        <div class="tpl-picks" role="radiogroup" :aria-label="tl('Template')" data-testid="wf-start-pick">
          <UButton v-for="it in startItems" :key="it.value" role="radio" :aria-checked="startPick === it.value" size="lg" color="neutral" :variant="startPick === it.value ? 'solid' : 'outline'" :data-pick="it.value" @click="pickStart(it.value)">{{ it.label }}</UButton>
        </div>
        <small class="muted">{{ workflow ? tl('A copy replaces the steps, instructions and agents. The guards stay.') : tl('A copy becomes the project\'s workflow.') }}</small>
        <template v-if="startNext">
          <pre v-if="startDiff.length" class="tpl-diff" data-testid="wf-start-diff"><span v-for="(d, i) in startDiff" :key="i" :class="d.k">{{ d.l }}
</span></pre>
          <p v-else class="muted settings-hint">{{ tl('Nothing changes.') }}</p>
          <UButton size="xl" color="primary" class="hw-cta" :loading="busy === 'start'" :disabled="busy !== ''" data-testid="wf-start-apply" @click="startOver">{{ workflow ? tl('Replace the workflow') : tl('Start from it') }}</UButton>
        </template>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </div>
    </AppSheet>
  </div>
</template>

<style scoped>
.tpl-editor { display: grid; gap: 12px; }
.tpl-steps { padding: 0; }
.tpl-step { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.tpl-step > * { min-width: 0; }
.tpl-editor :deep(.tpl-type) { width: min(100%, 320px); }
.tpl-wide { grid-column: 1 / -1; }
/* Wide enough to read the option with its hint. */
.tpl-step :deep(.tpl-pair) { grid-column: span 2; }
.tpl-moves { display: flex; gap: 2px; justify-content: flex-end; grid-column: 1 / -1; }
.tpl-add { margin: 12px 16px; }
.tpl-errors, .tpl-plan, .tpl-log { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; }
.tpl-errors .form-error { margin: 0; }
.tpl-plan { list-style: decimal inside; }
.tpl-say { margin: 0; font-size: 14px; }
.tpl-log { font-size: 14px; }
.tpl-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.tpl-diff { margin: 0; max-height: 50vh; overflow: auto; padding: 8px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tpl-diff .add { color: var(--green); }
.tpl-diff .del { color: var(--rose); }
</style>
