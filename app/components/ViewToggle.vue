<script setup lang="ts">
import { t } from '~/utils/i18n'
import { shortcutKbds } from '~/utils/shortcuts'

const props = defineProps<{ mode: 'chat' | 'term' | null }>()
const emit = defineEmits<{ toggle: [] }>()
const action = computed(() => props.mode === 'term' ? t('Show conversation') : t('Show terminal'))
</script>

<template>
  <UTooltip :text="action" :kbds="shortcutKbds('toggle-term')">
    <UButton
      color="neutral" variant="outline" size="sm" class="view-toggle mono-btn"
      :icon="mode === 'term' ? 'i-lucide-message-square' : 'i-lucide-square-terminal'"
      :aria-label="action" @click="emit('toggle')"
    >
      <span class="view-toggle-label">{{ mode === 'term' ? t('Conversation') : t('Terminal') }}</span>
    </UButton>
  </UTooltip>
</template>
