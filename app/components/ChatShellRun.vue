<script setup lang="ts">
// A "!" (or omp "$") command the user ran, drawn as omp draws its actions: a
// console "! · You ran" with the command, the elapsed time and omp's working
// ring while it runs (its output so far underneath), then its run time, exit
// status and output folded (OmpTool). The same card while it runs (ChatView's
// live card, before the transcript has it) and once the transcript has it, so
// nothing changes but its state when it lands. Its ring and "!" take the
// conversation's agent colors, as the message field's halo does.
import type { ChatItem, OmpToolView } from '#shared/types'

const props = defineProps<{ tool: ChatItem & { omp: OmpToolView }, live?: boolean, agent?: string | null }>()
</script>

<template>
  <div class="tools omp-console omp-run" :class="{ live }" :data-agent="props.agent || undefined">
    <span class="fx-ring omp-ring" aria-hidden="true"><span class="fx-spin" /></span>
    <div class="omp-console-head">
      <span class="omp-console-title">{{ props.tool.omp.title === 'Python' ? '$' : '!' }}</span>
      <span>{{ tl('You ran', 'Lancé par toi') }}</span>
    </div>
    <OmpTool :tool="props.tool" :live="live" run />
  </div>
</template>
