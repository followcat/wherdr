<script setup lang="ts">
// Why a task the user approved is back to review, on top of Tasks to review
// and of the task sheet's To do: the worker's reason when it gave one (a task
// it names opens), else what the engine knows (files and commits).
import type { LookAgain } from '#shared/pm/steps'

const props = defineProps<{ look: LookAgain }>()
const TASK = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/
// The reason in pieces: text, and the ids of tasks it names.
const parts = computed(() => ` ${props.look.reason ?? props.look.why}`.split(TASK).map((text, i) => ({ text, task: i % 2 === 1 })))
</script>

<template>
  <div class="look-again" role="status" data-testid="look-again">
    <p class="look-again-why">
      <b>{{ tl('Back to review because') }}:</b>
      <template v-for="(p, i) in parts" :key="i">
        <button v-if="p.task" type="button" class="look-again-task" data-testid="look-again-task" @click="openTaskSheet(p.text)">{{ p.text }}</button>
        <template v-else>{{ p.text }}</template>
      </template>
    </p>
    <p class="muted">{{ look.reason ? tl('See the new screenshots before you approve.') : tl('The agent has not said why yet: this is what wherdr saw.') }}</p>
  </div>
</template>

<style scoped>
.look-again { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--blocked); background: var(--surface); }
.look-again-why { overflow-wrap: anywhere; }
.look-again-task { padding: 0; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
