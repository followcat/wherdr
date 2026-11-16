<script setup lang="ts">
// Story 1.2, right phone: wherdr's agent list (HomeView.vue), compact. The
// agent that pushed its question opens its line on the answers; one tap
// answers without opening the conversation, the agent goes back to work, then
// is done (unread: green line, bold name). Same PHONE clock as NotifyDemo.
import { OPTIONS, PICKED, QUESTION } from '~/utils/heroDemo'
import { PHONE } from '~/utils/storyDemos'
import type { DemoAgent } from '~/utils/demoScript'

const root = ref<HTMLElement | null>(null)
const { step } = useDemoClock(PHONE, root)

const lead = computed<DemoAgent>(() => {
  const s = step.value
  const base = { name: 'acme-api', agent: 'omp', model: 'GPT-5.5', effort: 'high' } as const
  if (s >= 5) return { ...base, state: 'done', line: 'The cache keeps users for 5 minutes. 16 tests pass.' }
  if (s >= 4) return { ...base, state: 'working', line: '❯ edit src/users.js' }
  if (s >= 3) return { ...base, state: 'working', line: '5 minutes' }
  if (s >= 1) return { ...base, state: 'blocked', line: QUESTION }
  return { ...base, state: 'working', line: '❯ npm test' }
})
const agents = computed<DemoAgent[]>(() => [
  lead.value,
  { name: 'docs-site', agent: 'codex', model: 'gpt-5.5', effort: 'medium', state: 'idle', line: 'The changelog for 2.4 is written. Anything else?' },
])
const choices = OPTIONS.map(o => o.title)
</script>

<template>
  <div ref="root" class="al app-ui" aria-hidden="true">
    <div class="home-top">
      <div class="eyebrow home-brand"><PixelMark class="home-logo" :boot="false" :glow="false" />wherdr 3.0.0 · hc</div>
      <div class="home-title-row">
        <h3 class="home-title">Agents</h3>
        <div class="home-actions">
          <span class="icon-btn"><UIcon name="i-lucide-search" /></span>
          <span class="icon-btn"><UIcon name="i-lucide-settings-2" /></span>
        </div>
      </div>
    </div>
    <div class="scroll">
      <div class="session-row"><span><UIcon name="i-lucide-layers" />devbox</span><b>default<UIcon name="i-lucide-chevron-right" /></b></div>
      <DemoList
        :agents="agents" choices-for="acme-api"
        :choices="step >= 1 && step < 3 ? choices : undefined" :hit="step >= 2 ? PICKED : undefined"
      />
    </div>
    <span class="new-fab"><UIcon name="i-lucide-plus" />New</span>
  </div>
</template>

<style scoped>
.al { --u: calc(100cqw / 390); position: absolute; inset: 0; display: flex; flex-direction: column; }
.home-top { display: flex; flex-direction: column; gap: calc(var(--u) * 10); padding: calc(var(--u) * 18) calc(var(--u) * 16) calc(var(--u) * 16); }
.scroll { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: calc(var(--u) * 14); padding: 0 calc(var(--u) * 16); }
.new-fab {
  position: absolute; right: calc(var(--u) * 16); bottom: calc(var(--u) * 26); display: flex; align-items: center; gap: calc(var(--u) * 10);
  height: calc(var(--u) * 46); padding: 0 calc(var(--u) * 18); border: 1px solid var(--line-strong); background: var(--bg-2);
  font: 600 calc(var(--u) * 12) / 1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--text);
}
.new-fab .iconify { width: calc(var(--u) * 16); height: calc(var(--u) * 16); }
.home-top .home-title { font-size: calc(var(--u) * 34); }
</style>
