<script setup lang="ts">
// A Settings preview folded under the controls it illustrates: closed by
// default, "Show me" opens it, "Hide" closes it. The content mounts on
// opening (UCollapsible unmounts it when hidden), so an animated preview
// plays once each time it opens. The state is not remembered.
const open = ref(false)
</script>

<template>
  <UCollapsible v-model:open="open" class="settings-preview" :ui="{ content: 'settings-preview-fold' }">
    <button type="button" class="settings-preview-toggle" data-testid="settings-preview-toggle">
      <UIcon name="i-lucide-chevron-down" class="settings-preview-chevron" :class="{ open }" />
      {{ open ? t('Hide') : t('Show me') }}
    </button>
    <template #content>
      <slot />
    </template>
  </UCollapsible>
</template>

<style scoped>
.settings-preview { margin-top: 6px; }
.settings-preview-toggle {
  display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 2px;
  border: 0; background: none; color: var(--muted); font: 500 12px/1 var(--mono); cursor: pointer;
}
.settings-preview-toggle:hover { color: var(--text-2); }
.settings-preview-chevron { width: 14px; height: 14px; transition: transform .2s; }
.settings-preview-chevron.open { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) {
  .settings-preview-chevron { transition: none; }
  :deep(.settings-preview-fold) { animation: none !important; }
}
</style>
