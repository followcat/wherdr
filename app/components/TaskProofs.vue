<script setup lang="ts">
// A step's proofs in the task sheet's Plan tab. Texts (the worker's report,
// its proposed tasks) in Markdown, folded past a few lines, as in History; a
// text equal to an earlier one is shown once. A commit is a short sha chip,
// linked to its page on the Git host from the first PR link in `links` (the
// step's own first, TaskSheet.vue); a link is
// a chip with a readable label (PR #12, else its address).
import { commitUrl, linkLabel } from '#shared/pm/board'

const props = defineProps<{ proofs: [string, string][], links: { label: string, url: string }[] }>()
const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v)
interface Chip { k: string, text: string, title: string, href?: string }
interface ProofText { k: string, html: string }
const shown = computed(() => {
  const seen = new Set<string>()
  const chips: Chip[] = []
  const texts: ProofText[] = []
  for (const [k, raw] of props.proofs) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    if (k === 'commit' && /^[0-9a-f]{7,64}$/i.test(v)) chips.push({ k, text: v.slice(0, 7), title: v, href: commitUrl(v, props.links) })
    else if (isUrl(v)) chips.push({ k, text: linkLabel({ label: v.replace(/^https?:\/\//, '').replace(/\/$/, ''), url: v }), title: v, href: v })
    else texts.push({ k, html: md(v, { plain: true }) })
  }
  return { chips, texts }
})
const chips = computed(() => shown.value.chips)
const texts = computed(() => shown.value.texts)
function onClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
  const text = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (btn && text != null) copyCodeBlock(btn, text)
}
</script>

<template>
  <div v-if="chips.length || texts.length" class="task-proofs" data-testid="task-proofs">
    <div v-if="chips.length" class="task-proof-chips">
      <span v-for="p in chips" :key="p.k" class="task-proof-chip" :data-proof="p.k">
        <span class="mono-label muted">{{ p.k }}</span>
        <a v-if="p.href" :href="p.href" :title="p.title" target="_blank" rel="noopener" class="board-chip">{{ p.text }}</a>
        <span v-else :title="p.title" class="board-chip">{{ p.text }}</span>
      </span>
    </div>
    <section v-for="p in texts" :key="p.k" class="task-proof-text" :data-proof="p.k">
      <span class="mono-label muted">{{ p.k }}</span>
      <FoldText :lines="4">
        <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
        <div class="md-body task-proof-md" @click="onClick" v-html="p.html" />
      </FoldText>
    </section>
  </div>
</template>

<style scoped>
.task-proofs { display: grid; gap: 8px; min-width: 0; }
.task-proof-chips { display: flex; flex-wrap: wrap; gap: 6px 14px; min-width: 0; }
.task-proof-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.task-proof-chip .board-chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-proof-text { display: grid; gap: 4px; min-width: 0; padding: 8px 10px; border: 1px solid var(--line-soft); background: var(--surface); }
.task-proof-md { overflow-wrap: anywhere; color: var(--text-2); }
.task-proof-md :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 15px; margin: .6em 0 .3em; }
.task-proof-md :deep(:is(p, ul, ol)) { margin: 0 0 .5em; }
.task-proof-md :deep(:last-child) { margin-bottom: 0; }
</style>
