<script setup lang="ts">
// The project sheet's Workflow tab, read only: a task type picked, its
// chart (WorkflowChart), the JSON to read and copy, and the way to change
// it: ask the project's coordinator, whose proposal the user accepts or
// refuses (ProposalReview). The ⋯ menu (menu(), shown by the sheet) holds the
// change log. A project without a workflow gets its first one from its
// coordinator too (its first reply proposes one); Alfred can copy another
// project's.
import type { LogEntry } from '#shared/pm/templateText'
import type { Template } from '#shared/pm/workflow'
import type { Project } from '#shared/pm/project'

// inherited: the workspace whose workflow a member runs ('' : its own, or not a member); workspace: its workspace's name.
const props = defineProps<{ project: Project, workflow: Template | null, log: LogEntry[], inherited?: string, workspace?: string }>()
const emit = defineEmits<{ changed: [] }>()

const type = ref('')
const busy = ref('')
const error = ref('')
// The window open over the sheet.
const dialog = ref<'' | 'json' | 'log'>('')
const dialogOpen = (d: typeof dialog.value) => computed({ get: () => dialog.value === d, set: (o: boolean) => { if (!o && dialog.value === d) dialog.value = '' } })
const jsonOpen = dialogOpen('json'), logOpen = dialogOpen('log')

const types = computed(() => Object.keys(props.workflow?.taskTypes ?? {}))
watch(types, (list) => { if (!list.includes(type.value)) type.value = list[0] ?? '' }, { immediate: true })
const json = computed(() => (props.workflow ? JSON.stringify(props.workflow, null, 2) : ''))

// Changing it: the project's coordinator, with a first message to complete.
const coordinator = computed(() => projectCoordinators.value.find(c => c.project === props.project.key))
const ask = () => run('ask', () => openCoordinator(coordinator.value!, props.workflow ? tl(`I would like to change the workflow of ${props.project.key}${type.value ? ` (task type ${type.value})` : ''}: `) : tl(`Please propose a workflow for ${props.project.key}: `)))

// A member with its own workflow follows its workspace's again (its own is removed).
const own = computed(() => !!props.project.workspace && !!props.workflow && !props.inherited)
const reset = async () => {
  const ws = props.project.workspace
  if (!(await askConfirm(tl(`Follow workspace ${ws}'s workflow again? This project's own workflow is removed: its later changes reach it again.`), tl('Follow the workspace\'s')))) return
  await run('reset', () => api('/api/pm/project-workflow', { key: props.project.key, reset: true }))
  if (!error.value) emit('changed')
}

async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}

const menu = (): MenuItem[] => [
  { label: tl('Change log'), icon: 'i-lucide-history', disabled: !props.log.length, run: () => (dialog.value = 'log') },
]
defineExpose({ menu })
</script>

<template>
  <div class="tpl-editor" data-testid="project-workflow">
    <!-- A member: whether it runs its workspace's workflow, as its General tab's settings say it (ProjectFollow). -->
    <p v-if="own" class="wf-follow own" data-testid="wf-own">
      <span>{{ tl('Own workflow') }} ·</span>
      <button type="button" class="wf-follow-use" :disabled="busy !== ''" data-testid="wf-reset" @click="reset">{{ tl(`Follow ${workspace || project.workspace}'s`) }}</button>
    </p>
    <p v-else-if="inherited" class="wf-follow" data-testid="wf-follows">
      <span>{{ tl(`Follows ${workspace || inherited}'s workflow`) }}</span>
      <span class="muted">{{ tl('Its guards apply too. A change saved here gives this project its own.') }}</span>
    </p>
    <template v-if="workflow">
      <div class="wf-bar">
        <div v-if="types.length > 1" class="segmented wf-types" role="tablist" :aria-label="tl('Task type')" :style="{ '--segment-count': types.length }">
          <button v-for="k in types" :key="k" type="button" role="tab" :class="{ on: type === k }" :aria-selected="type === k" :data-type="k" @click="type = k">{{ k }}</button>
        </div>
        <span v-else class="mono-label">{{ tl(`Task type ${type}`) }}</span>
        <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-braces" data-testid="wf-json-open" @click="dialog = 'json'">{{ tl('JSON') }}</UButton>
      </div>
      <WorkflowChart v-if="type" :workflow="workflow" :type="type" :base="project.base" :coordinator="coordinator && coordinatorAgent(coordinator)?.program" />
    </template>
    <p v-else class="muted settings-hint">{{ tl('No workflow chosen yet: tasks follow a minimal one (to do, work, done). Ask the project’s coordinator to propose one.') }}</p>
    <div class="settings-card wf-ask">
      <p>{{ tl('To create or change a workflow, ask the project’s coordinator (or Alfred). You accept or refuse its proposal here.') }}</p>
      <UButton size="lg" color="primary" icon="i-lucide-message-square" :loading="busy === 'ask'" :disabled="!coordinator || busy !== ''" data-testid="wf-ask" @click="ask">{{ tl('Ask the coordinator') }}</UButton>
    </div>
    <p v-if="error && !dialog" class="form-error" role="alert">{{ t(error) }}</p>

    <AppSheet v-model:open="jsonOpen" :title="tl('Workflow JSON')" tall wide top>
      <div class="tpl-editor">
        <pre class="wf-json" tabindex="0" :aria-label="tl('Workflow JSON')" data-testid="wf-json">{{ json }}</pre>
        <UButton size="xl" color="neutral" variant="outline" class="hw-cta" icon="i-lucide-copy" data-testid="wf-json-copy" @click="copyCode(json)">{{ tl('Copy') }}</UButton>
      </div>
    </AppSheet>

    <AppSheet v-model:open="logOpen" :title="tl('Change log', 'Journal des changements')" tall top>
      <ul class="tpl-log" data-testid="tpl-log">
        <li v-for="e in [...log].reverse()" :key="e.version">
          <b class="mono">v{{ e.version }}</b> <span class="muted">{{ new Date(e.at).toLocaleString() }} · {{ e.by }}</span> {{ e.changes.join(', ') || tl('created', 'créé') }}
        </li>
      </ul>
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
.wf-follow { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin: 0; color: var(--muted); font: 12px/1.5 var(--font-mono); overflow-wrap: anywhere; }
.wf-follow.own { color: var(--text-2); }
.wf-follow .muted { flex-basis: 100%; font-family: var(--font-sans); font-size: 13px; }
.wf-follow-use { position: relative; padding: 0; border: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.wf-follow-use::after { content: ''; position: absolute; inset: -14px -6px; }
.wf-follow-use:disabled { color: var(--muted); cursor: default; }
.wf-json { margin: 0; max-height: 60vh; overflow: auto; padding: 10px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tpl-log { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; font-size: 14px; }
</style>
