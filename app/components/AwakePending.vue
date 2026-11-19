<script setup lang="ts">
// Home's keep-awake feedback: its menu closes on a tap, so a pill with a loader
// says what is under way (the machine's read, then a choice being applied).
const pending = computed(() => Object.values(awakeBusy.value).map(b => b.what === 'read'
  ? (b.label ? tl(`Asking ${b.label}…`) : t('Asking this machine…'))
  : (b.label ? tl(`Applying keep awake on ${b.label}…`) : t('Applying keep awake…'))))
</script>

<template>
  <div v-if="pending.length" class="awake-pending" role="status" data-testid="awake-pending">
    <UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ pending.join(' · ') }}
  </div>
</template>

<style scoped>
.awake-pending {
  position: fixed; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 60;
  display: flex; align-items: center; gap: 6px; max-width: calc(100vw - 32px);
  padding: 6px 12px; border-radius: 999px; background: var(--surface-2); color: var(--text-2);
  box-shadow: 0 2px 10px rgb(0 0 0 / .18); font-size: 13px;
}
</style>
