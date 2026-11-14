<script setup lang="ts">
// The task sheet's History tab: its whole log as one timeline, oldest first
// (taskHistory): the hand-offs between worker, reviewer, wherdr, the
// coordinator and the user as entries, the engine's routine lines lighter.
// With `comments`, the Comments tab: only the agents' reports and verdicts,
// like a PR's conversation. Each entry: who, when, what it is, then its text
// in Markdown (the chat's safe renderer), folded past a few lines.
import type { Card } from '#shared/pm/board'
import { REPORTS, taskHistory, type Who } from '#shared/pm/history'

const props = defineProps<{ card: Card, comments?: boolean }>()
const WHO: Record<Who, string> = { worker: 'Worker', reviewer: 'Reviewer', user: 'You', coordinator: 'Coordinator', engine: 'wherdr' }
const entries = computed(() => taskHistory(props.card.log, props.card.plan, props.card.state, !props.comments, props.card.workReports)
  .filter(e => !props.comments || REPORTS.has(e.label))
  .map(e => ({ ...e, html: e.routine ? '' : md(e.text, { plain: true }), tone: e.label === 'Sent back' ? 'back' : e.label === 'Passed' ? 'pass' : '' })))
function onClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
  const text = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (btn && text != null) copyCodeBlock(btn, text)
}
</script>

<template>
  <ol class="task-history" :data-testid="comments ? 'task-comments' : 'task-history'">
    <li v-for="(e, i) in entries" :key="i" :class="[e.tone, { routine: e.routine }]" :data-who="e.who" :data-label="e.label || undefined">
      <span class="mono-label">
        <b>{{ tl(WHO[e.who]) }}</b><template v-if="e.label"> · {{ tl(e.label) }}</template>
        <span class="muted"> · <time :datetime="new Date(e.at).toISOString()" :title="fmtDateTime(e.at)">{{ fmtWhen(new Date(e.at).toISOString()) }}</time><template v-if="e.agent"> · {{ e.agent }}</template></span>
      </span>
      <span v-if="e.routine" class="task-history-line">{{ e.text }}</span>
      <FoldText v-else :lines="5">
        <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
        <div class="md-body task-history-md" @click="onClick" v-html="e.html" />
      </FoldText>
    </li>
    <li v-if="!entries.length" class="muted">{{ comments ? tl('No report yet.') : tl('Nothing handed over yet.') }}</li>
  </ol>
</template>

<style scoped>
.task-history { list-style: none; margin: 0; padding: 0; }
.task-history li { display: grid; gap: 4px; min-width: 0; padding: 8px 0 8px 12px; border-bottom: 1px solid var(--line-soft); border-left: 2px solid var(--line); }
.task-history li.back { border-left-color: var(--blocked); }
.task-history li.pass { border-left-color: var(--done); }
.task-history li[data-who="user"] { border-left-color: var(--accent); }
/* The engine's bookkeeping: one light line, no rule of its own. */
.task-history li.routine { gap: 0; padding-top: 4px; padding-bottom: 4px; border-left-color: transparent; color: var(--muted); font-size: 12px; }
.task-history li.routine .mono-label { font-size: 10px; }
.task-history-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-history-md { overflow-wrap: anywhere; color: var(--text-2); }
.task-history-md :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 15px; margin: .6em 0 .3em; }
.task-history-md :deep(:is(p, ul, ol)) { margin: 0 0 .5em; }
.task-history-md :deep(:last-child) { margin-bottom: 0; }
</style>
