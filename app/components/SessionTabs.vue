<script setup lang="ts">
const props = defineProps<{ rail?: boolean }>()
void props
const cls = computed(() => props.rail ? 'session-tabs rail' : 'session-tabs')
</script>

<template>
  <div v-if="sessionTabs.length > 1" :class="cls" role="tablist" data-testid="session-tabs" :aria-label="t('Sessions')">
    <button
      v-for="tab in sessionTabs"
      :key="tab.key || 'primary'"
      type="button"
      role="tab"
      class="session-tab"
      :class="{ active: tab.key === sessionTabPick, offline: tab.status !== 'online' }"
      :aria-selected="tab.key === sessionTabPick"
      :title="tab.name"
      @click="pickSessionTab(tab.key)"
    >
      <span class="session-name">{{ tab.name }}</span>
      <span v-if="tab.count" class="session-waiting"><span class="state-square blocked" aria-hidden="true" />{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.session-tabs {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 2px;
}
.session-tabs::-webkit-scrollbar { display: none; }
.session-tab {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
  max-width: 150px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: transparent;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.session-tab.active {
  color: var(--fg);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.session-name { overflow: hidden; text-overflow: ellipsis; }
.session-waiting { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.state-square {
  width: 8px;
  height: 8px;
  display: inline-block;
  border-radius: 1px;
  background: var(--warn);
}
.rail {
  flex-direction: column;
  overflow-x: visible;
  overflow-y: auto;
  width: 100%;
  padding: 0;
}
.rail .session-tab {
  width: 100%;
  max-width: none;
  min-height: 32px;
  justify-content: center;
  padding: 4px 6px;
  font-size: 12px;
}
</style>
