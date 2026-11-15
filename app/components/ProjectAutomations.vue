<script setup lang="ts">
// A project's automations (Settings › Projects › KEY › Automations): the
// changes the coordinator or Alfred proposed, waiting for the user's Accept or
// Refuse (AutomationProposalCard); then each automation, its switch, what fires
// it in words, its next firing and its last results as a short timeline, and
// Run now. No form: the user asks the project's coordinator (or Alfred).
import { firingKind, type Automation, type AutomationProposal, type Firing } from '#shared/pm/automations'

const props = defineProps<{ project: string, name: string }>()
const list = ref<Automation[]>([])
const proposals = ref<AutomationProposal[]>([])
// Each schedule's next firing, from the server (its time zone runs them).
const nextAt = ref<Record<string, number>>({})
const busy = ref('')
// Until the first read: skeletons, not "No automation yet" (SettingsSkeleton).
const loaded = ref(false)
const error = ref('')
const TIMELINE = 5
const KIND: Record<ReturnType<typeof firingKind>, string> = { fired: 'Fired', waits: 'Waits for room', skipped: 'Skipped', failed: 'Failed' }
const timeline = (a: Automation) => [...(a.firings ?? [])].slice(-TIMELINE).reverse()
const result = (f: Firing) => [f.task, firingKind(f) === 'fired' ? '' : f.error].filter(Boolean).join(' · ')
const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

async function load() {
  if (!loaded.value) error.value = '' // Try again; an action's error stays
  try { ({ automations: list.value, proposals: proposals.value, next: nextAt.value } = await api<{ automations: Automation[], proposals: AutomationProposal[], next: Record<string, number> }>(`/api/pm/automations?project=${encodeURIComponent(props.project)}`)); loaded.value = true }
  catch (e) { error.value = (e as Error).message }
}
// Read again while open: a new proposal or a firing shows without a reload.
const REFRESH_MS = 15_000
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void load(); timer = setInterval(() => { if (!busy.value && document.visibilityState === 'visible') void load() }, REFRESH_MS) })
onUnmounted(() => clearInterval(timer))

async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn(); await load() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const setOn = (a: Automation, on: boolean) => run(`on:${a.id}`, () => api('/api/pm/automation', { project: props.project, id: a.id, on }))
const runNow = (a: Automation) => run(`run:${a.id}`, async () => {
  const r = await api<{ firing: { task?: string, error?: string } }>('/api/pm/automation', { project: props.project, id: a.id, runNow: true })
  toast(r.firing.error ? r.firing.error : tl(`${r.firing.task} started`))
})
// The project's coordinator, else Alfred.
const coordinator = computed(() => projectCoordinators.value.find(c => c.project === props.project) ?? coordinators.value.find(c => c.main))
const ask = () => run('ask', async () => { if (coordinator.value) await openCoordinator(coordinator.value) })
</script>

<template>
  <section class="pa" :data-testid="`automations-${project}`">
    <span class="mono-label pa-head">{{ name }}<template v-if="loaded"> · {{ list.length }}</template></span>
    <div class="pa-ask">
      <p class="muted">{{ tl('To add or change an automation, ask the project\'s coordinator (or Alfred).') }}</p>
      <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-message-square" :loading="busy === 'ask'" :disabled="!coordinator" data-testid="automation-ask" @click="ask">{{ coordinator?.main ? tl('Ask Alfred') : tl('Ask the coordinator') }}</UButton>
    </div>
    <AutomationProposalCard v-for="p in proposals" :key="p.id" :p="p" @answered="load" />
    <SettingsSkeleton v-if="!loaded" :rows="2" :error="error" @retry="load" />
    <ul v-else-if="list.length" class="pa-list">
      <li v-for="a in list" :key="a.id" data-testid="automation">
        <div class="pa-row">
          <USwitch :model-value="a.on" size="lg" :disabled="!!busy" :aria-label="tl(`${a.name} on`)" data-testid="automation-on" @update:model-value="v => setOn(a, v)" />
          <div class="pa-id">
            <b>{{ a.name }}</b>
            <small class="mono-label" data-testid="automation-trigger">{{ automationTrigger(a) }}</small>
            <small v-if="a.on && nextAt[a.id]" class="muted" data-testid="automation-next">{{ tl('Next') }} {{ when(nextAt[a.id]!) }}</small>
          </div>
          <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-play" :loading="busy === `run:${a.id}`" :disabled="!!busy" :aria-label="tl(`Run ${a.name} now`)" data-testid="automation-run" @click="runNow(a)" />
        </div>
        <details class="pa-prompt">
          <summary class="muted">{{ tl('What it does') }}</summary>
          <p>{{ a.prompt }}</p>
        </details>
        <ol v-if="a.firings?.length" class="pa-timeline" :aria-label="tl('Last results')" data-testid="automation-timeline">
          <li v-for="f in timeline(a)" :key="f.at" :class="firingKind(f)" data-testid="automation-firing">
            <span class="pa-dot" aria-hidden="true" />
            <span class="mono-label">{{ when(f.at) }}</span>
            <span><b>{{ tl(KIND[firingKind(f)]) }}</b> {{ result(f) }}</span>
          </li>
        </ol>
        <small v-else class="muted pa-never" data-testid="automation-never">{{ tl('Never fired') }}</small>
      </li>
    </ul>
    <p v-else class="muted" data-testid="automations-empty">{{ tl('No automation yet.') }}</p>
    <p v-if="error && loaded" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.pa { display: grid; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-width: 0; }
.pa:last-child { border-bottom: 0; }
.pa p { margin: 0; overflow-wrap: anywhere; }
.pa-head { color: var(--text); }
.pa-ask { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.pa-ask p { flex: 1 1 220px; }
.pa-list, .pa-timeline { list-style: none; margin: 0; padding: 0; }
.pa-list > li { display: grid; gap: 4px; padding: 6px 0 10px; border-top: 1px solid var(--line-soft); min-width: 0; }
.pa-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.pa-id { display: grid; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
.pa-id .mono-label { color: var(--accent); }
.pa-prompt summary { cursor: pointer; font-size: 13px; }
.pa-prompt p { padding: 4px 0 0; white-space: pre-wrap; }
/* The timeline: newest first, a rail on the left, one mark per firing. */
.pa-timeline { margin-left: 5px; border-left: 1px solid var(--line); }
.pa-timeline li { position: relative; display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 2px 10px; padding: 2px 0 2px 14px; overflow-wrap: anywhere; font-size: 13px; }
.pa-dot { position: absolute; left: -4px; top: 8px; width: 7px; height: 7px; background: var(--green); }
.pa-timeline .waits .pa-dot { background: var(--blocked); }
.pa-timeline .skipped .pa-dot { background: var(--muted); }
.pa-timeline .failed .pa-dot { background: var(--rose); }
.pa-timeline .failed { color: var(--rose); }
@media (max-width: 599px) { .pa-timeline li { grid-template-columns: minmax(0, 1fr); } }
</style>
