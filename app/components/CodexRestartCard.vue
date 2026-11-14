<script setup lang="ts">
// Codex exited after updating itself: its space stays open, and this card
// starts it again in the same terminal, on the same conversation or a new one
// (server/api/codex-restart.post.ts).
const props = defineProps<{ paneId: string }>()
const busy = ref<'resume' | 'fresh' | null>(null)

async function restart(how: 'resume' | 'fresh') {
  if (busy.value) return
  busy.value = how
  try {
    await api('/api/codex-restart', { pane_id: props.paneId, how })
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="choices codex-restart" data-testid="codex-restart">
    <p class="eyebrow choices-eyebrow"><i />{{ t('Your turn') }}</p>
    <p class="choices-q">{{ tl('Codex updated itself and exited. Restart it to go on.') }}</p>
    <div class="codex-restart-actions">
      <UButton color="primary" icon="i-lucide-history" :loading="busy === 'resume'" :disabled="Boolean(busy)" data-testid="codex-restart-resume" @click="restart('resume')">
        {{ tl('Resume conversation') }}
      </UButton>
      <UButton color="neutral" variant="outline" icon="i-lucide-plus" :loading="busy === 'fresh'" :disabled="Boolean(busy)" data-testid="codex-restart-fresh" @click="restart('fresh')">
        {{ tl('Start fresh') }}
      </UButton>
    </div>
  </div>
</template>

<style scoped>
.codex-restart { margin-top: 12px; }
.codex-restart-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
