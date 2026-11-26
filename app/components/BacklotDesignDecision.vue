<script setup lang="ts">
// Opening design decision block, quiet status line, and upgrade banner shared
// between the studio card (BacklotSection) and studio sheet (BacklotStudioSheet).
import type { BacklotAction, BacklotMachineView, BacklotStudio } from '#shared/backlot'
import { backlotActionTarget, designFrozenDoc, designQuietStatus } from '#shared/backlot'
import { runBacklotAction } from '~/composables/useBacklot'

const props = defineProps<{
  machine: BacklotMachineView
  studio: BacklotStudio
  externalReply?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  read: [file: string]
  reply: []
  acted: [result: { ok: boolean, text: string }]
}>()

const design = computed(() => props.studio.design ?? null)
const phase = computed(() => design.value?.phase ?? null)
const isDecision = computed(() => (phase.value === 'waiting_user' || phase.value === 'suggest_skip') && props.studio.state !== 'finished')
const quietLine = computed(() => (isDecision.value ? null : designQuietStatus(design.value)))
const frozenDoc = computed(() => (design.value ? designFrozenDoc(design.value) : ''))
const sourceDoc = computed(() => (design.value?.doc_file || (design.value ? `design/v${design.value.version}.md` : '')))
const locked = computed(() => Boolean(props.disabled || props.studio.needs_upgrade))

const busy = ref('')
const feedback = ref<{ ok: boolean, text: string } | null>(null)
const confirmMode = ref<'approve' | 'skip' | null>(null)
const confirmExtra = ref('')
const replyOpen = ref(false)
const replyText = ref('')

const confirmPrompt = computed(() => {
  if (confirmMode.value === 'approve') {
    return tl(`Sign off in approved mode? This freezes ${frozenDoc.value}.`)
  }
  if (confirmMode.value === 'skip') {
    return tl(`Skip opening design in skipped mode? This closes ${sourceDoc.value} without freezing ${frozenDoc.value}.`)
  }
  return ''
})

async function run(key: string, action: BacklotAction) {
  if (locked.value || busy.value) return false
  busy.value = key
  feedback.value = null
  try {
    const r = await runBacklotAction(action)
    const msg = r.ok ? (r.output || t('Done')) : (r.error || t('Failed'))
    feedback.value = { ok: r.ok, text: msg }
    emit('acted', { ok: r.ok, text: msg })
    return r.ok
  } catch (e) {
    const msg = (e as Error).message
    feedback.value = { ok: false, text: msg }
    emit('acted', { ok: false, text: msg })
    return false
  } finally {
    busy.value = ''
  }
}

function openConfirm(mode: 'approve' | 'skip') {
  if (locked.value) return
  confirmMode.value = mode
  confirmExtra.value = ''
}

function cancelConfirm() {
  confirmMode.value = null
  confirmExtra.value = ''
}

async function submitConfirm() {
  if (!confirmMode.value || locked.value) return
  const skip = confirmMode.value === 'skip'
  const extra = confirmExtra.value.trim()
  const ok = await run('design-sign', {
    kind: 'design-sign',
    ...backlotActionTarget(props.machine),
    studio: props.studio.id,
    skip,
    ...(skip && extra ? { reason: extra } : {}),
    ...(!skip && extra ? { note: extra } : {}),
  })
  if (ok) cancelConfirm()
}

async function discuss() {
  await run('design-open', {
    kind: 'design-open',
    ...backlotActionTarget(props.machine),
    studio: props.studio.id,
  })
}

function onReply() {
  if (locked.value) return
  if (props.externalReply) {
    emit('reply')
    return
  }
  replyOpen.value = !replyOpen.value
  if (replyOpen.value) replyText.value = ''
}

async function sendReply() {
  const text = replyText.value.trim()
  if (!text || locked.value) return
  const ok = await run('reply', {
    kind: 'tell',
    ...backlotActionTarget(props.machine),
    studio: props.studio.id,
    role: 'producer',
    text,
  })
  if (ok) {
    replyText.value = ''
    replyOpen.value = false
  }
}

watch(() => [props.machine.session, props.machine.machine, props.studio.id, props.studio.design?.phase, props.studio.design?.round], () => {
  confirmMode.value = null
  confirmExtra.value = ''
  replyOpen.value = false
  replyText.value = ''
  feedback.value = null
})
</script>

<template>
  <div v-if="studio.needs_upgrade || isDecision || quietLine" class="bld-wrap" @click.stop>
    <div v-if="studio.needs_upgrade" class="bld-upgrade" role="status" data-testid="backlot-upgrade-banner">
      <span class="card-state blocked" aria-hidden="true"><i /></span>
      <span class="bld-upgrade-text">
        <b>{{ t('Upgrade backlot') }}</b>
        <span v-if="studio.unknown_kinds?.length" class="bl-meta">{{ studio.unknown_kinds.join(', ') }}</span>
      </span>
    </div>

    <div v-if="isDecision && design" class="bld-card" data-testid="backlot-design-decision">
      <div class="bld-head">
        <span class="bld-badge">{{ phase === 'suggest_skip' ? t('Skip suggested') : tl(`Design · R${design.round}`) }}</span>
        <span v-if="design.doc_file" class="bl-meta">{{ design.doc_file }}</span>
      </div>

      <p v-if="phase === 'suggest_skip' && design.skip_reason" class="bl-line">{{ design.skip_reason }}</p>
      <p v-else-if="design.summary" class="bl-line" data-testid="backlot-design-summary">{{ design.summary }}</p>

      <ul v-if="design.questions.length" class="bld-qs">
        <li v-for="q in design.questions" :key="q.id" class="bld-q" data-testid="backlot-design-question">
          <p class="bld-q-prompt"><b>{{ q.id }}</b> {{ q.prompt }}</p>
          <p class="bl-meta">
            <span>{{ tl(`Recommendation: ${q.recommendation}`) }}</span>
            <span v-if="q.section_ref" class="bld-ref">{{ q.section_ref }}</span>
          </p>
        </li>
      </ul>

      <div class="bld-actions" data-testid="backlot-design-actions">
        <template v-if="phase === 'waiting_user'">
          <button v-if="design.doc_file" type="button" class="mono-btn bl-btn" :disabled="locked || !!busy" data-testid="backlot-design-read" @click="emit('read', design.doc_file)">
            <UIcon name="i-lucide-file-text" />{{ t('Read') }}
          </button>
          <button type="button" class="mono-btn bl-btn" :disabled="locked || !!busy" data-testid="backlot-design-reply" @click="onReply">
            <UIcon name="i-lucide-reply" />{{ t('Reply') }}
          </button>
          <button type="button" class="mono-btn bl-btn" :disabled="locked || !!busy" data-testid="backlot-design-sign" @click="openConfirm('approve')">
            <UIcon name="i-lucide-check" />{{ t('Sign off') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="mono-btn bl-btn" :disabled="locked || !!busy" data-testid="backlot-design-skip" @click="openConfirm('skip')">
            <UIcon name="i-lucide-fast-forward" />{{ t('Skip') }}
          </button>
          <button type="button" class="mono-btn bl-btn" :disabled="locked || !!busy" data-testid="backlot-design-discuss" @click="discuss">
            <UIcon name="i-lucide-message-square" />{{ t('Discuss') }}
          </button>
        </template>
      </div>

      <div v-if="confirmMode" class="bld-confirm" data-testid="backlot-design-confirm">
        <p class="bl-line">{{ confirmPrompt }}</p>
        <input
          v-model="confirmExtra" class="bl-input" maxlength="4000"
          :placeholder="confirmMode === 'skip' ? t('Reason (optional)') : t('Note (optional)')"
          :aria-label="confirmMode === 'skip' ? t('Reason (optional)') : t('Note (optional)')"
        >
        <div class="bld-actions">
          <button type="button" class="mono-btn bl-btn" :disabled="!!busy" data-testid="backlot-design-confirm-cancel" @click="cancelConfirm">
            {{ t('Cancel') }}
          </button>
          <button type="button" class="mono-btn bl-btn bld-primary" :disabled="locked || !!busy" data-testid="backlot-design-confirm-submit" @click="submitConfirm">
            {{ confirmMode === 'skip' ? t('Confirm skip') : t('Confirm sign off') }}
          </button>
        </div>
      </div>

      <form v-if="replyOpen && !externalReply" class="bl-tell" data-testid="backlot-design-reply-form" @submit.prevent="sendReply">
        <input v-model="replyText" class="bl-input" :placeholder="t('Reply to producer…')" :aria-label="t('Reply to producer…')" maxlength="4000" :disabled="locked">
        <button type="submit" class="mono-btn bl-btn" :disabled="locked || !!busy || !replyText.trim()" data-testid="backlot-design-reply-send">
          {{ t('Send') }}
        </button>
      </form>

      <p v-if="feedback" :class="feedback.ok ? 'bl-note' : 'bl-error'" :role="feedback.ok ? 'status' : 'alert'">{{ feedback.text }}</p>
    </div>

    <p v-else-if="quietLine" class="bl-meta bld-quiet" data-testid="backlot-design-status">{{ quietLine }}</p>
  </div>
</template>

<style scoped>
.bld-wrap { display: grid; gap: 6px; min-width: 0; }
.bld-upgrade { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--blocked); background: var(--bg); color: var(--text); font: 400 12px/1.35 var(--mono); min-width: 0; }
.bld-upgrade-text { display: flex; flex-wrap: wrap; gap: 4px 10px; min-width: 0; overflow-wrap: anywhere; }
.bld-upgrade-text b { color: var(--blocked); }
.bld-card { display: grid; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-left: 2px solid var(--accent); background: var(--bg); min-width: 0; }
.bld-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.bld-badge { font: 600 10px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.bl-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 0; color: var(--muted); font: 400 11px/1.35 var(--mono); min-width: 0; overflow-wrap: anywhere; }
.bl-line { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.bld-qs { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.bld-q { display: grid; gap: 2px; padding-top: 6px; border-top: 1px solid var(--line-soft); min-width: 0; }
.bld-q-prompt { margin: 0; color: var(--text); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.bld-q-prompt b { margin-right: 4px; color: var(--accent); font: 600 11px/1.2 var(--mono); }
.bld-ref { color: var(--text-2); }
.bld-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.bl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; touch-action: manipulation; }
.bl-btn:hover:not(:disabled) { background: var(--surface-2); }
.bl-btn:disabled { color: var(--dim); cursor: default; }
.bl-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bld-primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.bld-primary:hover:not(:disabled) { background: var(--accent); opacity: .9; }
.bld-confirm { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line); background: var(--surface); min-width: 0; }
.bl-tell { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.bl-input { flex: 1 1 12rem; min-width: 0; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: 400 13px/1.4 var(--mono); }
.bl-input:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bl-error { margin: 0; color: var(--blocked); font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.bl-note { margin: 0; color: var(--done); font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.bld-quiet { color: var(--muted); }
</style>
