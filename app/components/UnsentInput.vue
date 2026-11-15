<script setup lang="ts">
// herdr-core, Claude: text sitting unsent in Claude's own input box, with
// Send now / Clear, and Send now for Claude's queue (see server/utils/coreDraft.ts).
import type { Pane } from '#shared/types'

// `shown`: the field holds a message the conversation already shows as
// waiting there: no second bubble, only its actions.
const props = defineProps<{ pane: Pane, shown?: boolean }>()
const busy = ref<'send' | 'clear' | 'send-queued' | null>(null)
// Why the last send failed, shown under the row until the next try.
const error = ref<string | null>(null)
// The row an action is about: Send now stays loading until it leaves.
const rowOf = (a: string) => (a === 'send-queued' ? props.pane.queueSendNow : props.pane.draft?.text)
let left: (() => void) | null = null
watch(() => [props.pane.queueSendNow, props.pane.draft?.text], () => left?.())

async function act(action: 'send' | 'clear' | 'send-queued') {
  if (busy.value) return
  busy.value = action
  error.value = null
  try {
    const text = action === 'send-queued' ? {} : { text: props.pane.draft?.text || '' }
    const before = rowOf(action)
    const r = await api<{ started?: boolean }>('/api/draft', { pane_id: props.pane.id, action, ...text })
    if (action === 'send' && r.started === false) toast(t('Sent, but Claude has not started yet — check the terminal.'), true)
    // Sent: wait for the next screen to drop the row (at most 5 s).
    if (action !== 'clear' && rowOf(action) === before) await new Promise<void>((done) => { left = done; setTimeout(done, 5000) })
  } catch (err) {
    const why = (err as Error).message.replace(/[\s.—-]*check the (current screen|terminal)\.?$/i, '').replace(/\.$/, '')
    if (action === 'clear') toast((err as Error).message, true)
    else error.value = tl(`Not sent: ${why}. Try again`)
  } finally {
    left = null
    busy.value = null
  }
}
const icon = (a: typeof busy.value, idle: string) => (busy.value === a ? 'i-lucide-loader-circle' : idle)
</script>

<template>
  <div v-if="pane.queueSendNow && !pane.draft" class="queued-tag unsent-actions">
    <button type="button" class="queued-cancel" data-testid="queue-send-now" :disabled="Boolean(busy)" @click="act('send-queued')">
      <UIcon :name="icon('send-queued', 'i-lucide-send')" :class="{ spin: busy === 'send-queued' }" />{{ t('Send now') }}
    </button>
  </div>
  <div v-if="error && pane.queueSendNow && !pane.draft" class="queued-tag failed" role="alert" data-testid="send-error">
    <UIcon name="i-lucide-circle-alert" /><span>{{ error }}</span>
  </div>
  <div v-if="pane.draft" class="msg-user-wrap unsent-input" data-testid="unsent-input">
    <UChatMessage
      v-if="!shown"
      id="unsent-input" role="user" side="right" variant="soft"
      :parts="[{ type: 'text', text: pane.draft.text }]"
      :ui="{ root: 'msg msg-user msg-pending queued', container: 'msg-c', content: 'msg-bubble queued' }"
    >
      <template #content>
        <span class="unsent-text">{{ pane.draft.text }}</span>
      </template>
    </UChatMessage>
    <div v-if="error" class="queued-tag failed" role="alert" data-testid="send-error">
      <UIcon name="i-lucide-circle-alert" /><span>{{ error }}</span>
    </div>
    <div v-else-if="!shown" class="queued-tag failed" role="status">
      <UIcon name="i-lucide-circle-alert" /><span>{{ t('Not sent — still in Claude’s input') }}</span>
    </div>
    <div class="queued-tag unsent-actions">
      <button type="button" class="queued-cancel" :disabled="Boolean(busy)" @click="act('send')">
        <UIcon :name="icon('send', 'i-lucide-send')" :class="{ spin: busy === 'send' }" />{{ t('Send now') }}
      </button>
      <button type="button" class="queued-cancel" :disabled="Boolean(busy)" @click="act('clear')">
        <UIcon :name="icon('clear', 'i-lucide-eraser')" :class="{ spin: busy === 'clear' }" />{{ t('Clear') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.unsent-text { white-space: pre-wrap; overflow-wrap: anywhere; }
/* Room for the phone's terminal-keys toggle, which floats over the conversation's last lines. */
@media (max-width: 700px) { .unsent-actions { margin-bottom: 44px; } }
</style>
