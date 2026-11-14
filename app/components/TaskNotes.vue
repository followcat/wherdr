<script setup lang="ts">
// The worker's and the reviewer's notes in To do, full width: one above the
// other on a wide sheet; on the phone, Worker / Reviewer tabs above one note.
const props = defineProps<{ worker?: string, review?: string }>()
const both = computed(() => !!props.worker && !!props.review)
const shown = ref<'worker' | 'review'>('worker')
</script>

<template>
  <div class="task-notes" :class="{ both }" :data-shown="shown" data-testid="todo-notes">
    <div v-if="both" class="segmented task-notes-tabs" role="tablist" :aria-label="tl('Notes')" style="--segment-count: 2">
      <button type="button" role="tab" :class="{ on: shown === 'worker' }" :aria-selected="shown === 'worker'" data-note="worker" @click="shown = 'worker'">{{ tl('Worker') }}</button>
      <button type="button" role="tab" :class="{ on: shown === 'review' }" :aria-selected="shown === 'review'" data-note="review" @click="shown = 'review'">{{ tl('Reviewer') }}</button>
    </div>
    <TaskNote v-if="worker" class="note-worker" :label="tl('Worker\'s note')" :text="worker" data-testid="todo-worker-note" />
    <TaskNote v-if="review" class="note-review" :label="tl('Reviewer\'s note')" :text="review" data-testid="todo-review-note" />
  </div>
</template>

<style scoped>
.task-notes { display: grid; gap: 8px; }
/* The tabs only on the phone; above it both notes show, stacked. */
.task-notes-tabs { display: none; }
@media (max-width: 699px) {
  .task-notes.both { gap: 0; }
  .task-notes.both .task-notes-tabs { display: grid; }
  .task-notes-tabs button { padding: 9px 6px 8px; }
  .task-notes.both :deep(.task-note) { border-top: 0; }
  .task-notes.both :deep(.task-note > .mono-label) { display: none; }
  .task-notes.both[data-shown='worker'] .note-review,
  .task-notes.both[data-shown='review'] .note-worker { display: none; }
}
</style>
