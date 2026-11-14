<script setup lang="ts">
// Which branch merges into which, as GitHub says it: the task's branch, then
// its target (its PR's base, or where its next step sends it), each a mono
// chip. compact: the card's line, without the commit count or the Copy button.
import type { BranchLine } from '#shared/pm/board'

const props = defineProps<{ line: BranchLine, compact?: boolean }>()
const commits = computed(() => (props.line.commits ? tl(`${props.line.commits} commit${props.line.commits > 1 ? 's' : ''}`) : ''))
</script>

<template>
  <span class="branch-line" :class="{ compact }" data-testid="branch-line">
    <UIcon name="i-lucide-git-branch" class="branch-icon" aria-hidden="true" />
    <code class="branch-chip" :title="line.head" data-testid="branch-head">{{ line.head }}</code>
    <span v-if="line.pending" class="branch-word">{{ tl('will open a PR to') }}</span>
    <span v-else class="branch-word" :aria-label="tl('into')">→</span>
    <code class="branch-chip" :title="line.base" data-testid="branch-base">{{ line.base }}</code>
    <span v-if="commits && !compact" class="branch-word" data-testid="branch-commits">· {{ commits }}</span>
    <UButton v-if="!compact" icon="i-lucide-copy" color="neutral" variant="ghost" size="sm" class="branch-copy" :aria-label="tl('Copy the branch name')" data-testid="branch-copy" @click="copyCode(line.head)" />
  </span>
</template>

<style scoped>
.branch-line { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; font-size: 12px; color: var(--muted); }
.branch-icon { flex: none; width: 14px; height: 14px; }
/* Long names ellipsized: each chip may shrink, the words around them not. */
.branch-chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px var(--font-mono); padding: 1px 6px; border: 1px solid var(--line); background: var(--surface-2); color: var(--accent); }
.branch-word { flex: none; white-space: nowrap; }
/* A 44 px hit area around the small drawn button, kept inside the line. */
.branch-copy { flex: none; position: relative; }
.branch-copy::after { content: ''; position: absolute; inset: -8px; }
.compact { font-size: 11px; }
.compact .branch-chip { font-size: 11px; padding: 0 4px; }
</style>
