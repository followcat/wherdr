<script setup lang="ts">
// The name of a project's Workflow or Autopilot with what it is in a few words,
// so the two are not mixed up, and (with `project`) the sentence that links to the other.
export type Part = 'workflow' | 'autopilot'
const props = defineProps<{ part: Part, title?: string, project?: string }>()
const NAME: Record<Part, string> = { workflow: 'Workflow', autopilot: 'Autopilot' }
const SUBTITLE: Record<Part, string> = { workflow: 'How each task runs, step by step', autopilot: 'When the project works without you' }
const LINK: Record<Part, [string, Part]> = { workflow: ['Who starts tasks and when: Autopilot tab', 'autopilot'], autopilot: ['Tasks it starts follow the Workflow tab', 'workflow'] }
const to = computed(() => props.project && `/settings?section=projects&project=${encodeURIComponent(props.project)}&tab=${LINK[props.part][1]}`)
</script>

<template>
  <div class="part-head" :data-testid="`part-head-${part}`">
    <span class="mono-label part-name">{{ tl(title ?? NAME[part]) }}</span>
    <small class="part-sub" data-testid="part-subtitle">{{ tl(SUBTITLE[part]) }}</small>
    <NuxtLink v-if="to" :to="to" class="part-link" data-testid="part-link">{{ tl(LINK[part][0]) }}</NuxtLink>
  </div>
</template>

<style scoped>
.part-head { display: grid; gap: 2px; min-width: 0; }
.part-name { color: var(--text); }
.part-sub { color: var(--muted); font-size: 13px; }
/* A 44 px hit area around the one-line link, without moving its neighbors. */
.part-link { position: relative; justify-self: start; color: var(--accent); font-size: 13px; text-decoration: underline; text-underline-offset: 2px; }
.part-link::after { content: ''; position: absolute; inset: -14px 0; }
</style>
