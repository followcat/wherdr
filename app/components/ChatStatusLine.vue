<script setup lang="ts">
// The agent's live line under the conversation ("✻ Orbiting…", omp's step,
// "Waiting for your reply"). It reads the line itself through `get`, so a new
// verb on each push re-renders this line and not every message above it.
type ChatStatus = { typing: boolean, text: string, verb?: boolean, omp?: boolean, since?: number | null, error?: boolean }
const props = defineProps<{ get: () => ChatStatus | null }>()
const status = computed(() => props.get())
</script>

<template>
  <div v-if="status" class="chat-status" :class="{ typing: status.typing, waiting: !status.typing }">
    <!-- Claude's verb and omp's step have their own spinner: no extra state dot. -->
    <span v-if="status.verb" class="claude-verb-line"><ClaudeSpinner /><UChatShimmer :text="status.text" :duration="2.4" class="claude-verb" /></span>
    <span v-else-if="status.omp" class="omp-step-line"><OmpSpinner :since="status.since"><UChatShimmer :text="status.text" :duration="2.4" class="omp-step" /></OmpSpinner></span>
    <template v-else>
      <i class="status-dot" />
      <UChatShimmer v-if="status.typing" :text="status.text" :duration="2.4" />
      <span v-else>{{ status.text }}</span>
    </template>
  </div>
</template>
