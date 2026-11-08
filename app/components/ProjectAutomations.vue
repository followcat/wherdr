<script setup lang="ts">
// A project's automations (Settings › Projects): each one on or off, its
// trigger and last firing, run now; the editor adds or changes one (name,
// prompt, task type, a schedule or an event with a filter) and shows its
// last firings. Each firing adds a task and starts it at once.
import { AUTOMATION_EVENTS, type Automation, type AutomationEvent } from '#shared/pm/automations'

const props = defineProps<{ project: string, name: string }>()
const list = ref<Automation[]>([])
const types = ref<string[]>([])
const editing = ref('') // an automation's id, 'new', or ''
const busy = ref('')
const error = ref('')
const blank = () => ({ name: '', prompt: '', type: '', kind: 'schedule' as 'schedule' | 'event', schedule: '', event: 'merged' as AutomationEvent, filter: '' })
const form = reactive(blank())
const typePick = computed({ get: () => orNone(form.type), set: (v: string) => { form.type = fromNone(v) } })
const typeItems = computed(() => [{ label: tl('The template\'s first', 'Le premier du modèle'), value: NONE }, ...types.value.map(ty => ({ label: ty, value: ty }))])

const EVENT_LABEL: Record<AutomationEvent, [string, string]> = {
  'added': ['Task added', 'Tâche ajoutée'], 'approval': ['Approval', 'Approbation'], 'review-failed': ['Review failed', 'Relecture refusée'],
  'failed': ['Failed', 'Échec'], 'needs-you': ['Needs you', 'Te demande'], 'merged': ['Merged', 'Fusionnée'],
}
const eventItems = computed(() => AUTOMATION_EVENTS.map(e => ({ label: tl(...EVENT_LABEL[e]), value: e })))
const trigger = (a: Automation) => a.schedule ?? `${tl('On', 'Si')} ${tl(...EVENT_LABEL[a.event!]).toLowerCase()}${a.filter ? ` · ${a.filter}` : ''}`
const when = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const BY: Record<string, [string, string]> = { schedule: ['Schedule', 'Horaire'], event: ['Event', 'Événement'], user: ['Run now', 'Lancée'] }

async function load() {
  try { ({ automations: list.value, types: types.value } = await api<{ automations: Automation[], types: string[] }>(`/api/pm/automations?project=${encodeURIComponent(props.project)}`)) }
  catch (e) { error.value = (e as Error).message }
}
onMounted(load)

async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn(); await load() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const body = (a: Automation, more: Partial<Automation> = {}) => ({ project: props.project, automation: { ...a, ...more } })
const setOn = (a: Automation, on: boolean) => run(`on:${a.id}`, () => api('/api/pm/automation', body(a, { on })))
const runNow = (a: Automation) => run(`run:${a.id}`, async () => {
  const r = await api<{ firing: { task?: string, error?: string } }>('/api/pm/automation', { project: props.project, id: a.id, runNow: true })
  toast(r.firing.error ? r.firing.error : tl(`${r.firing.task} started`, `${r.firing.task} lancée`))
})
function edit(a?: Automation) {
  if (editing.value && editing.value === (a?.id ?? 'new')) { editing.value = ''; return }
  Object.assign(form, blank(), a ? { name: a.name, prompt: a.prompt, type: a.type ?? '', kind: a.schedule ? 'schedule' : 'event', schedule: a.schedule ?? '', event: a.event ?? 'merged', filter: a.filter ?? '' } : {})
  editing.value = a?.id ?? 'new'
}
const save = () => run('save', async () => {
  const old = list.value.find(a => a.id === editing.value)
  const trig = form.kind === 'schedule' ? { schedule: form.schedule } : { event: form.event, filter: form.filter }
  await api('/api/pm/automation', { project: props.project, automation: { ...(old ? { id: old.id } : {}), on: old?.on ?? false, name: form.name, prompt: form.prompt, type: form.type, ...trig } })
  editing.value = ''
})
const remove = (a: Automation) => run(`rm:${a.id}`, async () => { await api('/api/pm/automation', { project: props.project, id: a.id, remove: true }); editing.value = '' })
</script>

<template>
  <section class="pa" :data-testid="`automations-${project}`">
    <div class="pa-head">
      <span class="mono-label">{{ name }} · {{ list.length }}</span>
      <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-plus" :aria-expanded="editing === 'new'" data-testid="automation-add" @click="edit()">{{ tl('Add', 'Ajouter') }}</UButton>
    </div>
    <ul v-if="list.length" class="pa-list">
      <li v-for="a in list" :key="a.id" data-testid="automation">
        <div class="pa-row">
          <USwitch :model-value="a.on" color="success" size="lg" :disabled="!!busy" :aria-label="tl(`${a.name} on`, `${a.name} actif`)" data-testid="automation-on" @update:model-value="v => setOn(a, v)" />
          <button type="button" class="pa-id" :aria-expanded="editing === a.id" data-testid="automation-edit" @click="edit(a)">
            <b>{{ a.name }}</b>
            <small class="mono-label" data-testid="automation-trigger">{{ trigger(a) }}</small>
            <small class="muted" data-testid="automation-last">{{ a.firings?.length ? `${tl('Last', 'Dernière')} ${when(a.firings.at(-1)!.at)}${a.firings.at(-1)!.task ? ` · ${a.firings.at(-1)!.task}` : ''}` : tl('Never fired', 'Jamais lancée') }}</small>
          </button>
          <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-play" :loading="busy === `run:${a.id}`" :disabled="!!busy" :aria-label="tl(`Run ${a.name} now`, `Lancer ${a.name}`)" data-testid="automation-run" @click="runNow(a)" />
        </div>
        <ol v-if="editing === a.id && a.firings?.length" class="pa-firings" data-testid="automation-firings">
          <li v-for="f in [...a.firings].reverse()" :key="f.at" :class="{ err: f.error }">
            <span class="mono-label">{{ when(f.at) }} · {{ tl(...BY[f.by]!) }}</span>
            <span>{{ f.task ?? '' }}<template v-if="f.error"> {{ f.error }}</template></span>
          </li>
        </ol>
      </li>
    </ul>
    <p v-else-if="editing !== 'new'" class="muted" data-testid="automations-empty">{{ tl('No automation yet.', 'Aucune automatisation pour l’instant.') }}</p>

    <form v-if="editing" class="pa-form" data-testid="automation-form" @submit.prevent="save">
      <label class="field-label" :for="`pa-name-${project}`">{{ t('Name') }}</label>
      <UInput :id="`pa-name-${project}`" v-model="form.name" size="xl" class="w-full" maxlength="80" />
      <label class="field-label" :for="`pa-prompt-${project}`">{{ tl('Prompt (the task\'s description)', 'Consigne (la description de la tâche)') }}</label>
      <UTextarea :id="`pa-prompt-${project}`" v-model="form.prompt" :rows="3" autoresize :maxrows="10" size="xl" class="w-full" :maxlength="20000" />
      <label class="field-label" :for="`pa-type-${project}`">{{ tl('Task type', 'Type de tâche') }}</label>
      <USelect :id="`pa-type-${project}`" v-model="typePick" :items="typeItems" size="lg" class="w-full" data-testid="automation-type" />
      <span class="field-label">{{ tl('Trigger', 'Déclencheur') }}</span>
      <div class="pa-kind" role="group">
        <UButton v-for="k in (['schedule', 'event'] as const)" :key="k" type="button" size="lg" :color="form.kind === k ? 'primary' : 'neutral'" :variant="form.kind === k ? 'solid' : 'outline'"
          :aria-pressed="form.kind === k" :data-testid="`automation-kind-${k}`" @click="form.kind = k">
          {{ k === 'schedule' ? tl('Schedule', 'Horaire') : tl('Event', 'Événement') }}
        </UButton>
      </div>
      <template v-if="form.kind === 'schedule'">
        <UInput :id="`pa-schedule-${project}`" v-model="form.schedule" size="xl" class="w-full mono" placeholder="daily 09:00" maxlength="60" autocapitalize="none" autocorrect="off" :spellcheck="false" :aria-label="tl('Schedule', 'Horaire')" />
        <small class="muted">{{ tl('every 2h · daily 09:00 · mon,thu 09:00 · or a cron. This machine\'s time.', 'every 2h · daily 09:00 · mon,thu 09:00 · ou un cron. Heure de cette machine.') }}</small>
      </template>
      <template v-else>
        <USelect v-model="form.event" :items="eventItems" size="lg" class="w-full" :aria-label="tl('Event', 'Événement')" data-testid="automation-event" />
        <UInput :id="`pa-filter-${project}`" v-model="form.filter" size="xl" class="w-full mono" placeholder="docs*" maxlength="100" autocapitalize="none" autocorrect="off" :spellcheck="false" :aria-label="tl('Filter', 'Filtre')" />
        <small class="muted">{{ tl('Optional: a title (or task/W3-*) like docs*. Never on a task an automation added.', 'Facultatif : un titre (ou task/W3-*) comme docs*. Jamais sur une tâche ajoutée par une automatisation.') }}</small>
      </template>
      <div class="pa-actions">
        <UButton v-if="editing !== 'new'" type="button" color="neutral" variant="ghost" size="lg" icon="i-lucide-trash-2" :loading="busy.startsWith('rm:')" data-testid="automation-remove" @click="remove(list.find(a => a.id === editing)!)">{{ tl('Remove', 'Retirer') }}</UButton>
        <UButton type="submit" color="primary" size="lg" :loading="busy === 'save'" :disabled="!form.name.trim() || !form.prompt.trim()" data-testid="automation-save">{{ t('Save') }}</UButton>
      </div>
    </form>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.pa { display: grid; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.pa:last-child { border-bottom: 0; }
.pa p { margin: 0; overflow-wrap: anywhere; }
.pa-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pa-head .mono-label { color: var(--text); }
.pa-list, .pa-firings { list-style: none; margin: 0; padding: 0; }
.pa-list > li { border-top: 1px solid var(--line-soft); }
.pa-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 6px 0; }
.pa-id { display: grid; gap: 1px; min-width: 0; text-align: left; overflow-wrap: anywhere; background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; }
.pa-id .mono-label { color: var(--accent); }
.pa-firings { padding: 0 0 6px; }
.pa-firings li { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-top: 1px solid var(--line-soft); overflow-wrap: anywhere; }
.pa-firings li.err { color: var(--rose); }
.pa-form { display: grid; gap: 6px; padding-top: 6px; border-top: 1px solid var(--line); }
.pa-kind, .pa-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pa-actions { justify-content: flex-end; }
</style>
