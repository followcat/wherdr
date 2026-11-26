<script setup lang="ts">
// The STUDIOS section of the home list: every live studio published by a
// machine's `backlot/1` document, its Hollywood cards and the stage's state.
// Renders nothing at all when no machine publishes a document.
import type { BacklotAction, BacklotCard, BacklotMachineView, BacklotStudio, BacklotVisualState } from '#shared/backlot'
import { backlotActionTarget, studioVisualState } from '#shared/backlot'
import { filterBacklotBySession, useBacklot } from '~/composables/useBacklot'
import { machineBarSelection } from '~/composables/useMachineBar'
import { machines, sessionTabPick } from '~/composables/useHerdr'

const props = defineProps<{ machines?: BacklotMachineView[] }>()
const { backlotMachines, runBacklotAction } = useBacklot()

const sessionMachines = computed(() => (props.machines ? filterBacklotBySession(props.machines, sessionTabPick.value) : backlotMachines.value))
const docKey = (m: Pick<BacklotMachineView, 'session' | 'machine'>) => `${m.session ?? ''}\0${m.machine}`
// A machine name as the bar names it ('' is this machine); an unknown name is kept as is.
function baseKey(machine: string) {
  if (machine === '') return ''
  const m = machines.value.find(x => x.label === machine)
  return m?.baseKey ?? m?.key ?? machine
}
const visibleMachines = computed(() => {
  const selection = machineBarSelection.value
  if (!selection?.length) return sessionMachines.value
  return sessionMachines.value.filter(m => selection.includes(baseKey(m.machine)))
})
const multi = computed(() => visibleMachines.value.length > 1)
const stopped = computed(() => visibleMachines.value.filter(m => m.summary.studios.length && !m.stageRunning))
const studios = computed(() => visibleMachines.value.flatMap(doc => doc.summary.studios.map(studio => ({ doc, studio }))))
const waitingTotal = computed(() => visibleMachines.value.reduce((n, m) => n + m.summary.studios.reduce((s, x) => s + x.waiting, 0), 0))
const STATE_LABEL: Record<BacklotVisualState, string> = {
  working: 'Working', blocked: 'Blocked', idle: 'Ready', done: 'Done', inactive: 'Closed', unknown: 'Unknown',
}

// The studio detail sheet.
const sheetOpen = ref(false)
const sheetDoc = ref<BacklotMachineView | null>(null)
const sheetStudio = ref<BacklotStudio | null>(null)
function openStudio(doc: BacklotMachineView, studio: BacklotStudio) {
  sheetDoc.value = doc
  sheetStudio.value = studio
  sheetOpen.value = true
}

const stageBusy = ref<string | null>(null)
const stageError = ref('')
async function startStage(m: BacklotMachineView) {
  const key = docKey(m)
  stageBusy.value = key
  stageError.value = ''
  try { await runBacklotAction({ kind: 'stage-start', ...backlotActionTarget(m) }) }
  catch (e) { stageError.value = (e as Error).message }
  finally { stageBusy.value = null }
}

// Hollywood: its headline, its open cards, and a line to tell it.
const hollywood = (m: BacklotMachineView) => {
  const h = m.summary.hollywood
  return h && (h.headline || h.cards?.length) ? h : null
}
const hollyTell = ref<string | null>(null)
const hollyText = ref('')
const hollyBusy = ref<string | null>(null)
const hollyError = ref('')
const hollyNote = ref('')
async function tellHollywood(m: BacklotMachineView) {
  const text = hollyText.value.trim()
  if (!text) return
  const key = docKey(m)
  hollyBusy.value = key
  hollyError.value = ''
  hollyNote.value = ''
  try {
    await runBacklotAction({ kind: 'tell-hollywood', ...backlotActionTarget(m), text })
    hollyText.value = ''
    hollyTell.value = null
    hollyNote.value = t('Sent')
  } catch (e) { hollyError.value = (e as Error).message }
  finally { hollyBusy.value = null }
}
const cardBusy = ref<string | null>(null)
async function cardAction(m: BacklotMachineView, card: BacklotCard, kind: 'card-apply' | 'card-cancel') {
  cardBusy.value = card.id
  hollyError.value = ''
  hollyNote.value = ''
  try {
    const action: BacklotAction = { kind, ...backlotActionTarget(m), cardId: card.id }
    await runBacklotAction(action)
  } catch (e) { hollyError.value = (e as Error).message }
  finally { cardBusy.value = null }
}

watch(sessionTabPick, () => {
  sheetOpen.value = false
  sheetDoc.value = null
  sheetStudio.value = null
  hollyTell.value = null
  hollyText.value = ''
  hollyError.value = ''
  hollyNote.value = ''
  stageError.value = ''
})

watch(visibleMachines, (list) => {
  if (!sheetOpen.value || !sheetDoc.value || !sheetStudio.value) return
  const nextDoc = list.find(m => docKey(m) === docKey(sheetDoc.value!))
  const nextStudio = nextDoc?.summary.studios.find(s => s.id === sheetStudio.value!.id)
  if (nextDoc && nextStudio) {
    sheetDoc.value = nextDoc
    sheetStudio.value = nextStudio
  }
})
</script>

<template>
  <section v-if="visibleMachines.length" class="bl-section" data-testid="backlot-section">
    <h2 class="group-title"><span>{{ t('Studios') }}</span><span v-if="waitingTotal" class="count" data-testid="backlot-waiting">{{ waitingTotal }}</span></h2>

    <div v-for="m in stopped" :key="`stage-${docKey(m)}`" class="bl-notice" data-testid="backlot-stage-notice">
      <span class="card-state blocked" aria-hidden="true"><i /></span>
      <span class="bl-notice-text">{{ multi ? `${m.label} · ` : '' }}{{ t('Stage not running') }}</span>
      <button type="button" class="mono-btn bl-btn" :disabled="stageBusy === docKey(m)" data-testid="backlot-stage-start" @click="startStage(m)">
        <UIcon name="i-lucide-play" />{{ t('Start stage') }}
      </button>
    </div>
    <p v-if="stageError" class="bl-error" role="alert">{{ stageError }}</p>

    <div class="bl-studios">
      <button
        v-for="{ doc, studio } in studios" :key="`${docKey(doc)}-${studio.id}`" type="button" class="bl-studio"
        :data-testid="`backlot-studio-${doc.machine || 'local'}-${studio.id}`" @click="openStudio(doc, studio)"
      >
        <span class="card-state" :class="studioVisualState(studio)" :title="t(STATE_LABEL[studioVisualState(studio)])" aria-hidden="true"><i /></span>
        <span class="bl-studio-body">
          <span class="bl-studio-top">
            <b>{{ studio.title }}</b>
            <span v-if="multi" class="bl-machine">{{ doc.label }}</span>
          </span>
          <span class="bl-meta">
            <span>{{ t(STATE_LABEL[studioVisualState(studio)]) }}</span>
            <span>{{ tl(`r${studio.requirement_version} · ${studio.tasks_done ?? 0}/${studio.tasks_total ?? 0}`) }}</span>
            <span v-if="studio.state">{{ t(studio.state === 'finished' ? 'Finished' : 'Live') }}</span>
            <span v-if="studio.waiting">{{ tl(`${studio.waiting} waiting`) }}</span>
          </span>
          <span v-if="studio.error" class="bl-line error">{{ studio.error }}</span>
          <span v-else-if="studio.next" class="bl-line">{{ studio.next }}</span>
        </span>
      </button>
    </div>

    <div v-for="m in visibleMachines.filter(hollywood)" :key="`holly-${docKey(m)}`" class="bl-holly" :data-testid="`backlot-hollywood-${m.machine || 'local'}`">
      <div class="bl-holly-head">
        <span class="card-state" :class="m.summary.hollywood!.state === 'live' ? 'working' : 'inactive'" aria-hidden="true"><i /></span>
        <span class="bl-label">{{ t('Hollywood') }}</span>
        <span v-if="multi" class="bl-machine">{{ m.label }}</span>
        <span class="bl-meta">{{ t(m.summary.hollywood!.state === 'live' ? 'Live' : m.summary.hollywood!.state === 'lost' ? 'Closed' : 'Down') }}</span>
        <span class="bl-meta">{{ tl(`${m.summary.hollywood!.cards?.length ?? 0} open cards`) }}</span>
      </div>
      <p v-if="m.summary.hollywood!.headline" class="bl-line">{{ m.summary.hollywood!.headline }}</p>
      <ul v-if="m.summary.hollywood!.cards?.length" class="bl-cards">
        <li v-for="card in m.summary.hollywood!.cards" :key="card.id" class="bl-card" :data-testid="`backlot-card-${card.id}`">
          <span class="bl-meta"><b class="bl-card-id">{{ card.id }}</b><span>{{ card.studio }}</span><span>{{ card.action }}</span></span>
          <span class="bl-line">{{ card.why }}</span>
          <span class="bl-card-actions">
            <button type="button" class="mono-btn bl-btn" :disabled="cardBusy === card.id" data-testid="backlot-card-apply" @click="cardAction(m, card, 'card-apply')">
              <UIcon name="i-lucide-check" />{{ t('Apply') }}
            </button>
            <button type="button" class="mono-btn bl-btn" :disabled="cardBusy === card.id" data-testid="backlot-card-cancel" @click="cardAction(m, card, 'card-cancel')">
              <UIcon name="i-lucide-ban" />{{ t('Cancel') }}
            </button>
          </span>
        </li>
      </ul>
      <button v-if="hollyTell !== docKey(m)" type="button" class="mono-btn bl-btn bl-holly-tell" data-testid="backlot-tell-hollywood" @click="hollyTell = docKey(m); hollyText = ''">
        <UIcon name="i-lucide-send" />{{ t('Tell Hollywood') }}
      </button>
      <form v-else class="bl-tell" @submit.prevent="tellHollywood(m)">
        <input v-model="hollyText" class="bl-input" :placeholder="t('Message to Hollywood…')" :aria-label="t('Message to Hollywood…')" maxlength="4000">
        <button type="submit" class="mono-btn bl-btn" :disabled="hollyBusy === docKey(m) || !hollyText.trim()" data-testid="backlot-tell-hollywood-send">
          {{ t('Send') }}
        </button>
      </form>
      <p v-if="hollyError" class="bl-error" role="alert">{{ hollyError }}</p>
      <p v-else-if="hollyNote" class="bl-note">{{ hollyNote }}</p>
    </div>

    <BacklotStudioSheet v-model:open="sheetOpen" :machine="sheetDoc" :studio="sheetStudio" />
  </section>
</template>

<style scoped>
.bl-section { display: grid; gap: 8px; margin: 0 0 18px; }
.bl-studios { display: grid; gap: 8px; }
.bl-studio { display: flex; gap: 10px; align-items: flex-start; width: 100%; min-height: 56px; padding: 10px 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.bl-studio:hover { background: var(--surface-2); }
.bl-studio .card-state { margin-top: 2px; }
.bl-studio-body { display: grid; gap: 3px; flex: 1; min-width: 0; }
.bl-studio-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.bl-studio-top b { overflow: hidden; font: 600 14px/1.3 var(--display); text-overflow: ellipsis; white-space: nowrap; }
.bl-machine { flex: none; margin-left: auto; padding: 2px 5px; border: 1px solid var(--line); color: var(--muted); font: 500 9.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.bl-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font: 400 11px/1.35 var(--mono); }
.bl-line { color: var(--text-2); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.bl-line.error, .bl-error { color: var(--blocked); }
.bl-error { margin: 0; font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.bl-note { margin: 0; color: var(--done); font: 400 12px/1.35 var(--mono); }
.bl-notice { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid var(--line-soft); background: var(--surface); color: var(--text-2); font: 400 12px/1.3 var(--mono); }
.bl-notice-text { flex: 1; min-width: 0; }
.bl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); cursor: pointer; touch-action: manipulation; }
.bl-btn:hover:not(:disabled) { background: var(--surface-2); }
.bl-btn:disabled { color: var(--dim); cursor: progress; }
.bl-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bl-holly { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); background: var(--surface); }
.bl-holly-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.bl-label { font: 500 9.5px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.bl-cards { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.bl-card { display: grid; gap: 5px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.bl-card-id { color: var(--text-2); }
.bl-card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.bl-holly-tell { justify-self: start; }
.bl-tell { display: flex; flex-wrap: wrap; gap: 6px; }
.bl-input { flex: 1 1 12rem; min-width: 0; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: 400 13px/1.4 var(--mono); }
.bl-input:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
</style>
