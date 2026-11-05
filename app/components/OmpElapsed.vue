<script setup lang="ts">
// Time since `since`, written like omp's activity line ("47s", "2m 5s"),
// updated once a second.
import { ompElapsed } from '~/utils/ompSpinner'

const props = defineProps<{ since: number }>()
const now = useSecondClock()
</script>

<template>
  <span>{{ ompElapsed(props.since, now) }}</span>
</template>
