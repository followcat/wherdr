<script setup lang="ts">
// The Autopilot tab's day: a 24 h bar (its hours shaded, each wake sent or
// skipped, each task started, now and the next wake), the worker's account
// pace, then the same events listed, newest first, today then yesterday.
import { DEFAULT_AUTOPILOT } from '#shared/pm/autopilot'
import type { CoordinatorView } from '#shared/pm/coordinator'
import { WAKE_LABEL, type Wake } from '#shared/pm/wakes'

const props = defineProps<{ c: CoordinatorView }>()
// The view comes again every few seconds: now moves with it.
const now = ref(Date.now())
watch(() => props.c, () => { now.value = Date.now() })
const midnight = computed(() => new Date(now.value).setHours(0, 0, 0, 0))
const ap = computed(() => props.c.autopilot ?? DEFAULT_AUTOPILOT)

type Ev = { at: number, kind: 'sent' | 'skipped' | 'started', what: string, why: string, state?: string, problem?: boolean }
const PROBLEM = new Set(['pending', 'unanswered', 'timeout', 'quit'])
const STATE: Record<string, string> = { pending: 'waiting', delivered: 'delivered', ack: 'handled', idle: 'ended idle', quit: 'coordinator quit', timeout: 'timed out', unanswered: 'no answer', merged: 'merged' }
const wakeState = (w: Wake) => (w.ackedAt ? 'ack' : w.ended ?? (w.deliveredAt ? 'delivered' : 'pending'))
const wakeWhat = (w: Wake) => (w.now ? 'Run now' : (w.kind ?? 'autopilot') === 'autopilot' && w.reasons[0]?.startsWith('Scheduled wake') ? 'Scheduled' : WAKE_LABEL[w.kind ?? 'autopilot'])
const events = computed<Ev[]>(() => [
  ...(props.c.wakes ?? []).map(w => ({ at: w.createdAt, kind: 'sent' as const, what: wakeWhat(w), why: `${w.reasons[0] ?? ''}${w.reasons.length > 1 ? ` (+${w.reasons.length - 1})` : ''}`, state: tl(STATE[wakeState(w)]!), problem: PROBLEM.has(wakeState(w)) })),
  ...(props.c.skips ?? []).map(s => ({ at: s.at, kind: 'skipped' as const, what: tl('Skipped'), why: s.why.replace(/^Scheduled wake: /, '') })),
  ...(props.c.started ?? []).map(s => ({ at: s.at, kind: 'started' as const, what: tl('Started'), why: `${s.task} ${s.title}` })),
].sort((a, b) => b.at - a.at))
const today = computed(() => events.value.filter(e => e.at >= midnight.value))
const yesterday = computed(() => events.value.filter(e => e.at < midnight.value))

// Positions on the bar, in % of today.
const pos = (at: number) => `${Math.min(100, Math.max(0, (at - midnight.value) / 864_000))}%`
const shade = computed(() => {
  const h = ap.value.hours
  if (!h) return [[0, 24]]
  return h.from < h.to ? [[h.from, h.to]] : [[0, h.to], [h.from, 24]]
})
const hoursText = computed(() => (ap.value.hours ? `${String(ap.value.hours.from).padStart(2, '0')}–${String(ap.value.hours.to).padStart(2, '0')}` : tl('all day')))
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const nextText = computed(() => props.c.nextWake && (props.c.nextWake < midnight.value + 86_400_000 ? time(props.c.nextWake) : new Date(props.c.nextWake).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })))

const pace = computed(() => props.c.pace)
const pct = (n: number | null) => `${Math.round(Math.min(100, Math.max(0, n ?? 0)))}%`
</script>

<template>
  <section class="tl" data-testid="autopilot-timeline">
    <div class="tl-head">
      <span class="mono-label">{{ tl('Today') }}</span>
      <span class="mono-label tl-hours-text">{{ tl('Hours') }} {{ hoursText }}</span>
    </div>
    <div class="tl-bar" aria-hidden="true">
      <span v-for="([a, b], i) in shade" :key="i" class="tl-shade" :style="{ left: `${a! / 0.24}%`, width: `${(b! - a!) / 0.24}%` }" />
      <i v-for="(e, i) in today" :key="i" class="tl-mark" :class="[e.kind, { problem: e.problem }]" :style="{ left: pos(e.at) }" />
      <b class="tl-now" :style="{ left: pos(now) }" />
      <b v-if="c.nextWake && c.nextWake < midnight + 86_400_000" class="tl-next" :style="{ left: pos(c.nextWake) }" />
    </div>
    <div class="tl-ticks mono-label" aria-hidden="true"><span v-for="h in [0, 6, 12, 18, 24]" :key="h">{{ String(h).padStart(2, '0') }}</span></div>

    <div v-if="pace" class="tl-pace" :data-go="pace.wait ? undefined : ''" data-testid="autopilot-pace">
      <span class="mono-label">{{ tl('Pace') }} · {{ pace.account }}</span>
      <span class="tl-gauge" aria-hidden="true"><i :style="{ width: pct(pace.used) }" /><b v-if="pace.limit !== null" :style="{ left: pct(pace.limit) }" /></span>
      <span class="mono-label tl-pace-text">
        <template v-if="pace.used !== null">{{ tl('week') }} {{ pct(pace.used) }}<template v-if="pace.limit !== null"> / {{ pace.label }} {{ pct(pace.limit) }}</template> · </template>
        <b>{{ pace.wait ? tl(`waits: ${pace.wait}`) : tl('go') }}</b>
      </span>
    </div>

    <ol class="tl-list" data-testid="autopilot-events">
      <li v-if="nextText" class="tl-row next" data-testid="autopilot-next-wake"><span class="mono-label">{{ tl(`Next wake ${nextText}`) }}</span></li>
      <li class="tl-row now"><span class="mono-label">{{ tl('Now') }} {{ time(now) }}</span></li>
      <li v-for="(e, i) in today" :key="`t${i}`" class="tl-row" :class="[e.kind, { problem: e.problem }]" :data-kind="e.kind" data-testid="autopilot-event">
        <span class="mono-label tl-time">{{ time(e.at) }}</span><span class="tl-what">{{ e.what }}</span><span class="tl-why">{{ e.why }}</span><span v-if="e.state" class="tl-state">{{ e.state }}</span>
      </li>
      <li v-if="!today.length" class="tl-row muted">{{ tl('Nothing yet today.') }}</li>
      <template v-if="yesterday.length">
        <li class="tl-day mono-label">{{ tl('Yesterday') }}</li>
        <li v-for="(e, i) in yesterday" :key="`y${i}`" class="tl-row" :class="[e.kind, { problem: e.problem }]" :data-kind="e.kind" data-testid="autopilot-event">
          <span class="mono-label tl-time">{{ time(e.at) }}</span><span class="tl-what">{{ e.what }}</span><span class="tl-why">{{ e.why }}</span><span v-if="e.state" class="tl-state">{{ e.state }}</span>
        </li>
      </template>
    </ol>
  </section>
</template>

<style scoped>
.tl { display: grid; gap: 6px; min-width: 0; }
.tl-head { display: flex; justify-content: space-between; gap: 8px; }
.tl-head .mono-label:first-child { color: var(--text); }
.tl-hours-text { color: var(--muted); }
.tl-bar { position: relative; height: 28px; border: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.tl-shade { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.tl-mark { position: absolute; top: 9px; width: 8px; height: 8px; transform: translateX(-50%); background: var(--accent); }
.tl-mark.skipped { top: 18px; background: transparent; box-shadow: inset 0 0 0 1px var(--muted); }
.tl-mark.started { top: 1px; background: var(--green); }
.tl-mark.problem { background: var(--rose); }
.tl-now, .tl-next { position: absolute; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); background: var(--text); }
.tl-next { background: transparent; border-left: 2px dashed var(--accent); }
.tl-ticks { display: flex; justify-content: space-between; color: var(--dim); }
.tl-pace { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 8px; padding: 8px 0; border-top: 1px solid var(--line-soft); }
.tl-pace > .mono-label:first-child { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-gauge { position: relative; grid-column: 1 / -1; height: 8px; border: 1px solid var(--line); }
.tl-gauge i { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
.tl-gauge b { position: absolute; top: -3px; bottom: -3px; width: 2px; transform: translateX(-50%); background: var(--text); }
.tl-pace-text { color: var(--muted); }
.tl-pace-text b { color: var(--ochre); }
.tl-pace[data-go] .tl-pace-text b { color: var(--green); }
.tl-list { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; border-top: 1px solid var(--line); }
.tl-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.tl-row.next .mono-label { color: var(--accent); }
.tl-row.now .mono-label { color: var(--text); }
.tl-time { flex: none; color: var(--muted); }
.tl-what { flex: none; font: 12px/1.4 var(--font-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--accent); }
.tl-row.skipped .tl-what { color: var(--muted); }
.tl-row.started .tl-what { color: var(--green); }
.tl-why { flex: 1; min-width: 0; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-state { flex: none; font: 12px/1.4 var(--font-mono); text-transform: uppercase; letter-spacing: .08em; padding: 0 6px; border: 1px solid var(--line); color: var(--muted); }
.tl-row.problem { padding-left: 8px; border-left: 2px solid var(--rose); background: color-mix(in srgb, var(--rose) 8%, transparent); }
.tl-row.problem .tl-state { color: var(--rose); }
.tl-day { padding: 10px 0 4px; color: var(--muted); border-bottom: 1px solid var(--line-soft); }
</style>
