<script setup lang="ts">
// Settings › Pace: one account's week on a UChart (WHR-557): the weekly %
// used since the last reset, the mode's target line (or 'free''s reserve
// limit; none in 'Free'), and now. Missing readings stay a gap: usage starts
// at the week's first reading.
import { defineChart, lineY, ruleX, ruleY } from '@tanstack/charts'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import type { WeekSeries } from '#shared/pacingChart'

const props = defineProps<{ series: WeekSeries }>()

const DAY = 86_400_000
const pctText = (v: number) => `${Math.round(v)} %`
const target = computed(() => (props.series.target ?? []).map(p => ({ ...p, k: 'target' })))
// One tick per local midnight of the week.
const days = computed(() => {
  const out: number[] = []
  const d = new Date(props.series.from)
  d.setHours(24, 0, 0, 0)
  for (let t = d.getTime(); t < props.series.to; t += DAY) out.push(new Date(t).setHours(0, 0, 0, 0))
  return out
})
const dayText = (t: number) => new Date(t).toLocaleDateString(language, { weekday: 'short' })
const targetName = computed(() => props.series.label === 'reserve' ? tl('Reserve limit') : tl('Target line'))

const definition = computed(() => defineChart({
  marks: [
    // The frame of the week: 0 to 100 %, last reset to the next one.
    ruleY([0, 100], { stroke: 'var(--line)', strokeWidth: 1 }),
    ruleX([props.series.from, props.series.to], { stroke: 'var(--line)', strokeWidth: 1 }),
    ...(target.value.length ? [lineY(target.value, { x: 't', y: 'v', z: 'k', stroke: 'var(--text-2)', strokeWidth: 1.5, strokeDasharray: '4 3' })] : []),
    // One line per segment: a missing reading stays a gap.
    ...props.series.usage.map((seg, i) => lineY(seg, { id: `used-${i}`, x: 't', y: 'v', stroke: 'var(--teal)', strokeWidth: 2 })),
    ruleX([props.series.now], { stroke: 'var(--ochre)', strokeWidth: 1.5 }),
  ],
  scales: {
    x: { scale: scaleLinear, axis: { ticks: { values: days.value, format: dayText } } },
    y: { scale: scaleLinear, grid: true, axis: { ticks: { values: [0, 50, 100], format: pctText } } },
  },
  svgAnimation: false,
}))
const label = computed(() => {
  const last = props.series.usage[props.series.usage.length - 1]?.at(-1)
  const tgt = props.series.target?.filter(p => p.t <= props.series.now).pop()
  return [
    tl('Weekly quota this week'),
    last ? tl(`${pctText(last.v)} used`) : tl('no reading yet'),
    tgt ? `${targetName.value} ${pctText(tgt.v)}` : '',
  ].filter(Boolean).join(' · ')
})
</script>

<template>
  <figure class="pace-chart" data-testid="pace-chart">
    <UChart :definition="definition" :height="140" :tooltip="false" :aria-label="label" :ui="{ root: 'rounded-none' }" />
    <figcaption class="pace-legend mono-label">
      <span><i class="used" />{{ tl('Used') }}</span>
      <span v-if="series.target" data-testid="pace-chart-target"><i class="target" />{{ targetName }}</span>
      <span><i class="now" />{{ tl('Now') }}</span>
      <span v-if="!series.usage.length" data-testid="pace-chart-empty">{{ tl('No reading this week yet') }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.pace-chart { margin: 0; color: var(--text-2); font: 500 11px var(--font-mono); }
.pace-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; }
.pace-legend span { display: inline-flex; align-items: center; gap: 6px; }
.pace-legend i { display: inline-block; width: 14px; height: 0; border-top: 2px solid var(--teal); }
.pace-legend i.target { border-top: 2px dashed var(--text-2); }
.pace-legend i.now { width: 0; height: 10px; border-top: 0; border-left: 2px solid var(--ochre); }
</style>
