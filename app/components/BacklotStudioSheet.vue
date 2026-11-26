<script setup lang="ts">
// A studio's detail sheet: its open attentions, its cast, its tasks and the
// Hollywood cards it owns. A live role opens its terminal; every action runs
// on the studio's machine through /api/backlot/action.
import type { BacklotAction, BacklotCard, BacklotMachineView, BacklotRole, BacklotStudio, BacklotVisualState } from '#shared/backlot'
import { backlotActionTarget, roleVisualState, studioVisualState, studioWaitingAttentions } from '#shared/backlot'
import { runBacklotAction } from '~/composables/useBacklot'
import { allSessionsState, herdrState } from '~/composables/useHerdr'
import { panePath } from '~/composables/useWorkspaces'
import { paneSessionName } from '~/utils/sessionTabs'

const props = defineProps<{ machine: BacklotMachineView | null, studio: BacklotStudio | null }>()
const open = defineModel<boolean>('open', { default: false })

const STATE_LABEL: Record<BacklotVisualState, string> = {
  working: 'Working', blocked: 'Blocked', idle: 'Ready', done: 'Done', inactive: 'Closed', unknown: 'Unknown',
}
const attentions = computed(() => (props.studio ? studioWaitingAttentions(props.studio) : []))
const roles = computed(() => props.studio?.roles ?? [])
const tasks = computed(() => props.studio?.tasks ?? [])
const cards = computed(() => {
  const studio = props.studio
  if (!studio) return []
  const list = props.machine?.summary.hollywood?.cards ?? []
  return list.filter(c => c.studio === studio.id || c.studio === studio.title)
})

const busy = ref('')
const feedback = ref<{ ok: boolean, text: string } | null>(null)
const tellRole = ref('')
const tellText = ref('')
const docFile = ref<string | null>(null)
const docOpen = ref(false)
const hasProducer = computed(() => roles.value.some(r => r.role === 'producer'))
const studioLocked = computed(() => Boolean(props.studio?.needs_upgrade))

function openDoc(file: string) {
  docFile.value = file
  docOpen.value = true
}

function openProducerReply() {
  if (studioLocked.value || !hasProducer.value) return
  tellRole.value = 'producer'
  tellText.value = ''
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="backlot-role-producer"] input')
    input?.scrollIntoView?.({ block: 'nearest' })
    input?.focus?.()
  })
}

const sessionPanes = computed(() => {
  const sk = props.machine?.session
  if (sk === undefined || !allSessionsState.value.sessions?.length) return herdrState.value.panes
  const tab = allSessionsState.value.sessions.find(s => s.key === sk)
  if (!tab) return []
  return allSessionsState.value.panes.filter(p => paneSessionName(p, allSessionsState.value) === tab.name)
})
const paneOf = (role: BacklotRole) => {
  const address = role.terminal
  if (!address) return null
  return sessionPanes.value.find(p => p.coreAddress === address || p.id === address) ?? null
}
function openRole(role: BacklotRole) {
  const pane = paneOf(role)
  if (!pane) return
  open.value = false
  void navigateTo(panePath(pane.id))
}

async function act(key: string, action: BacklotAction) {
  busy.value = key
  feedback.value = null
  try {
    const r = await runBacklotAction(action)
    feedback.value = { ok: true, text: r.output || t('Done') }
  } catch (e) {
    feedback.value = { ok: false, text: (e as Error).message }
  } finally {
    busy.value = ''
  }
}
function approve(role: BacklotRole, decision: 'allow' | 'deny') {
  if (!props.machine || !props.studio || studioLocked.value) return
  void act(`approve-${role.role}`, { kind: 'approve', ...backlotActionTarget(props.machine), studio: props.studio.id, person: role.name, decision })
}
function clearAttention(role: BacklotRole) {
  if (!props.machine || !props.studio || studioLocked.value || role.attention_seq == null) return
  void act(`clear-${role.role}`, { kind: 'attention-clear', ...backlotActionTarget(props.machine), studio: props.studio.id, seq: role.attention_seq })
}
function tell(role: BacklotRole) {
  const text = tellText.value.trim()
  if (!props.machine || !props.studio || studioLocked.value || !text) return
  const finish = () => { tellRole.value = ''; tellText.value = '' }
  void act(`tell-${role.role}`, { kind: 'tell', ...backlotActionTarget(props.machine), studio: props.studio.id, role: role.role, text })
    .then(() => { if (feedback.value?.ok) finish() })
}
function cardAction(card: BacklotCard, kind: 'card-apply' | 'card-cancel') {
  if (!props.machine) return
  void act(`${kind}-${card.id}`, { kind, ...backlotActionTarget(props.machine), cardId: card.id })
}
function startStage() {
  if (!props.machine) return
  void act('stage-start', { kind: 'stage-start', ...backlotActionTarget(props.machine) })
}
watch(() => [props.machine?.session, props.machine?.machine, props.studio?.id], () => {
  busy.value = ''
  feedback.value = null
  tellRole.value = ''
  tellText.value = ''
  docOpen.value = false
  docFile.value = null
})
</script>

<template>
  <AppSheet v-model:open="open" :title="studio?.title || ''" hide-close>
    <div v-if="machine && studio" class="bls" data-testid="backlot-studio-sheet">
      <div class="bls-head">
        <span class="card-state" :class="studioVisualState(studio)" :title="t(STATE_LABEL[studioVisualState(studio)])" aria-hidden="true"><i /></span>
        <div class="bls-head-text">
          <p class="bls-head-line">
            <b>{{ t(studio.state === 'finished' ? 'Finished' : 'Live') }}</b>
            <span class="bl-meta">{{ tl(`Requirement r${studio.requirement_version}`) }}</span>
            <span v-if="machine.machine" class="bl-machine">{{ machine.label }}</span>
          </p>
          <p class="bls-head-line">
            <span class="card-state" :class="machine.stageRunning ? 'working' : 'inactive'" aria-hidden="true"><i /></span>
            <span class="bl-meta">{{ machine.stageRunning ? t('Stage running') : t('Stage not running') }}</span>
            <button v-if="!machine.stageRunning" type="button" class="mono-btn bl-btn" :disabled="!!busy" data-testid="backlot-sheet-stage-start" @click="startStage">
              <UIcon name="i-lucide-play" />{{ t('Start stage') }}
            </button>
          </p>
        </div>
      </div>

      <p v-if="feedback" :class="feedback.ok ? 'bl-note' : 'bl-error'" :role="feedback.ok ? 'status' : 'alert'" data-testid="backlot-feedback">{{ feedback.text }}</p>

      <BacklotDesignDecision
        :machine="machine" :studio="studio" :external-reply="hasProducer" :disabled="!!busy"
        @read="openDoc" @reply="openProducerReply" @acted="feedback = $event"
      />

      <section v-if="attentions.length" class="bls-block" data-testid="backlot-attentions">
        <h3 class="bls-title">{{ t('Waiting for you') }}</h3>
        <div v-for="role in attentions" :key="`att-${role.role}`" class="bls-att" :data-testid="`backlot-attention-${role.role}`">
          <span class="card-state blocked" aria-hidden="true"><i /></span>
          <div class="bls-att-text">
            <p class="bls-row-top"><b>{{ role.name }}</b><span v-if="role.attention_user" class="bl-tag">{{ t('USER') }}</span></p>
            <p class="bl-line">{{ role.attention }}</p>
            <p v-if="role.attention_detail" class="bl-line">{{ role.attention_detail }}</p>
          </div>
          <div class="bls-actions">
            <button v-if="role.attention === 'permission prompt'" type="button" class="mono-btn bl-btn" :disabled="studioLocked || !!busy" data-testid="backlot-allow" @click="approve(role, 'allow')">
              <UIcon name="i-lucide-check" />{{ t('Allow') }}
            </button>
            <button v-if="role.attention === 'permission prompt'" type="button" class="mono-btn bl-btn" :disabled="studioLocked || !!busy" data-testid="backlot-deny" @click="approve(role, 'deny')">
              <UIcon name="i-lucide-ban" />{{ t('Deny') }}
            </button>
            <button v-if="role.attention_seq != null" type="button" class="mono-btn bl-btn" :disabled="studioLocked || !!busy" data-testid="backlot-clear" @click="clearAttention(role)">
              <UIcon name="i-lucide-eraser" />{{ t('Clear') }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="roles.length" class="bls-block" data-testid="backlot-cast">
        <h3 class="bls-title">{{ t('Cast') }}</h3>
        <ul class="bls-list">
          <li v-for="role in roles" :key="role.role" class="bls-role" :data-testid="`backlot-role-${role.role}`">
            <button type="button" class="bls-role-main" :disabled="!paneOf(role)" @click="openRole(role)">
              <span class="card-state" :class="roleVisualState(role)" aria-hidden="true"><i /></span>
              <span class="bls-role-text">
                <span class="bls-row-top"><b>{{ role.name }}</b><span class="bl-meta">{{ role.role }}</span></span>
                <span v-if="role.runner || role.model || role.effort" class="bl-meta">{{ [role.runner, role.model, role.effort].filter(Boolean).join(' · ') }}</span>
                <span class="bl-meta">{{ t(STATE_LABEL[roleVisualState(role)]) }}<template v-if="role.task"> · {{ role.task }}</template></span>
                <span v-if="role.failed" class="bl-line error">{{ role.failed }}</span>
                <span v-else-if="role.doing" class="bl-line">{{ role.doing }}</span>
              </span>
            </button>
            <button type="button" class="mono-btn bl-btn" :disabled="studioLocked" :aria-expanded="tellRole === role.role" data-testid="backlot-role-tell" @click="tellRole = tellRole === role.role ? '' : role.role">
              <UIcon name="i-lucide-send" />{{ t('Tell') }}
            </button>
            <form v-if="tellRole === role.role" class="bls-tell" @submit.prevent="tell(role)">
              <input v-model="tellText" class="bl-input" :placeholder="tl(`Tell ${role.name}…`)" :aria-label="tl(`Tell ${role.name}…`)" maxlength="4000" :disabled="studioLocked">
              <button type="submit" class="mono-btn bl-btn" :disabled="studioLocked || !!busy || !tellText.trim()" data-testid="backlot-tell-send">{{ t('Send') }}</button>
            </form>
          </li>
        </ul>
      </section>

      <section v-if="tasks.length" class="bls-block" data-testid="backlot-tasks">
        <h3 class="bls-title">{{ t('Tasks') }}</h3>
        <ul class="bls-list">
          <li v-for="task in tasks" :key="task.id" class="bls-task" :data-testid="`backlot-task-${task.id}`">
            <p class="bl-meta"><b>{{ task.id }}</b><span>{{ task.status }}</span><span>{{ task.priority }}</span><span v-if="task.behind">{{ t('Behind') }}</span></p>
            <p class="bl-line">{{ task.title }}</p>
            <p v-if="task.actor_name" class="bl-meta"><span v-if="task.actor_role">{{ task.actor_role }}</span><span>{{ task.actor_name }}</span></p>
            <p v-if="task.latest_verdict || task.latest_delivery != null || task.latest_checks" class="bl-meta">
              <span v-if="task.latest_verdict">{{ task.latest_verdict }}</span>
              <span v-if="task.latest_checks">{{ task.latest_checks }}</span>
              <span v-if="task.latest_delivery != null">{{ task.latest_delivery }}</span>
            </p>
          </li>
        </ul>
      </section>

      <section v-if="cards.length" class="bls-block" data-testid="backlot-hollywood-cards">
        <h3 class="bls-title">{{ t('Hollywood cards') }}</h3>
        <ul class="bls-list">
          <li v-for="card in cards" :key="card.id" class="bls-card" :data-testid="`backlot-sheet-card-${card.id}`">
            <p class="bl-meta"><b>{{ card.id }}</b><span>{{ card.action }}</span></p>
            <p class="bl-line">{{ card.why }}</p>
            <div class="bls-actions">
              <button type="button" class="mono-btn bl-btn" :disabled="!!busy" data-testid="backlot-sheet-card-apply" @click="cardAction(card, 'card-apply')">
                <UIcon name="i-lucide-check" />{{ t('Apply') }}
              </button>
              <button type="button" class="mono-btn bl-btn" :disabled="!!busy" data-testid="backlot-sheet-card-cancel" @click="cardAction(card, 'card-cancel')">
                <UIcon name="i-lucide-ban" />{{ t('Cancel') }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <BacklotDesignDocSheet v-model:open="docOpen" :machine="machine" :studio="studio" :file="docFile" />
  </AppSheet>
</template>

<style scoped>
.bls { display: grid; gap: 14px; }
.bls-head { display: flex; gap: 10px; align-items: flex-start; }
.bls-head .card-state { margin-top: 3px; }
.bls-head-text { display: grid; gap: 4px; flex: 1; min-width: 0; }
.bls-head-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; }
.bls-head-line b { font: 600 16px/1.3 var(--display); }
.bls-head-line .bl-btn { margin-left: auto; }
.bl-machine { padding: 2px 5px; border: 1px solid var(--line); color: var(--muted); font: 500 9.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.bl-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 0; color: var(--muted); font: 400 11px/1.35 var(--mono); }
.bl-meta b { color: var(--text-2); }
.bl-line { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.bl-line.error, .bl-error { color: var(--blocked); }
.bl-error, .bl-note { margin: 0; font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.bl-note { color: var(--done); }
.bl-tag { padding: 1px 4px; border: 1px solid var(--blocked); color: var(--blocked); font: 600 9px/1.2 var(--mono); letter-spacing: .12em; }
.bl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; touch-action: manipulation; }
.bl-btn:hover:not(:disabled) { background: var(--surface-2); }
.bl-btn:disabled { color: var(--dim); cursor: progress; }
.bl-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bls-block { display: grid; gap: 8px; }
.bls-title { margin: 0; font: 500 10.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.bls-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); }
.bls-att { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-start; padding: 10px 12px; background: var(--surface); }
.bls-att + .bls-att, .bls-role + .bls-role, .bls-task + .bls-task, .bls-card + .bls-card { border-top: 1px solid var(--line-soft); }
.bls-att-text { display: grid; gap: 3px; flex: 1 1 12rem; min-width: 0; }
.bls-row-top { display: flex; align-items: center; gap: 8px; margin: 0; min-width: 0; }
.bls-row-top b { overflow: hidden; font: 600 14px/1.3 var(--display); text-overflow: ellipsis; white-space: nowrap; }
.bls-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.bls-role { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 8px 6px 6px; background: var(--surface); }
.bls-role-main { display: flex; flex: 1 1 12rem; gap: 10px; align-items: flex-start; min-width: 0; min-height: 44px; padding: 6px; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.bls-role-main:disabled { cursor: default; }
.bls-role-main:not(:disabled):hover { background: var(--surface-2); }
.bls-role-text { display: grid; gap: 3px; min-width: 0; }
.bls-tell { display: flex; flex-basis: 100%; gap: 6px; }
.bl-input { flex: 1 1 12rem; min-width: 0; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: 400 13px/1.4 var(--mono); }
.bl-input:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bls-task, .bls-card { display: grid; gap: 4px; padding: 10px 12px; background: var(--surface); }
</style>
