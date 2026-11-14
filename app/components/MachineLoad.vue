<script setup lang="ts">
// One machine's live part in the project's Machines block (machineNow, read
// from /api/pm/project-machines): online, offline or paused for the project,
// its hours, its memory as a bar (its agents' estimates, the rest of what is
// used, free; the reserve automatic starts leave hatched at the end), cores and
// load (macOS: memory pressure), its agents at work, and what it takes now.
import type { MachineNow } from '#shared/pm/placement'
import { roomWord } from '#shared/pm/memory'

const props = defineProps<{ m: MachineNow }>()
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const pct = (mb: number) => `${Math.max(0, Math.min(100, (mb / props.m.memory!.total) * 100))}%`
const STATE = { online: 'Online', offline: 'Offline', paused: 'Paused' } as const
const SQUARE = { online: 'idle', offline: 'inactive', paused: 'blocked' } as const
const takes = computed(() => props.m.takes
  ? tl(`Takes ${props.m.takes} now`) + (props.m.why ? ` · ${tl(props.m.why)}` : '')
  : tl(`Takes nothing now: ${props.m.why ?? 'unknown'}`))
</script>

<template>
  <div class="machine-load" :data-state="m.state" data-testid="machine-load">
    <span class="load-head">
      <span class="card-state" :class="SQUARE[m.state]" aria-hidden="true"><i /></span>
      <span class="mono-label">{{ tl(STATE[m.state]) }}</span>
      <small v-if="m.hours" class="mono-label">{{ tl(`Available ${m.hours}`) }}</small>
    </span>
    <template v-if="m.memory">
      <span class="load-bar" role="img" :aria-label="tl(`Memory: ${gb(m.memory.agents)} its agents, ${gb(m.memory.other)} the rest, ${gb(m.memory.free)} free of ${gb(m.memory.total)}`)">
        <i class="seg-agents" :style="{ width: pct(m.memory.agents) }" />
        <i class="seg-other" :style="{ width: pct(m.memory.other) }" />
        <i class="seg-reserve" :style="{ width: pct(m.memory.reserve) }" />
      </span>
      <small class="load-legend mono">
        <span><i class="key seg-agents" />{{ tl(`agents ${gb(m.memory.agents)}`) }}</span>
        <span><i class="key seg-other" />{{ tl(`rest ${gb(m.memory.other)}`) }}</span>
        <span><i class="key" />{{ tl(`${roomWord(m)} ${gb(m.memory.free)} of ${gb(m.memory.total)}`) }}</span>
        <span><i class="key seg-reserve" />{{ tl(`reserve ${gb(m.memory.reserve)}`) }}</span>
        <span v-if="m.cores">{{ tl(`${m.cores} cores, load ${(m.load ?? 0).toFixed(1)}`) }}</span>
        <span v-if="m.pressure">{{ tl(`pressure ${m.pressure}`) }}</span>
      </small>
    </template>
    <ul v-if="m.agents.length" class="load-agents" data-testid="machine-agents">
      <li v-for="(a, i) in m.agents" :key="i" class="mono">
        <span class="card-state working" aria-hidden="true"><i /></span>{{ a.task ?? tl('agent') }} <small class="mono-label">{{ tl(a.weight) }}</small>
      </li>
    </ul>
    <small class="load-count mono-label">{{ m.cap !== undefined ? tl(`${m.agents.length} of ${m.cap} agents`) : tl(`${m.agents.length} agents`) }}</small>
    <span class="load-takes" :class="{ none: !m.takes }" data-testid="machine-takes">{{ takes }}{{ m.unchecked && m.takes ? ` ${tl('(readiness checked before its first task)')}` : '' }}</span>
  </div>
</template>

<style scoped>
.machine-load { grid-column: 1 / -1; display: grid; gap: 6px; min-width: 0; }
.load-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.machine-load[data-state='online'] .load-head > .mono-label:first-of-type { color: var(--idle); }
.machine-load[data-state='paused'] .load-head > .mono-label:first-of-type { color: var(--blocked); }
.load-bar { position: relative; display: flex; height: 10px; border: 1px solid var(--line); background: var(--bg); overflow: hidden; }
.load-bar > i { display: block; height: 100%; }
.seg-agents { background: var(--working); }
.seg-other { background: var(--dim); }
/* The reserve: hatched over the end of the bar, whatever it covers. */
.seg-reserve { background: repeating-linear-gradient(135deg, var(--ochre) 0 2px, transparent 2px 5px); }
.load-bar > .seg-reserve { position: absolute; top: 0; right: 0; }
.load-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--muted); font-size: 12px; }
.load-legend span { display: inline-flex; align-items: center; gap: 5px; }
.key { display: inline-block; width: 8px; height: 8px; border: 1px solid var(--line); }
.load-agents { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.load-agents li { display: inline-flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.load-count { color: var(--muted); }
.load-takes { color: var(--green, var(--text)); overflow-wrap: anywhere; font-size: 13px; }
.load-takes.none { color: var(--ochre); }
</style>
