<script setup lang="ts">
// herdr-core, Claude: text sitting unsent in Claude's own input box, with
// Send now / Clear, and Send now for Claude's queue (see server/utils/coreDraft.ts).
import type { Pane } from '#shared/types'

const props = defineProps<{ pane: Pane }>()
const busy = ref<'send' | 'clear' | 'send-queued' | null>(null)

async function act(action: 'send' | 'clear' | 'send-queued') {
  if (busy.value) return
  busy.value = action
  try {
    const text = action === 'send-queued' ? {} : { text: props.pane.draft?.text || '' }
    const r = await api<{ started?: boolean }>('/api/draft', { pane_id: props.pane.id, action, ...text })
    if (action === 'send' && r.started === false) toast(t('Sent, but Claude has not started yet — check the terminal.'), true)
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
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
  <div v-if="pane.draft" class="msg-user-wrap unsent-input" data-testid="unsent-input">
    <UChatMessage
      id="unsent-input" role="user" side="right" variant="soft"
      :parts="[{ type: 'text', text: pane.draft.text }]"
      :ui="{ root: 'msg msg-user msg-pending queued', container: 'msg-c', content: 'msg-bubble queued' }"
    >
      <template #content>
        <span class="unsent-text">{{ pane.draft.text }}</span>
      </template>
    </UChatMessage>
    <div class="queued-tag failed" role="status">
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
