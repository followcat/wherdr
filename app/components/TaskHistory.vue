<script setup lang="ts">
// The task sheet's History tab: its whole log as a timeline (UTimeline),
// oldest first (taskHistory): the hand-offs between worker, reviewer, wherdr,
// the coordinator and the user as entries, the engine's routine lines lighter.
// Each entry's square mark says its kind (historyKind): started, done, sent
// back, merged, failed, the user's action. With `comments`, the Comments tab:
// only the agents' reports and verdicts, like a PR's conversation. Each entry:
// who, when, what it is, then its text in Markdown (the chat's safe renderer),
// folded past a few lines.
import type { Card } from '#shared/pm/board'
import { REPORTS, historyKind, taskHistory, type HistoryKind, type Who } from '#shared/pm/history'

const props = defineProps<{ card: Card, comments?: boolean }>()
const WHO: Record<Who, string> = { worker: 'Worker', reviewer: 'Reviewer', user: 'You', coordinator: 'Coordinator', engine: 'wherdr' }
const ICON: Record<HistoryKind, string | undefined> = {
  start: 'i-lucide-play', done: 'i-lucide-check', back: 'i-lucide-undo-2', merged: 'i-lucide-git-merge',
  failed: 'i-lucide-x', user: 'i-lucide-user', note: 'i-lucide-arrow-right', routine: undefined,
}
const entries = computed(() => taskHistory(props.card.log, props.card.plan, props.card.state, !props.comments, props.card.workReports, props.card.starts)
  .filter(e => !props.comments || REPORTS.has(e.label))
  .map((e) => {
    const kind = historyKind(e)
    return { ...e, kind, icon: ICON[kind], class: `kind-${kind}`, html: e.routine ? '' : md(e.text, { plain: true }) }
  }))
// Square marks and rules in wherdr's colors (scoped styles below), not the library's round ones.
const UI = { root: 'task-history', item: 'task-history-item', indicator: 'task-history-mark rounded-none', separator: 'task-history-rule rounded-none', wrapper: 'task-history-body' }
function onClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
  const text = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (btn && text != null) copyCodeBlock(btn, text)
}
</script>

<template>
  <UTimeline v-if="entries.length" :items="entries" size="2xs" :ui="UI" :data-testid="comments ? 'task-comments' : 'task-history'">
    <template #wrapper="{ item: e }">
      <div :data-who="e.who" :data-label="e.label || undefined" :data-kind="e.kind" class="task-history-entry" :class="{ routine: e.routine }">
        <span class="mono-label">
          <b>{{ tl(WHO[e.who]) }}</b><template v-if="e.label"> · {{ tl(e.label) }}</template>
          <span class="muted"> · <time :datetime="new Date(e.at).toISOString()" :title="fmtDateTime(e.at)">{{ fmtWhen(new Date(e.at).toISOString()) }}</time><template v-if="e.agent"> · {{ e.agent }}</template></span>
          <template v-for="st in e.started ?? []" :key="st.role"> · <span class="task-history-agent" data-testid="history-agent">{{ tl(WHO[st.role]) }} {{ st.agent }}</span></template>
        </span>
        <span v-if="e.routine" class="task-history-line">{{ e.text }}</span>
        <FoldText v-else :lines="5">
          <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
          <div class="md-body task-history-md" @click="onClick" v-html="e.html" />
        </FoldText>
      </div>
    </template>
  </UTimeline>
  <p v-else class="muted task-history-empty" :data-testid="comments ? 'task-comments' : 'task-history'">{{ comments ? tl('No report yet.') : tl('Nothing handed over yet.') }}</p>
</template>

<style scoped>
.task-history { gap: 0; }
.task-history :deep(.task-history-item) { gap: 10px; min-width: 0; }
/* The kind's mark: a square on the rule, its color by kind; routine lines a small dim square. */
.task-history :deep(.task-history-mark) { --mark: var(--line); margin-top: 8px; width: 20px; height: 20px; border-radius: 0; background: var(--bg-2); border: 1px solid var(--mark); color: var(--mark); }
.task-history :deep(.task-history-mark [class*='i-lucide']) { width: 12px; height: 12px; }
.task-history :deep(.task-history-rule) { width: 1px; border-radius: 0; background: var(--line); }
.task-history :deep(.kind-start .task-history-mark) { --mark: var(--working); }
.task-history :deep(.kind-done .task-history-mark), .task-history :deep(.kind-merged .task-history-mark) { --mark: var(--done); }
.task-history :deep(.kind-merged .task-history-mark) { background: var(--done); color: var(--bg); }
.task-history :deep(.kind-back .task-history-mark) { --mark: var(--blocked); }
.task-history :deep(.kind-failed .task-history-mark) { --mark: var(--danger); background: var(--danger); color: var(--bg); }
.task-history :deep(.kind-user .task-history-mark) { --mark: var(--accent); }
.task-history :deep(.kind-note .task-history-mark) { --mark: var(--text-3); }
.task-history :deep(.kind-routine .task-history-mark) { margin: 9px 6px 0 7px; width: 7px; height: 7px; background: var(--dim); border-color: var(--dim); }
.task-history :deep(.task-history-body) { min-width: 0; padding-bottom: 0; }
.task-history-entry { display: grid; gap: 4px; min-width: 0; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
/* The engine's bookkeeping: one light line. */
.task-history-entry.routine { gap: 0; padding-top: 4px; padding-bottom: 4px; color: var(--muted); font-size: 12px; }
.task-history-entry.routine .mono-label { font-size: 10px; }
.task-history-empty { margin: 0; }
.task-history-agent { color: var(--text-2); }
.task-history-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-history-md { overflow-wrap: anywhere; color: var(--text-2); }
.task-history-md :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 15px; margin: .6em 0 .3em; }
.task-history-md :deep(:is(p, ul, ol)) { margin: 0 0 .5em; }
.task-history-md :deep(:last-child) { margin-bottom: 0; }
</style>
