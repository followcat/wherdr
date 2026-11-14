<script setup lang="ts">
// What an agent showed with `ui show` (shared/uiShow.ts), as a card: above the
// message field when there is no room beside the conversation, and kept in its
// reply (ChatMarkdown.vue, no ×). A tap shows it (UiShowPanel.vue).
import { showLabel, type UiShowEvent } from '#shared/uiShow'

const props = defineProps<{ event: UiShowEvent, kept?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const icon = computed(() => (props.event.what === 'shots' ? 'i-lucide-images' : 'i-lucide-file-text'))
function open() {
  // A kept card names no conversation: the one it is read in.
  uiShown.value = { ...props.event, pane: props.event.pane || curPane.value || '' }
  emit('close')
}
</script>

<template>
  <div class="ui-open-card" role="status" data-testid="ui-show-card">
    <button type="button" class="ui-open-main" @click="open">
      <span class="ui-open-by">{{ event.by ? tl(`Shown by ${event.by}`) : event.what === 'shots' ? t('Screenshots') : t('File') }}</span>
      <span class="ui-open-place"><UIcon :name="icon" /><span class="ui-show-name">{{ showLabel(event) }}</span></span>
    </button>
    <button v-if="!kept" type="button" class="ui-open-x" :aria-label="t('Close')" :title="t('Close')" @click="emit('close')">
      <UIcon name="i-lucide-x" />
    </button>
  </div>
</template>

<style scoped>
.ui-show-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
