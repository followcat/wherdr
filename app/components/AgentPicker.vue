<script setup lang="ts">
// One tile per program, in the order of Settings › Agents (the caller passes
// offerAgents() or offerCoordinators()). Program names only: each agent runs
// with its harness's default model.
defineProps<{ programs: readonly string[] }>()
const picked = defineModel<string>({ required: true })
</script>

<template>
  <div class="segmented agent-picker" role="radiogroup" :aria-label="tl('Agent', 'Agent')" :style="{ '--segment-count': programs.length }" data-testid="agent-picker">
    <button
      v-for="p in programs" :key="p" type="button" role="radio" :class="{ on: p === picked }"
      :aria-checked="p === picked" :data-agent="p" @click="picked = p"
    >
      <AgentAvatar :agent="p" /><span>{{ kindLabel(p) }}</span>
    </button>
  </div>
</template>

<style scoped>
.agent-picker button { text-transform: none; letter-spacing: .02em; }
</style>
