<script setup lang="ts">
// The step's own button (Merge, Approve screenshots, Deployed…) of a task
// waiting for the user: first in the task sheet's header, in the To do tab
// elsewhere (Tasks to review). Loading while it runs or while an approved merge
// goes on by itself; disabled while it waits on something else (mergeWaits),
// Merging then. What it waits for is said under it, in the To do tab.
import { mayAccept, mergeGoesNow, mergeStuck, mergeWaits, type Card } from '#shared/pm/board'

const props = defineProps<{ card: Card, busy: boolean, loading: boolean }>()
const emit = defineEmits<{ press: [] }>()
const waits = computed(() => mergeWaits(props.card))
const stuck = computed(() => mergeStuck(props.card))
const goes = computed(() => !stuck.value && mergeGoesNow(props.card))
const open = computed(() => mayAccept(props.card))
</script>

<template>
  <UButton color="primary" size="xl" :loading="loading || goes" :disabled="busy || (!open && (!!stuck || (waits !== undefined && !goes)))" data-testid="step-user" @click="emit('press')">{{ waits !== undefined && !stuck ? tl('Merging') : card.userLabel }}</UButton>
</template>
