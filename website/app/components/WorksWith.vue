<script setup lang="ts">
// "Works with": the agents wherdr is tested with, with the app's brand icons
// (app/utils/agentIcons.ts). Other terminals get the list and terminal, so
// they are mentioned without a logo.
// omp's logo is a thin pixel π: at the size of the others its 2-unit legs
// blur into a dim smudge, so it is drawn larger (`big`).
const AGENTS: { name: string, icon: string, color?: string, big?: boolean }[] = [
  { name: 'Claude Code', icon: 'i-herdr-claude-code', color: 'var(--claude)' },
  { name: 'Codex', icon: 'i-herdr-codex', color: 'var(--codex)' },
  { name: 'omp', icon: 'i-herdr-omp', big: true },
]
</script>

<template>
  <div class="am">
    <span class="label lead-label">Works with</span>
    <ul class="row" aria-label="Agents that work with wherdr">
      <li v-for="a in AGENTS" :key="a.name" :title="`${a.name}: full conversation view`">
        <UIcon :name="a.icon" class="ico" :class="{ big: a.big }" :style="a.color ? { color: a.color } : undefined" />
        {{ a.name }}
      </li>
      <li class="more">and Devin, and every terminal of herdr-core</li>
    </ul>
  </div>
</template>

<style scoped>
.am { display: flex; align-items: center; gap: 24px; padding-top: 20px; border-top: 1px solid var(--line); min-width: 0; }
.lead-label { flex: none; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 36px; margin: 0; padding: 0; list-style: none; }
.row li { display: flex; align-items: center; gap: 10px; white-space: nowrap; font: 13px/1 var(--mono); color: var(--text); }
.row li.more { color: var(--dim); }
.ico { width: 18px; height: 18px; flex: none; color: var(--text); }
.ico.big { width: 24px; height: 24px; margin: -3px 0; }
@media (max-width: 760px) {
  .am { flex-direction: column; align-items: flex-start; gap: 14px; }
}
</style>
