<script setup lang="ts">
// One omp tool call, a line of the console ChatView draws for a group of
// calls: "❯ command" (bash) or "read TASKS.md:5-20" with the wall time on the
// right, then "# intent → counts" underneath. ✗ and the exit code in red on an
// error. While it runs: omp's braille spinner, the intent shimmering and the
// elapsed time, like omp's activity line. The end of the output (or an
// edit's diff) unfolds on a tap, under omp's header (OUTPUT · … N earlier
// lines · exit · wall).
// `run`: the user's own "!" / "$" command, which has no intent: its output
// size and a chevron show that it unfolds.
import type { ChatItem, OmpToolView } from '#shared/types'
import { ompCommandLine, ompOutHead, ompOutSize, ompToolMeta, ompWall } from '~/utils/ompTool'

const props = defineProps<{ tool: ChatItem & { omp: OmpToolView }, live?: boolean, run?: boolean }>()
const open = ref(false)

const v = computed(() => props.tool.omp)
const err = computed(() => Boolean(props.tool.error))
const meta = computed(() => ompToolMeta(v.value).concat(props.run ? [ompOutSize(v.value)].filter(Boolean) : []).join(' · '))
const exit = computed(() => (v.value.exit ? String(v.value.exit) : ''))
const wall = computed(() => (props.live || v.value.ms === undefined ? '' : ompWall(v.value.ms)))
// Running call: its start, for the elapsed time on the right.
const since = computed(() => (props.live && props.tool.ts ? Date.parse(props.tool.ts) || null : null))
const intent = computed(() => v.value.intent || v.value.title)
const canOpen = computed(() => Boolean(v.value.out))
// A running command shows its output so far; once done it is folded.
const shown = computed(() => canOpen.value && (open.value || Boolean(props.live)))
const head = computed(() => ompOutHead(v.value, err.value))
const outLines = computed(() => (v.value.out || '').split('\n').map(l => ({
  text: l,
  cls: v.value.diff ? (/^\+\s*\d*\|/.test(l) ? 'add' : /^-\s*\d*\|/.test(l) ? 'del' : '') : '',
})))
</script>

<template>
  <div class="omp-tool" :class="{ err, live, open: shown }">
    <component
      :is="canOpen ? 'button' : 'div'" class="omp-tool-head" :type="canOpen ? 'button' : undefined"
      :aria-expanded="canOpen ? shown : undefined" @click="canOpen && (open = !shown)"
    >
      <span class="omp-tool-line">
        <span class="omp-tool-glyph" aria-hidden="true"><OmpSpinner v-if="live" /><template v-else>{{ err ? '✗' : '❯' }}</template></span>
        <code class="omp-tool-cmd">{{ ompCommandLine(v) }}</code>
        <span v-if="since" class="omp-tool-wall"><OmpElapsed :since="since" /></span>
        <span v-else-if="wall" class="omp-tool-wall">{{ wall }}</span>
        <UIcon v-if="run && canOpen" :name="shown ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="omp-tool-chev" aria-hidden="true" />
      </span>
      <span class="omp-tool-sub">
        <UChatShimmer v-if="live" :text="`# ${intent}`" :duration="2.4" class="omp-tool-intent" />
        <span v-else-if="v.intent" class="omp-tool-intent"># {{ v.intent }}</span>
        <span v-if="meta || exit" class="omp-tool-result">→ {{ meta }}<template v-if="exit"><template v-if="meta"> · </template><span class="omp-tool-exit">exit {{ exit }}</span></template></span>
      </span>
    </component>
    <div v-if="shown" class="omp-tool-out">
      <div class="omp-tool-out-head">
        <span class="omp-tool-out-label">{{ head.label }}</span>
        <span v-if="head.earlier" class="omp-tool-out-earlier">{{ head.earlier }}</span>
        <span class="omp-tool-out-right">
          <span v-if="exit" class="omp-tool-exit">exit {{ exit }}</span>
          <span v-if="wall">{{ wall }}</span>
        </span>
      </div>
      <pre><span v-for="(l, i) in outLines" :key="i" :class="l.cls">{{ l.text }}
</span></pre>
    </div>
  </div>
</template>
