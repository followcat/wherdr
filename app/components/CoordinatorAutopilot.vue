<script setup lang="ts">
// A coordinator's autopilot: its switch, whether it is active or asleep
// (nothing to do: its scheduled wakes are skipped), today's counters against
// the limits, the day's timeline (AutopilotTimeline) and "run now", then its
// settings, saved by the user only: goal, when it wakes, limits, hours.
// In the coordinator window and the project sheet's Autopilot tab. Two tabs:
// Settings, first and the default, whose Save bar is pinned at the bottom of the
// scroll, and Activity (switch, run now, timeline, wake log). The tab is
// remembered per viewer; a link to `project.autopilot` opens Settings. Leaving Settings, or closing the window
// (`leave`, CoordinatorButton), with unsaved changes asks once.
// Slots: `activity` and `settings`, the coordinator window's parts at the top of each tab.
// `withAgent` (the coordinator window): the answering agent heads Settings, saved
// and discarded with the rest.
import { AUTOPILOT_EVENTS, DEFAULT_AUTOPILOT, LOOK_PER_DAY, MAX_PER_DAY, oldDefaults, type Autopilot, type AutopilotEvent } from '#shared/pm/autopilot'
import type { CoordinatorProgram, CoordinatorView } from '#shared/pm/coordinator'
import { HEALTH_EVERY } from '#shared/pm/health'
import { uiTarget } from '#shared/uiTargets'

const props = defineProps<{ c: CoordinatorView, withAgent?: boolean }>()
const ap = computed<Autopilot>(() => props.c.autopilot ?? DEFAULT_AUTOPILOT)
const busy = ref(false)
const error = ref('')
const sent = ref(false)
// The form's fields, from a saved autopilot. Empty: Tasks / day has no limit, At once is Auto.
type Form = { goal: string, every: string, at: string, events: AutopilotEvent[], perDay: string, atOnce: string, lookForWork: boolean, lookPerDay: number, keepBusy: boolean, health: string, from: string, to: string }
const text = (n: number | null) => (n === null ? '' : String(n))
const formOf = (a: Autopilot): Form => ({ goal: a.goal, every: a.every ?? '', at: a.at ?? '', events: [...a.events], perDay: text(a.perDay), atOnce: text(a.atOnce), lookForWork: !!a.lookForWork, lookPerDay: a.lookPerDay ?? LOOK_PER_DAY, keepBusy: a.keepBusy !== false, health: a.health ?? '', from: text(a.hours?.from ?? null), to: text(a.hours?.to ?? null) })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// A field as it would be saved: numbers as numbers (empty: null), times trimmed.
const orNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v))
const norm = (k: keyof Form, v: unknown) => (k === 'perDay' || k === 'atOnce' ? orNull(v) : typeof v === 'number' || k === 'lookPerDay' ? Number(v) : k === 'every' || k === 'at' || k === 'health' || k === 'from' || k === 'to' ? String(v).trim() : v)
const KEYS = Object.keys(formOf(DEFAULT_AUTOPILOT)) as (keyof Form)[]
const form = reactive<Form>(formOf(ap.value))
// What the form was last filled with: the saved values it shows.
const base = ref<Form>(formOf(ap.value))
const edited = (k: keyof Form) => !same(norm(k, form[k]), norm(k, base.value[k]))
// The coordinators are read again every few seconds, each time a new object:
// refill only when the saved values change, and never over a field the user edited.
watch(() => JSON.stringify(formOf(ap.value)), () => {
  const next = formOf(ap.value)
  for (const k of KEYS) if (!edited(k)) (form as Record<string, unknown>)[k] = next[k]
  base.value = next
})
// The answering agent: picked here, sent by Save (its own endpoint).
const savedProgram = computed<CoordinatorProgram | undefined>(() => coordinatorAgent(props.c)?.program)
const program = ref<CoordinatorProgram | undefined>(savedProgram.value)
const agentEdited = computed(() => !!props.withAgent && program.value !== savedProgram.value)
watch(savedProgram, (p, old) => { if (program.value === old) program.value = p })
const agentItems = computed(() => offerCoordinators(undefined, props.c.project).map(p => ({ label: kindLabel(p), value: p })))
const dirty = computed(() => agentEdited.value || KEYS.some(edited))
const saved = ref(false)
watch(dirty, d => { if (d) saved.value = false })

const EVENT_LABEL: Record<AutopilotEvent, [string, string]> = {
  added: ['Task added', 'Tâche ajoutée'], done: ['Task done', 'Tâche finie'], stuck: ['Task stuck', 'Tâche bloquée'], ready: ['Ready for you', 'Prête pour toi'],
}
type Tab = 'activity' | 'settings'
const TABS: [Tab, string][] = [['settings', 'Settings'], ['activity', 'Activity']]
const TAB_KEY = 'wherdr.autopilotTab'
const storedTab = (): Tab => { try { return localStorage.getItem(TAB_KEY) === 'activity' ? 'activity' : 'settings' } catch { return 'settings' } }
const tab = ref<Tab>(uiTarget(useRoute().query.target) === 'project.autopilot' ? 'settings' : storedTab())
// Back to the saved values.
const discard = () => { Object.assign(form, { ...base.value, events: [...base.value.events] }); program.value = savedProgram.value; saveError.value = '' }
// Unsaved changes: asks once whether to drop them; false keeps them (and the tab, the window).
async function leave() {
  if (!dirty.value) return true
  if (!(await askConfirm(tl('Discard the unsaved autopilot changes?'), tl('Discard')))) return false
  discard()
  return true
}
defineExpose({ leave })
async function pickTab(k: Tab) {
  if (k === tab.value || (tab.value === 'settings' && !(await leave()))) return
  tab.value = k
  try { localStorage.setItem(TAB_KEY, k) } catch { /* Storage may be disabled: kept for this visit. */ }
}
const toggleEvent = (e: AutopilotEvent) => { form.events = form.events.includes(e) ? form.events.filter(x => x !== e) : [...form.events, e] }

async function act(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try { await fn(); await loadCoordinators() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
// The server's refusal names its field ("every: a duration like 30m or 2h"): shown under it.
const FIELD: Record<string, keyof Form> = { goal: 'goal', every: 'every', at: 'at', events: 'events', perDay: 'perDay', atOnce: 'atOnce', lookPerDay: 'lookPerDay', health: 'health', hours: 'from' }
const saveError = ref('')
const errorField = computed(() => FIELD[/^(\w+)/.exec(saveError.value)?.[1] ?? ''])
const fieldError = (k: keyof Form) => (errorField.value === k ? saveError.value : '')
// Applies at once, on or off: the switch is kept as it is.
async function save() {
  saveError.value = ''
  await act(async () => {
    const { lookForWork: _, lookPerDay: __, keepBusy: ___, health: ____, hours: _____, ...kept } = ap.value
    if (agentEdited.value) await api('/api/pm/coordinator-agent', { project: props.c.project, program: program.value })
    if (!KEYS.some(edited)) { saved.value = true; return }
    const hours = String(form.from).trim() !== '' && String(form.to).trim() !== '' ? { hours: { from: Number(form.from), to: Number(form.to) } } : {}
    try {
      const r = await api<{ autopilot: Autopilot }>('/api/pm/autopilot', {
        project: props.c.project,
        autopilot: { ...kept, goal: form.goal, every: form.every.trim(), at: form.at.trim(), events: form.events, perDay: orNull(form.perDay), atOnce: orNull(form.atOnce), ...(form.lookForWork ? { lookForWork: true, lookPerDay: Number(form.lookPerDay) } : {}), ...(form.keepBusy ? {} : { keepBusy: false }), ...(form.health.trim() ? { health: form.health.trim() } : {}), ...hours },
      })
      // The form takes the saved values (the goal trimmed…).
      if (r?.autopilot) { base.value = formOf(r.autopilot); Object.assign(form, formOf(r.autopilot)) }
      saved.value = true
    } catch (e) {
      saveError.value = (e as Error).message
      if (errorField.value) return
      throw e
    }
  })
}
// The switch keeps the saved settings: only what Save sent counts.
const setOn = (on: boolean) => act(() => api('/api/pm/autopilot', { project: props.c.project, autopilot: { ...ap.value, on } }))
const runNow = () => act(async () => { await api('/api/pm/autopilot', { project: props.c.project, runNow: true }); sent.value = true })

const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')
// Its last wake: the time today, else the day too.
const when = (at: number) => (new Date(at).toDateString() === new Date().toDateString() ? time(at) : new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
const stateText = computed(() => {
  if (!ap.value.on) return tl('Off', 'Arrêté')
  if (!props.c.asleep) return tl('Active', 'Actif')
  const woke = props.c.wokeAt ? tl(` · woke ${when(props.c.wokeAt)}`, ` · réveillé ${when(props.c.wokeAt)}`) : ''
  return props.c.asleep === 'limit'
    ? tl(`Asleep · new work limit reached until tomorrow${woke}`, `Endormi · limite de travail nouveau atteinte jusqu’à demain${woke}`)
    : tl(`Asleep · nothing to do${woke}`, `Endormi · rien à faire${woke}`)
})
const counters = computed(() => props.c.limits
  ? tl(`${props.c.limits.started}${props.c.limits.perDay === null ? '' : `/${props.c.limits.perDay}`} today · ${props.c.limits.working}/${props.c.limits.atOnce ?? 'Auto'} at once`)
  : '')
</script>

<template>
  <section class="ap" :data-tab="tab" data-testid="coordinator-autopilot">
    <div class="segmented ap-tabs" role="tablist" :style="{ '--segment-count': TABS.length }">
      <button v-for="[k, label] in TABS" :id="`ap-tab-${k}-${c.project}`" :key="k" type="button" role="tab" :class="{ on: tab === k }" :aria-selected="tab === k" :data-testid="`autopilot-tab-${k}`" @click="pickTab(k)">
        <span>{{ tl(label) }}</span>
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-show="tab === 'activity'" class="ap-panel" role="tabpanel" :aria-labelledby="`ap-tab-activity-${c.project}`" data-testid="autopilot-activity">
    <slot name="activity" />
    <div class="ap-head">
      <USwitch :model-value="ap.on" color="success" size="lg" :disabled="busy" :aria-label="tl('Autopilot', 'Autopilote')" data-testid="autopilot-on" @update:model-value="setOn" />
      <span class="mono-label" data-testid="autopilot-state" :data-asleep="ap.on && c.asleep ? '' : undefined">{{ tl('Autopilot', 'Autopilote') }} · {{ stateText }}</span>
      <span class="ap-count mono-label" data-testid="autopilot-counters">{{ counters }}</span>
      <UButton type="button" color="neutral" variant="outline" size="lg" icon="i-lucide-play" :disabled="busy || !c.terminal" data-testid="autopilot-run-now" @click="runNow">{{ tl('Run now', 'Lancer maintenant') }}</UButton>
    </div>
    <p v-if="!c.terminal" class="muted">{{ tl('Start the coordinator to wake it.', 'Lance le coordinateur pour le réveiller.') }}</p>
    <p v-else-if="sent" class="muted" role="status">{{ tl('Queued: it goes as soon as the coordinator is idle.', 'En file : il part dès que le coordinateur est inactif.') }}</p>
    <AutopilotTimeline :c="c" />
    </div>

    <div v-show="tab === 'settings'" class="ap-panel" role="tabpanel" :aria-labelledby="`ap-tab-settings-${c.project}`" data-testid="autopilot-settings">
    <slot name="settings" />
    <form class="ap-form" @submit.prevent="save()">
      <div v-if="withAgent" class="ap-agent">
        <label class="field-label" :for="`ap-agent-${c.project}`">{{ tl('Answering agent') }}</label>
        <USelect :id="`ap-agent-${c.project}`" v-model="program" :items="agentItems" size="lg" class="w-full" data-testid="coordinator-agent" />
      </div>
      <fieldset class="ap-group">
        <legend class="mono-label">{{ tl('Goal', 'Objectif') }}</legend>
        <UTextarea :id="`ap-goal-${c.project}`" v-model="form.goal" :rows="2" autoresize :maxrows="6" size="xl" class="w-full" :maxlength="2000" :aria-label="tl('Goal')" data-testid="autopilot-goal"
          :placeholder="tl('What it works toward, e.g. Ship the small fixes first', 'Ce vers quoi il travaille, ex. Les petites corrections d’abord')" />
        <p v-if="fieldError('goal')" class="error" role="alert" data-testid="autopilot-error-goal">{{ fieldError('goal') }}</p>
      </fieldset>

      <fieldset class="ap-group">
        <legend class="mono-label">{{ tl('When it wakes') }}</legend>
        <div class="ap-grid three">
          <div>
            <label class="field-label" :for="`ap-every-${c.project}`">{{ tl('Every', 'Fréquence') }}</label>
            <UInput :id="`ap-every-${c.project}`" v-model="form.every" size="xl" class="w-full mono" placeholder="2h" maxlength="5" autocapitalize="none" autocorrect="off" :spellcheck="false" data-testid="autopilot-every" />
            <p v-if="fieldError('every')" class="error" role="alert" data-testid="autopilot-error-every">{{ fieldError('every') }}</p>
          </div>
          <div>
            <label class="field-label" :for="`ap-at-${c.project}`">{{ tl('At', 'À') }}</label>
            <UInput :id="`ap-at-${c.project}`" v-model="form.at" size="xl" class="w-full mono" placeholder="daily 08:00" maxlength="60" autocapitalize="none" autocorrect="off" :spellcheck="false" data-testid="autopilot-at" />
            <p v-if="fieldError('at')" class="error" role="alert" data-testid="autopilot-error-at">{{ fieldError('at') }}</p>
          </div>
          <div>
            <label class="field-label" :for="`ap-health-${c.project}`">{{ tl('Health check') }}</label>
            <UInput :id="`ap-health-${c.project}`" v-model="form.health" size="xl" class="w-full mono" :placeholder="HEALTH_EVERY" maxlength="5" autocapitalize="none" autocorrect="off" :spellcheck="false" data-testid="autopilot-health" />
            <p v-if="fieldError('health')" class="error" role="alert" data-testid="autopilot-error-health">{{ fieldError('health') }}</p>
          </div>
        </div>
        <p class="muted">{{ tl('Health check empty: every 3h; off: never.') }}</p>
        <span class="field-label">{{ tl('Also on', 'Aussi quand') }}</span>
        <div class="ap-events" role="group">
          <UButton v-for="e in AUTOPILOT_EVENTS" :key="e" type="button" size="lg" :color="form.events.includes(e) ? 'primary' : 'neutral'" :variant="form.events.includes(e) ? 'solid' : 'outline'"
            :aria-pressed="form.events.includes(e)" :data-testid="`autopilot-event-${e}`" @click="toggleEvent(e)">
            {{ tl(...EVENT_LABEL[e]) }}
          </UButton>
        </div>
        <p class="muted" data-testid="autopilot-events-hint">{{ tl('Off by default: the engine handles them. A question, a choice after review rounds and a block the engine gave up on always wake it. Task added: by someone else than this coordinator.') }}</p>
        <p v-if="fieldError('events')" class="error" role="alert" data-testid="autopilot-error-events">{{ fieldError('events') }}</p>
        <USwitch v-model="form.lookForWork" size="lg" :label="tl('Look for new work', 'Chercher du travail')" data-testid="autopilot-look-for-work"
          :description="tl('Keep the scheduled wakes when there is nothing to do, for a goal that adds its own tasks.', 'Garder les réveils programmés quand il n’y a rien à faire, pour un objectif qui crée ses propres tâches.')" />
        <div v-if="form.lookForWork" class="ap-grid">
          <div>
            <label class="field-label" :for="`ap-look-${c.project}`">{{ tl('New tasks / day', 'Tâches nouvelles / jour') }}</label>
            <UInput :id="`ap-look-${c.project}`" v-model="form.lookPerDay" type="number" min="0" max="20" inputmode="numeric" size="xl" class="w-full mono" data-testid="autopilot-look-per-day" />
            <p v-if="fieldError('lookPerDay')" class="error" role="alert" data-testid="autopilot-error-lookPerDay">{{ fieldError('lookPerDay') }}</p>
          </div>
          <p class="muted ap-look-note">{{ tl('Added by those wakes; once reached, it sleeps until tomorrow.', 'Ajoutées par ces réveils ; une fois atteint, il dort jusqu’à demain.') }}</p>
        </div>
      </fieldset>

      <fieldset class="ap-group">
        <legend class="mono-label">{{ tl('Limits') }}</legend>
        <div class="ap-grid">
          <div>
            <label class="field-label" :for="`ap-day-${c.project}`">{{ tl('Tasks / day', 'Tâches / jour') }}</label>
            <UInput :id="`ap-day-${c.project}`" v-model="form.perDay" type="number" min="0" :max="MAX_PER_DAY" inputmode="numeric" :placeholder="tl('No limit')" size="xl" class="w-full mono" data-testid="autopilot-per-day" />
            <p v-if="fieldError('perDay')" class="error" role="alert" data-testid="autopilot-error-perDay">{{ fieldError('perDay') }}</p>
          </div>
          <div>
            <label class="field-label" :for="`ap-once-${c.project}`">{{ tl('At once', 'En parallèle') }}</label>
            <UInput :id="`ap-once-${c.project}`" v-model="form.atOnce" type="number" min="0" max="20" inputmode="numeric" size="xl" class="w-full mono" :placeholder="tl('Auto')" data-testid="autopilot-at-once" />
            <p v-if="fieldError('atOnce')" class="error" role="alert" data-testid="autopilot-error-atOnce">{{ fieldError('atOnce') }}</p>
          </div>
        </div>
        <p class="muted">{{ tl('At once empty: Auto, as many as the project\'s machines have room for.') }}</p>
        <p v-if="oldDefaults(ap)" class="muted" data-testid="autopilot-old-defaults">{{ tl('Older defaults: clear the fields for unlimited and Auto') }}</p>
        <USwitch v-model="form.keepBusy" size="lg" :label="tl('Keep the board busy')" data-testid="autopilot-keep-busy"
          :description="tl('Start the next to-do task, oldest first, whenever a machine has room, within the limits and hours, without waking the coordinator.')" />
      </fieldset>

      <fieldset class="ap-group">
        <legend class="mono-label">{{ tl('Hours') }}</legend>
        <div class="ap-grid">
          <div>
            <label class="field-label" :for="`ap-from-${c.project}`">{{ tl('From') }}</label>
            <UInput :id="`ap-from-${c.project}`" v-model="form.from" type="number" min="0" max="23" inputmode="numeric" placeholder="0" size="xl" class="w-full mono" data-testid="autopilot-from" />
          </div>
          <div>
            <label class="field-label" :for="`ap-to-${c.project}`">{{ tl('To') }}</label>
            <UInput :id="`ap-to-${c.project}`" v-model="form.to" type="number" min="0" max="24" inputmode="numeric" placeholder="24" size="xl" class="w-full mono" data-testid="autopilot-to" />
          </div>
        </div>
        <p class="muted">{{ tl('Automatic work only within these hours (local; empty: all day).') }}</p>
        <p v-if="fieldError('from')" class="error" role="alert" data-testid="autopilot-error-hours">{{ fieldError('from') }}</p>
      </fieldset>

      <div class="ap-bar" data-testid="autopilot-bar">
        <span v-if="dirty" class="mono-label ap-unsaved" data-testid="autopilot-unsaved">{{ tl('Unsaved changes') }}</span>
        <span v-else-if="saved" class="mono-label ap-saved" role="status" data-testid="autopilot-saved">{{ tl('Saved') }}</span>
        <span v-else class="mono-label">{{ tl('No changes') }}</span>
        <UButton type="button" color="neutral" variant="outline" size="lg" :disabled="!dirty || busy" data-testid="autopilot-cancel" @click="discard">{{ tl('Cancel') }}</UButton>
        <UButton type="submit" color="primary" size="lg" :loading="busy" :disabled="!dirty" data-testid="autopilot-save">{{ t('Save') }}</UButton>
      </div>
    </form>
    </div>
  </section>
</template>

<style scoped>
.ap, .ap-panel { display: grid; gap: 8px; min-width: 0; }
.ap { gap: 12px; }
.ap p { margin: 0; overflow-wrap: anywhere; }
.ap-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ap-head > .mono-label:not(.ap-count) { color: var(--text); }
.ap-count { flex: 1; color: var(--muted); white-space: nowrap; }
.ap-look-note { align-self: end; }
.ap-agent { display: grid; gap: 4px; min-width: 0; max-width: 420px; }
/* Pinned at the bottom of the sheet's scroll, its last element: it carries the
   sheet's end padding (main.css drops the body's in the coordinator window). */
.ap-bar { position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0 var(--sheet-end, 12px); background: var(--sheet-bg, var(--bg-2)); border-top: 1px solid var(--line-soft); }
.ap-bar .mono-label { flex: 1 1 120px; min-width: 0; color: var(--muted); }
.ap-bar .ap-unsaved { color: var(--ochre); }
.ap-bar .ap-saved { color: var(--green); }
.ap-form { display: grid; gap: 12px; }
.ap-group { display: grid; gap: 6px; min-width: 0; margin: 0; padding: 10px 0 0; border: 0; border-top: 1px solid var(--line); }
.ap-group > legend { padding: 0 8px 0 0; color: var(--text); }
.ap-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
@media (min-width: 640px) { .ap-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.ap-events { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
