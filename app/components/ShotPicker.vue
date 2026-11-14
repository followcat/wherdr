<script setup lang="ts">
// A task's screenshots as thumbnails to pick (tap to select, a check on the
// picked ones), for Report a problem (TaskReport) and Reject (ReviewReject).
import { shotUrl } from '#shared/pm/shots'

defineProps<{ task: string, files: string[] }>()
const picked = defineModel<string[]>({ default: () => [] })
const toggle = (f: string) => { picked.value = picked.value.includes(f) ? picked.value.filter(x => x !== f) : [...picked.value, f] }
</script>

<template>
  <ul class="report-shots">
    <li v-for="(f, i) in files" :key="f">
      <button type="button" class="report-shot" :class="{ on: picked.includes(f) }" :aria-pressed="picked.includes(f)" :aria-label="tl(`Screenshot ${i + 1}`)" data-testid="task-report-shot" @click="toggle(f)">
        <img :src="shotUrl(task, f)" alt="" loading="lazy" decoding="async">
        <UIcon v-if="picked.includes(f)" name="i-lucide-check" class="report-check" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.report-shots { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.report-shot { position: relative; display: block; width: 88px; height: 64px; padding: 0; border: 1px solid var(--line); background: var(--surface); cursor: pointer; overflow: hidden; }
.report-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.report-shot.on { border: 2px solid var(--accent); }
.report-check { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; color: var(--on-accent); background: var(--accent); }
</style>
