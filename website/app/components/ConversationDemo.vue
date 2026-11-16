<script setup lang="ts">
// Story 1.1: a Claude Code conversation on a computer, drawn with
// the app's pieces. Claude's four calls are grouped ("4 actions", UChatTool
// as in ChatView.vue) and unfold,
// the command block of the reply is copied, then run: the view flips to the
// live terminal, the tests pass, and it flips back. CONVERSATION script.
import { CONVERSATION, CONVERSATION_TOOLS, TEST_OUTPUT } from '~/utils/storyDemos'
import type { DemoAgent } from '~/utils/demoScript'

const root = ref<HTMLElement | null>(null)
const { step, typed } = useDemoClock(CONVERSATION, root)

const terminal = computed(() => step.value >= 7 && step.value < 10)
const last = CONVERSATION_TOOLS.at(-1)!
const agents = computed<DemoAgent[]>(() => [
  { name: 'web-shop', agent: 'claude', model: 'Opus 5.5', effort: 'high', state: 'idle', line: 'I added a small cart module and three tests. Run them with: npm test' },
  { name: 'acme-api', agent: 'omp', model: 'GPT-5.5', effort: 'high', state: 'working', line: '❯ edit src/users.js' },
  { name: 'docs-site', agent: 'codex', model: 'gpt-5.5', effort: 'medium', state: 'done', line: 'The changelog for 2.4 is written. Anything else?' },
])
const toolUi = { root: 'tool group', trigger: 'tool-trigger', label: 'tool-label', suffix: 'tool-suffix', leading: 'tool-leading', body: 'tool-body', trailingIcon: 'tool-chev' }
</script>

<template>
  <div ref="root" class="cd" aria-hidden="true">
    <DemoDesktop :width="1200" :agents="agents" active="web-shop" :terminal="terminal" subtitle="Cart module and tests" where="~/projects/web-shop">
      <div v-if="terminal" class="term">
        <div class="tl"><span class="p">user@devbox ~/projects/web-shop $</span> {{ step === 7 ? typed : 'npm test' }}<i v-if="step === 7" class="cur" /></div>
        <template v-if="step >= 8">
          <div class="tl dim">&gt; web-shop@1.0.0 test</div>
          <div class="tl dim">&gt; node --test src/</div>
          <div v-for="l in TEST_OUTPUT" :key="l" class="tl"><span class="ok">ok</span>{{ l.slice(2) }}</div>
        </template>
        <template v-if="step >= 9">
          <div class="tl"># tests 3 · <span class="ok">pass 3</span> · fail 0</div>
          <div class="tl"><span class="p">user@devbox ~/projects/web-shop $</span> <i class="cur" /></div>
        </template>
      </div>
      <div v-else class="chat-list">
        <DemoUserMessage text="Add a cart module with tests." time="07:02" />
        <div class="msg-who claude"><UIcon name="i-herdr-claude-code" /><span>claude</span></div>
        <DemoReply :paras="['I\'ll add `src/cart.js` with pure functions, then replace the placeholder with tests.']" agent="claude" />
        <div class="tools">
          <UChatTool
            :open="step >= 1" :text="`${CONVERSATION_TOOLS.length} actions`" :suffix="`${last.tool} · ${last.arg}`"
            icon="i-lucide-layers" chevron="trailing" :ui="toolUi"
          >
            <div v-for="t in CONVERSATION_TOOLS" :key="t.arg" class="tool-row"><UIcon :name="t.icon" /><b>{{ t.tool }}</b><span>{{ t.arg }}</span></div>
          </UChatTool>
        </div>
        <div class="md">
          <p>I added a small cart module in <code data-k="path">src/cart.js</code> and three tests. Run them with:</p>
          <div class="code-block">
            <div class="code-head"><span>bash</span><span class="code-tools"><span class="code-run" :class="{ hit: step === 6 }">Run</span><span class="code-copy" :class="{ done: step === 5 }">{{ step === 5 ? 'Copied' : 'Copy' }}</span></span></div>
            <pre>npm test</pre>
          </div>
        </div>
        <DemoTurnEnd text="✓ 2 min 40 s · 4 actions" />
      </div>
      <template #bottom>
        <DemoComposer v-if="!terminal" agent="claude" desktop focus model="Opus 5.5" effort="high" />
      </template>
    </DemoDesktop>
  </div>
</template>

<style scoped>
.cd { position: absolute; inset: 0; }
/* Live terminal, xterm look (TerminalView.vue). */
.term { flex: 1; min-height: 0; margin: 0 calc(var(--u) * -16) calc(var(--u) * -8); padding: calc(var(--u) * 14) calc(var(--u) * 16); background: var(--bg); font: calc(var(--u) * 14) / 1.5 var(--mono); color: var(--text); overflow: hidden; }
.tl { white-space: pre; }
.p, .ok { color: var(--green); }
.dim { color: var(--dim); }
.cur { display: inline-block; width: .6em; height: 1.1em; vertical-align: -.18em; background: var(--text); animation: blink 1.1s steps(1) infinite; }
</style>
