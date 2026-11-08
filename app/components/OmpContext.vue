<script setup lang="ts">
// omp's context usage (its own gauge, read from the screen by the server).
// bar: a 2px line along the bottom of an agent card; head: a gauge in the
// conversation header, its details on click; text: the figures alone (inside
// the phone header, which is already a button and narrow: the percentage alone).
import type { Pane } from '#shared/types'
import { parseOmpContext } from '#shared/ompStatus'

const props = defineProps<{ pane: Pane, variant: 'bar' | 'head' | 'text' }>()
const context = computed(() => props.pane.agent === 'omp' ? parseOmpContext(props.pane.ompStatus?.meters) : null)
const stale = computed(() => props.pane.status !== 'working' || props.pane.ompStatus?.metersFresh !== true)
const width = computed(() => `${Math.min(context.value?.pct ?? 0, 100)}%`)
const short = computed(() => context.value ? `${Math.round(context.value.pct)}% · ${Math.round(context.value.estimated / 1000)}K` : '')
const label = computed(() => {
  const c = context.value
  if (!c) return ''
  const detail = tl(
    `Context: ${c.pct}% of ${c.total.toLocaleString()} tokens. About ${Math.round(c.estimated).toLocaleString()} tokens, estimated from the rounded percentage.`,
    `Contexte : ${c.pct} % de ${c.total.toLocaleString()} tokens. Environ ${Math.round(c.estimated).toLocaleString()} tokens, estimés à partir du pourcentage arrondi.`,
  )
  return stale.value ? `${detail} ${tl('Last reading, not live.', 'Dernière mesure, pas en direct.')}` : detail
})
const open = ref(false)
</script>

<template>
  <template v-if="context">
    <span
      v-if="variant === 'bar'" class="omp-context-bar" :class="{ 'last-known': stale, mid: context.pct >= 60, hi: context.pct >= 85 }"
      role="progressbar" :aria-label="label" :aria-valuenow="Math.min(context.pct, 100)" aria-valuemin="0" aria-valuemax="100" :style="{ width }"
    />
    <span v-else-if="variant === 'text'" class="omp-context-text" :class="{ 'last-known': stale }">{{ Math.round(context.pct) }}%</span>
    <UPopover v-else v-model:open="open" :content="{ side: 'bottom', align: 'start' }">
      <button type="button" class="omp-context" :class="{ 'last-known': stale, mid: context.pct >= 60, hi: context.pct >= 85 }" :title="label" :aria-label="label" @click.stop @pointerdown.stop>
        <span class="omp-context-gauge" aria-hidden="true"><i :style="{ width }" /></span>{{ short }}
      </button>
      <template #content>
        <div class="omp-context-detail" role="status" tabindex="0" @keydown.esc.stop.prevent="open = false">
          <p>{{ label }}</p>
          <p v-if="pane.ompStatus?.line" class="omp-context-status">{{ pane.ompStatus.line }}</p>
          <!-- The older footer also carries quota gauges; the ▶…◀ bar adds nothing to the figures. -->
          <p v-if="pane.ompStatus?.meters && !pane.ompStatus.meters.startsWith('▶')" class="omp-context-status">{{ pane.ompStatus.meters }}</p>
        </div>
      </template>
    </UPopover>
  </template>
</template>

<style scoped>
.omp-context-bar { position: absolute; left: 0; bottom: 0; height: 2px; pointer-events: none; background: var(--green); }
.omp-context-bar.mid, .omp-context.mid .omp-context-gauge i { background: var(--ochre); }
.omp-context-bar.hi, .omp-context.hi .omp-context-gauge i { background: var(--rose); }
.omp-context-bar.last-known, .omp-context.last-known .omp-context-gauge i { opacity: .5; }
.omp-context {
  position: relative; display: inline-flex; align-items: center; gap: 6px; flex: none; padding: 0; border: 0; background: none; cursor: pointer;
  font: 400 11px/1.2 var(--mono); color: var(--text-3); white-space: nowrap; font-variant-numeric: tabular-nums;
}
.omp-context::before { content: '·'; color: var(--dim); }
/* A taller touch target than the 11px line. */
.omp-context::after { content: ''; position: absolute; inset: -8px 0; }
.omp-context-gauge { position: relative; width: 24px; height: 6px; border: 1px solid var(--line); overflow: hidden; }
.omp-context-gauge i { position: absolute; inset: 0 auto 0 0; background: var(--green); }
.omp-context-text { white-space: nowrap; font-variant-numeric: tabular-nums; }
.omp-context-text.last-known { color: var(--dim); }
.omp-context-detail { width: min(300px, 80vw); padding: 10px; color: var(--text); font-size: 12px; white-space: normal; overflow-wrap: anywhere; }
.omp-context-status { margin-top: 8px; color: var(--muted); font-family: var(--mono); }
</style>
