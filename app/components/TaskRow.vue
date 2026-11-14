<script setup lang="ts">
// A task as one row: its key badge, title, short action and what to do (or
// where it stands). The sidebar's Tasks to handle and a chat's `task <ID>`
// block (ChatTaskCard.vue) show the same row. `turn`: the task waits for the
// user, its action in the Your turn colour.
import type { ToHandle } from '#shared/pm/board'

defineProps<{ row: Pick<ToHandle, 'shown' | 'color' | 'title' | 'action' | 'label'>, turn?: boolean }>()
</script>

<template>
  <button type="button" class="handle-row" :title="row.action">
    <span class="handle-head">
      <ProjectBadge :text="row.shown" :color="row.color" />
      <b class="handle-title">{{ row.title }}</b>
      <small class="handle-label mono-label" :class="{ turn }">{{ t(row.label) }}</small>
    </span>
    <small class="handle-action">{{ t(row.action) }}</small>
  </button>
</template>

<style scoped>
.handle-row { flex: 1; min-width: 0; display: grid; gap: 2px; min-height: 48px; padding: 8px 12px; border: 0; background: none; color: var(--text); text-align: left; cursor: pointer; }
.handle-row:hover { background: var(--surface-2); }
.handle-row:focus-visible { outline: 1px solid var(--mauve); outline-offset: -1px; }
.handle-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.handle-title { flex: 1; min-width: 0; overflow: hidden; font: 600 14px/1.3 var(--display); text-overflow: ellipsis; white-space: nowrap; }
/* A long step label (a custom button text) shrinks to half the row and ellipsizes. */
.handle-label { flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.handle-label.turn { color: var(--blocked); }
.handle-action { overflow: hidden; color: var(--muted); font: 12px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
</style>
