<script setup lang="ts">
// A live status card from a ```wherdr block (shared/statusBlock.ts), mounted
// by ChatMarkdown in place of its line. It reads the app's own APIs, every
// 15 s while it is on screen and the page shown, so it never shows what the
// agent wrote. Its source gone (machine removed, task unknown, no quota read,
// request failed): "unavailable". A PR or operation card opens its task.
import type { Quotas } from '#shared/types'
import type { Board } from '#shared/pm/board'
import { machineView, opView, prView, quotaView, type MachineRow, type StatusKind, type StatusView } from '#shared/statusBlock'

const props = defineProps<{ kind: StatusKind, arg: string }>()
const view = ref<StatusView | null | undefined>(undefined)

// One request per source for every card on screen in the same tick.
const URL: Record<StatusKind, string> = { machine: '/api/machine/memory', quota: '/api/quotas', pr: '/api/pm/board', op: '/api/pm/board' }
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? t('just now') : m < 60 ? `${m} min` : `${Math.round(m / 60)} h` }
async function load() {
  try {
    const data = await sharedRead(URL[props.kind])
    view.value = props.kind === 'machine'
      ? machineView((data as { machines: MachineRow[] }).machines, props.arg)
      : props.kind === 'quota'
        ? quotaView(data as Quotas, props.arg, Date.now())
        : props.kind === 'pr' ? prView((data as Board).cards, props.arg) : opView((data as Board).cards, props.arg, ago)
  } catch { view.value = null }
}

const el = ref<HTMLElement | null>(null)
let seen = false
let timer: ReturnType<typeof setInterval> | null = null
let io: IntersectionObserver | null = null
onMounted(() => {
  load()
  io = new IntersectionObserver(([e]) => { const was = seen; seen = Boolean(e?.isIntersecting); if (seen && !was) load() })
  if (el.value) io.observe(el.value)
  timer = setInterval(() => { if (seen && !document.hidden) load() }, 15_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer); io?.disconnect() })

const label = computed(() => `${props.kind} ${props.arg}`)
function open() { if (view.value?.task) openTaskSheet(view.value.task) }
</script>

<script lang="ts">
const reads = new Map<string, { at: number, p: Promise<unknown> }>()
function sharedRead(url: string) {
  const hit = reads.get(url)
  if (hit && Date.now() - hit.at < 5000) return hit.p
  const p = api<unknown>(url)
  reads.set(url, { at: Date.now(), p })
  p.catch(() => reads.delete(url))
  return p
}
</script>

<template>
  <component
    :is="view?.task ? 'button' : 'div'" ref="el" class="status-card" :class="view ? view.tone : 'off'"
    :type="view?.task ? 'button' : undefined" :data-status="`${kind}:${arg}`" @click="open"
  >
    <span class="status-head">
      <b>{{ view?.title ?? label }}</b>
      <span class="status-state"><i />{{ view === undefined ? t('Loading…') : view ? view.state : t('unavailable') }}</span>
    </span>
    <span v-for="(b, i) in view?.bars" :key="`b${i}`" class="status-bar">
      <span>{{ b.label }}</span><span class="status-track"><i :style="{ width: `${b.left}%` }" /></span><span>{{ b.left }} %</span>
    </span>
    <span v-for="(line, i) in view?.lines" :key="i" class="status-line">{{ line }}</span>
  </component>
</template>

<style scoped>
.status-card {
  display: grid; gap: 4px; width: 100%; min-width: 0; padding: 8px 10px; text-align: left; color: var(--text);
  border: 1px solid var(--line); background: var(--surface); font: inherit;
}
button.status-card { cursor: pointer; }
button.status-card:hover { background: var(--surface-2); }
button.status-card:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.status-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 10px; min-width: 0; }
.status-head b { overflow-wrap: anywhere; font: 500 11px/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.status-state { display: inline-flex; align-items: center; gap: 6px; font: 12px/1.4 var(--font-mono); overflow-wrap: anywhere; }
.status-state i { width: 7px; height: 7px; flex: none; background: currentColor; }
.ok .status-state { color: var(--done); }
.wait .status-state { color: var(--working); }
.bad .status-state { color: var(--blocked); }
.off .status-state { color: var(--muted); }
.off .status-state i { background: transparent; box-shadow: inset 0 0 0 1px currentColor; }
.status-line { color: var(--text-2); font-size: 13px; overflow-wrap: anywhere; }
.status-bar { display: grid; grid-template-columns: 3.5em 1fr 3.5em; align-items: center; gap: 8px; font: 12px/1.4 var(--font-mono); color: var(--text-2); }
.status-bar > :last-child { text-align: right; }
.status-track { height: 4px; background: var(--line-soft); }
.status-track i { display: block; height: 100%; background: var(--text-2); }
</style>
