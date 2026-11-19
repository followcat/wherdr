<script setup lang="ts">
// A workspace's or a member's counts on the sidebar (CoordinatorsSection.vue):
// "2 working · 1 waiting for you", nothing when zero. "n waiting for you" is a
// link: `open` with the waiting tasks' ids (the row decides where it leads).
import type { WorkCounts } from '#shared/pm/coordinator'

defineProps<{ counts: WorkCounts }>()
defineEmits<{ open: [ids: string[]] }>()
</script>

<template>
  <small v-if="counts.working || counts.waiting.length" class="work-counts" data-testid="workspace-counts">
    <span v-if="counts.working">{{ tl(`${counts.working} working`) }}</span>
    <template v-if="counts.working && counts.waiting.length"> · </template>
    <button v-if="counts.waiting.length" type="button" class="work-waiting" data-testid="workspace-waiting" @click.stop="$emit('open', counts.waiting)">{{ tl(`${counts.waiting.length} waiting for you`) }}</button>
  </small>
</template>

<style scoped>
.work-counts { color: var(--muted); font: 12px/1.4 var(--mono); white-space: nowrap; }
.work-waiting { position: relative; padding: 0; border: 0; background: none; color: var(--blocked); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
/* A 44 px high hit area around the short text. */
.work-waiting::after { content: ''; position: absolute; inset: -14px -6px; }
.work-waiting:hover { color: var(--text); }
.work-waiting:focus-visible { outline: 1px solid var(--mauve); outline-offset: 2px; }
</style>
