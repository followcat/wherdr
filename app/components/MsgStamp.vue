<script setup lang="ts">
// A message's time, muted: the full date and time on hover (desktop) or on tap (phone).
const props = defineProps<{ ts: string }>()
const full = ref(false)
const label = computed(() => (full.value ? fmtDateTime(props.ts) : fmtStamp(props.ts)))
</script>

<template>
  <button type="button" class="msg-time msg-stamp" :title="fmtDateTime(ts)" :aria-label="fmtDateTime(ts)" @click="full = !full">{{ label }}</button>
</template>
