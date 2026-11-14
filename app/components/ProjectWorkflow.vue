<script setup lang="ts">
// The project sheet's Workflow tab, read only: a task type picked, its
// chart (WorkflowChart), the JSON to read and copy, and the way to change
// it: ask the project's coordinator, whose proposal the user accepts or
// refuses (ProposalReview). The ⋯ menu (menu(), shown by the sheet) holds the
// change log and Save as template. A project without a workflow starts from a
// template: a choice, not an edit.
import { EXAMPLES } from '#shared/pm/examples'
import type { LogEntry } from '#shared/pm/templateText'
import type { Template } from '#shared/pm/workflow'
import type { Project, TemplateInfo } from '#shared/pm/project'

const props = defineProps<{ project: Project, workflow: Template | null, log: LogEntry[], templates: TemplateInfo[] }>()
// changed: the workflow was started; templates: only the library changed.
const emit = defineEmits<{ changed: [], templates: [] }>()

const type = ref('')
const busy = ref('')
const error = ref('')
// The window open over the sheet.
const dialog = ref<'' | 'json' | 'log' | 'save-as' | 'start'>('')
const dialogOpen = (d: typeof dialog.value) => computed({ get: () => dialog.value === d, set: (o: boolean) => { if (!o && dialog.value === d) dialog.value = '' } })
const jsonOpen = dialogOpen('json'), logOpen = dialogOpen('log'), saveAsOpen = dialogOpen('save-as'), startOpen = dialogOpen('start')

const types = computed(() => Object.keys(props.workflow?.taskTypes ?? {}))
watch(types, (list) => { if (!list.includes(type.value)) type.value = list[0] ?? '' }, { immediate: true })
const json = computed(() => (props.workflow ? JSON.stringify(props.workflow, null, 2) : ''))

// Changing it: the project's coordinator, with a first message to complete.
const coordinator = computed(() => projectCoordinators.value.find(c => c.project === props.project.key))
const ask = () => run('ask', () => openCoordinator(coordinator.value!, tl(`I would like to change the workflow of ${props.project.key}${type.value ? ` (task type ${type.value})` : ''}: `)), '')

async function run(what: string, fn: () => Promise<unknown>, done: 'changed' | 'templates' | '' = 'changed') {
  if (busy.value) return false
  busy.value = what
  error.value = ''
  try {
    await fn()
    if (done === 'changed') emit('changed')
    else if (done === 'templates') emit('templates')
    return true
  }
  catch (e) { error.value = (e as Error).message; return false }
  finally { busy.value = '' }
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

// No workflow yet: pick a library template or an example to start from.
const startPick = ref('')
const startItems = computed(() => [
  ...props.templates.map(tp => ({ label: tp.id, value: tp.id })),
  ...EXAMPLES.filter(e => !props.templates.some(tp => tp.id === e.id)).map(e => ({ label: tl(`${e.id} (example)`), value: `example:${e.id}` })),
])
async function start() {
  const template = startPick.value
  if (await run('start', () => api('/api/pm/project-apply', { key: props.project.key, template }))) dialog.value = ''
}

const menu = (): MenuItem[] => [
  { label: tl('Change log'), icon: 'i-lucide-history', disabled: !props.log.length, run: () => (dialog.value = 'log') },
  { label: tl('Save as template…'), icon: 'i-lucide-copy-plus', disabled: !props.workflow, run: () => { asId.value = freeId(props.project.key.toLowerCase()); dialog.value = 'save-as' } },
]
defineExpose({ menu })
</script>

<template>
  <div class="tpl-editor" data-testid="project-workflow">
    <template v-if="workflow">
      <div class="wf-bar">
        <div v-if="types.length > 1" class="segmented wf-types" role="tablist" :aria-label="tl('Task type')" :style="{ '--segment-count': types.length }">
          <button v-for="k in types" :key="k" type="button" role="tab" :class="{ on: type === k }" :aria-selected="type === k" :data-type="k" @click="type = k">{{ k }}</button>
        </div>
        <span v-else class="mono-label">{{ tl(`Task type ${type}`) }}</span>
        <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-braces" data-testid="wf-json-open" @click="dialog = 'json'">{{ tl('JSON') }}</UButton>
      </div>
      <WorkflowChart v-if="type" :workflow="workflow" :type="type" :base="project.base" :coordinator="coordinator && coordinatorAgent(coordinator)?.program" />
      <div class="settings-card wf-ask">
        <p>{{ tl('To create or change a workflow, ask the project’s coordinator (or Alfred). You accept or refuse its proposal here.') }}</p>
        <UButton size="lg" color="primary" icon="i-lucide-message-square" :loading="busy === 'ask'" :disabled="!coordinator || busy !== ''" data-testid="wf-ask" @click="ask">{{ tl('Ask the coordinator') }}</UButton>
      </div>
    </template>
    <template v-else>
      <p class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one, or start from a template.') }}</p>
      <UButton size="xl" color="primary" class="hw-cta" icon="i-lucide-layout-template" data-testid="wf-start-open" @click="startPick = ''; dialog = 'start'">{{ tl('Start from a template') }}</UButton>
    </template>
    <p v-if="error && !dialog" class="form-error" role="alert">{{ t(error) }}</p>

    <AppSheet v-model:open="jsonOpen" :title="tl('Workflow JSON')" tall wide top hide-close>
      <div class="tpl-editor">
        <pre class="wf-json" tabindex="0" :aria-label="tl('Workflow JSON')" data-testid="wf-json">{{ json }}</pre>
        <UButton size="xl" color="neutral" variant="outline" class="hw-cta" icon="i-lucide-copy" data-testid="wf-json-copy" @click="copyCode(json)">{{ tl('Copy') }}</UButton>
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

    <AppSheet v-model:open="startOpen" :title="tl('Start from a template')" tall wide top hide-close>
      <div class="tpl-editor">
        <div class="tpl-picks" role="radiogroup" :aria-label="tl('Template')" data-testid="wf-start-pick">
          <UButton v-for="it in startItems" :key="it.value" role="radio" :aria-checked="startPick === it.value" size="lg" color="neutral" :variant="startPick === it.value ? 'solid' : 'outline'" :data-pick="it.value" @click="startPick = it.value">{{ it.label }}</UButton>
        </div>
        <small class="muted">{{ tl('A copy becomes the project\'s workflow. To change it later, ask the coordinator.') }}</small>
        <UButton size="xl" color="primary" class="hw-cta" :loading="busy === 'start'" :disabled="!startPick || busy !== ''" data-testid="wf-start-apply" @click="start">{{ tl('Start from it') }}</UButton>
        <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      </div>
    </AppSheet>
  </div>
</template>

<style scoped>
.tpl-editor { display: grid; gap: 14px; min-width: 0; }
.wf-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.wf-types { flex: 1 1 240px; max-width: 480px; }
.wf-ask { display: grid; gap: 10px; padding: 14px 16px; }
.wf-ask p { margin: 0; font-size: 14px; line-height: 1.45; color: var(--text-2); }
.wf-ask :deep(button) { justify-self: start; }
.wf-json { margin: 0; max-height: 60vh; overflow: auto; padding: 10px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tpl-log { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; font-size: 14px; }
.tpl-picks { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
