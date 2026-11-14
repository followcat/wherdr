<script setup lang="ts">
// A badge in a note's line (shared/notes.ts): a project's key badge, a task
// id linking to its sheet, or an agent's own (label, icon, palette colour,
// optional link). Mounted by NotesPanel.vue, whose click handler opens links.
import type { NoteBadge } from '#shared/notes'
import { projectColorVar } from '~/utils/projectColor'

const props = defineProps<{ badge: NoteBadge }>()
const project = computed(() => {
  const b = props.badge
  if (b.kind !== 'project') return null
  const c = projectCoordinators.value.find(x => x.project === b.key || x.label === b.key)
  return { text: b.task ?? b.key, color: c?.color, link: b.task ? `#/board?task=${b.task}` : '' }
})
const custom = computed(() => (props.badge.kind === 'custom' ? props.badge : null))
const link = computed(() => project.value?.link || custom.value?.link || '')
</script>

<template>
  <component :is="link ? 'a' : 'span'" :href="link || undefined" class="note-badge-wrap" data-testid="note-badge">
    <ProjectBadge v-if="project" :text="project.text" :color="project.color" />
    <span v-else-if="custom" class="note-badge" :style="custom.colour ? { '--key-c': projectColorVar(custom.colour) } : undefined">
      <UIcon v-if="custom.icon" :name="custom.icon" />{{ custom.label }}
    </span>
  </component>
</template>

<style scoped>
.note-badge-wrap { text-decoration: none; }
/* The key badge's look, in the sans font: an icon, then the label. */
.note-badge {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; vertical-align: middle;
  border: 1px solid var(--key-c, var(--line-strong));
  color: color-mix(in srgb, var(--key-c, var(--text-2)) 55%, var(--text-strong));
  background: color-mix(in srgb, var(--key-c, transparent) 12%, transparent);
  font: 600 12px/1.6 var(--sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.note-badge .iconify { flex: none; width: 12px; height: 12px; }
a.note-badge-wrap:hover .note-badge, a.note-badge-wrap:hover :deep(.project-badge) { border-color: var(--accent); }
</style>
