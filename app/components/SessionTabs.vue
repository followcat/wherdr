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
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 2px;
}
.session-tabs::-webkit-scrollbar { display: none; }
.session-tab {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  max-width: 150px;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 0;
  color: var(--muted);
  background: transparent;
  font: 500 10.5px/1 var(--mono);
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
}
.session-tab:hover { color: var(--text); background: var(--surface-2); }
.session-tab:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.session-tab.active {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.session-tab.offline { color: var(--dim); }
.session-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.session-waiting { display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; }
.state-square {
  width: 6px;
  height: 6px;
  display: inline-block;
  background: var(--blocked);
}
.rail {
  flex-direction: column;
  align-items: center;
  overflow-x: visible;
  overflow-y: auto;
  width: 100%;
  padding: 8px 0 0;
}
.rail .session-tab {
  width: 48px;
  max-width: 48px;
  min-height: 32px;
  justify-content: center;
  padding: 4px;
  font-size: 9px;
}
</style>
