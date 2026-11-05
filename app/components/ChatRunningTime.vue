<script setup lang="ts">
// "Running · 12 s" under a "!" command the agent runs: its own one-second
// clock, so the tick re-renders this line and not the whole conversation.
const props = defineProps<{ since: number | null | undefined }>()
const now = useSecondClock()
const duration = computed(() => {
  if (!props.since) return null
  const s = Math.max(0, Math.round((now.value - props.since) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
})
</script>

<template>
  <span>{{ t('Running') }}<template v-if="duration"> · {{ duration }}</template></span>
</template>
