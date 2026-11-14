<script setup lang="ts">
// A `task <ID>` line of a `wherdr` block in a chat (utils/markdown.ts): the
// sidebar's task row, live from the board, so it shows where the task stands
// now, whatever the message said. A tap opens the task's sheet over the chat.
import { taskRow } from '#shared/pm/board'

const props = defineProps<{ id: string }>()
const card = useBoardCard(() => props.id)
const row = computed(() => (card.value ? taskRow(card.value) : null))
</script>

<template>
  <div class="chat-task" :data-task="id">
    <TaskRow v-if="row" :row="row" :turn="!!card?.yourTurn" @click="openTaskSheet(card!.id)" />
    <p v-else class="chat-task-missing mono-label">{{ id }} · {{ card === null ? tl('Not on the board') : tl('Loading…') }}</p>
  </div>
</template>

<style scoped>
.chat-task { display: flex; min-width: 0; margin: 6px 0; border: 1px solid var(--line); background: var(--surface); }
.chat-task-missing { margin: 0; padding: 14px 12px; color: var(--muted); font-size: 11px; }
</style>
