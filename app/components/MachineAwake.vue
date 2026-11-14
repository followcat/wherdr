<script setup lang="ts">
// A machine card's keep-awake line (Settings › Machines): "Awake until 18:00" or
// "Awake until turned off", and a laptop's battery/lid warning. Read on show.
import { awakeWarning } from '#shared/awake'
const props = defineProps<{ machineKey: string, online: boolean }>()
const state = computed(() => props.online ? awakeByMachine.value[props.machineKey] : undefined)
watch(() => props.online, (on) => { if (on) refreshAwake(props.machineKey) }, { immediate: true })
</script>

<template>
  <small v-if="awakeLabel(state)" class="machine-awake" data-testid="machine-awake"><UIcon name="i-lucide-sun" />{{ awakeLabel(state) }}</small>
  <small v-if="awakeWarning(state)" class="machine-awake-warn" data-testid="machine-awake-warn"><UIcon name="i-lucide-battery-warning" />{{ t(awakeWarning(state)) }}</small>
</template>

<style scoped>
small { display: flex; align-items: center; gap: 4px; }
.machine-awake { color: var(--text-2); }
.machine-awake-warn { color: var(--blocked); }
</style>
