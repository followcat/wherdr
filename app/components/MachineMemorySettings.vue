<script setup lang="ts">
// Settings › Pace: each machine's memory and agents at once (all projects), and
// whether automatic starts may go there now. Its settings are on the machine
// cards of Settings › Machines.
onMounted(loadMemory)
</script>

<template>
  <div class="settings-card memory-card" data-testid="machine-memory">
    <div v-for="r in memoryRows ?? []" :key="r.key" class="memory-row">
      <span class="memory-head"><b>{{ r.label }}</b><span class="mono-label" :class="{ wait: r.short }" data-testid="memory-line">{{ r.line }}</span></span>
    </div>
    <p v-if="memoryError" class="form-error" role="alert">{{ memoryError }}</p>
    <p class="muted settings-hint">{{ memoryHint() }}</p>
  </div>
</template>

<style scoped>
.memory-card { padding: 0 16px; margin-top: 12px; }
.memory-row { padding: 13px 0; border-bottom: 1px solid var(--line); }
.memory-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; justify-content: space-between; }
.memory-head .mono-label { color: var(--green); overflow-wrap: anywhere; }
.memory-head .mono-label.wait { color: var(--ochre); }
.memory-card .settings-hint { padding: 12px 0; margin: 0; }
</style>
