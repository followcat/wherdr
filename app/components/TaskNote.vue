<script setup lang="ts">
// A note on a task waiting for the user (the worker's report, the review):
// its label, then its Markdown (the chat's safe renderer, no raw HTML),
// folded to a few lines with Show more.
const props = defineProps<{ label: string, text: string }>()
const html = computed(() => md(props.text, { plain: true }))
function onClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
  const text = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (btn && text != null) copyCodeBlock(btn, text)
}
</script>

<template>
  <section class="task-note">
    <span class="mono-label muted">{{ label }}</span>
    <FoldText :lines="4">
      <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
      <div class="md-body task-note-md" @click="onClick" v-html="html" />
    </FoldText>
  </section>
</template>

<style scoped>
.task-note { display: grid; gap: 4px; align-content: start; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); background: var(--surface); }
/* A note, not a document: small headings, tight paragraphs and lists. */
.task-note-md { overflow-wrap: anywhere; color: var(--text-2); }
.task-note-md :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 15px; margin: .6em 0 .3em; }
.task-note-md :deep(:is(p, ul, ol)) { margin: 0 0 .5em; }
.task-note-md :deep(:last-child) { margin-bottom: 0; }
</style>
