<script setup lang="ts">
// Devin's /usage, /context or /session-stats, kept by wherdr (shared/devinCommandCards.ts):
// the command as a chip, the title, its rows, and bars drawn here for the
// percentages. A block of a shape wherdr does not know shows its text, wrapped.
import type { DevinCommandCard } from '#shared/types'

const props = defineProps<{ card: DevinCommandCard, time?: string | null, ts?: string | null }>()
const title = computed(() => props.card.kind === 'usage' ? t('Usage')
  : props.card.kind === 'context' ? t('Context usage')
    : props.card.kind === 'stats' ? t('Session stats') : '')
const fill = (percent: number) => ({ width: `${Math.min(Math.max(percent, 0), 100)}%` })
</script>

<template>
  <article class="devin-card" data-testid="devin-card">
    <header class="devin-head">
      <span class="devin-chip">{{ card.command }}</span>
      <span v-if="title" class="devin-title">{{ title }}</span>
      <time v-if="time" class="devin-time" :datetime="ts || undefined">{{ time }}</time>
    </header>
    <div v-if="card.kind === 'usage'" class="devin-body">
      <ul class="devin-rows">
        <li v-for="w in card.windows" :key="w.label" class="devin-window">
          <span class="devin-label">{{ w.label }}</span>
          <span class="devin-meter" role="meter" :aria-valuenow="w.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`${w.percent}%`"><i :style="fill(w.percent)" /></span>
          <span class="devin-value">{{ w.percent }}%</span>
          <span class="devin-reset">{{ w.reset }}</span>
        </li>
      </ul>
      <template v-if="card.session.length">
        <p class="devin-sub">{{ t('This session') }}</p>
        <dl class="devin-session">
          <div v-for="r in card.session" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></div>
        </dl>
      </template>
      <p v-if="card.note" class="devin-note">{{ card.note }}</p>
    </div>
    <div v-else-if="card.kind === 'context'" class="devin-body">
      <p v-if="card.model" class="devin-model">{{ card.model }}</p>
      <ul class="devin-rows">
        <li v-for="c in card.categories" :key="c.label" class="devin-share">
          <span class="devin-label">{{ c.label }}</span>
          <span class="devin-meter" role="meter" :aria-valuenow="c.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`${c.percent}%`"><i :style="fill(c.percent)" /></span>
          <span class="devin-value">{{ c.value }}</span>
          <span class="devin-value devin-pct">{{ c.percent }}%</span>
        </li>
      </ul>
      <p v-if="card.total" class="devin-total">
        <span class="devin-label">{{ t('Total') }}</span>
        <span class="devin-meter" role="meter" :aria-valuenow="card.total.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`${card.total.percent}%`"><i :style="fill(card.total.percent)" /></span>
        <span class="devin-value">{{ card.total.used }}/{{ card.total.limit }} {{ card.total.percent }}%</span>
      </p>
    </div>
    <div v-else-if="card.kind === 'stats'" class="devin-body">
      <dl v-if="card.rows.length" class="devin-session">
        <div v-for="r in card.rows" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></div>
      </dl>
      <template v-if="card.models.length">
        <p class="devin-sub">{{ t('Tokens by model') }}</p>
        <ul class="devin-rows">
          <li v-for="m in card.models" :key="m.label" class="devin-share">
            <span class="devin-label">{{ m.label }}</span>
            <span class="devin-meter" role="meter" :aria-valuenow="m.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`${m.percent}%`"><i :style="fill(m.percent)" /></span>
            <span class="devin-value">{{ m.value }}</span>
            <span class="devin-value devin-pct">{{ m.percent }}%</span>
          </li>
        </ul>
      </template>
      <p v-if="card.total" class="devin-total">
        <span class="devin-label">{{ t('Total') }}</span>
        <span class="devin-value">{{ card.total }}</span>
      </p>
    </div>
    <pre v-else class="devin-text">{{ card.lines.join('\n') }}</pre>
  </article>
</template>

<style scoped>
.devin-card { width: min(100%, 440px); min-width: 0; background: var(--bg-2); border: 1px solid var(--line); color: var(--text); font-size: 13px; }
.devin-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.devin-chip { flex: none; padding: 1px 5px; border: 1px solid var(--line); font: 500 11px/1.4 var(--mono); color: var(--text-2); }
.devin-title { min-width: 0; font: 600 10px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--text-2); overflow-wrap: anywhere; }
.devin-time { margin-left: auto; flex: none; font: 400 11px/1.2 var(--mono); color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
.devin-body { display: grid; gap: 8px; min-width: 0; padding: 8px 10px 10px; }
.devin-sub, .devin-model { margin: 0; font: 600 10px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); overflow-wrap: anywhere; }
.devin-rows { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.devin-window, .devin-share { display: grid; grid-template-columns: minmax(0, 7.5em) minmax(40px, 1fr) auto; align-items: center; gap: 2px 8px; min-width: 0; }
.devin-share { grid-template-columns: minmax(0, 7.5em) minmax(40px, 1fr) auto auto; }
.devin-reset { grid-column: 2 / -1; min-width: 0; font: 400 11px/1.35 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.devin-label { min-width: 0; font: 400 12px/1.35 var(--sans); color: var(--text); overflow-wrap: anywhere; }
.devin-meter { position: relative; display: block; height: 6px; min-width: 40px; background: var(--line-soft); }
.devin-meter i { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
.devin-value { font: 400 11.5px/1.35 var(--mono); color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.devin-pct { min-width: 3.2em; text-align: right; }
.devin-note { margin: 0; font: 400 12px/1.4 var(--sans); color: var(--muted); overflow-wrap: anywhere; }
.devin-session { display: grid; gap: 3px; margin: 0; min-width: 0; }
.devin-session > div { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; column-gap: 8px; min-width: 0; }
.devin-session dt { flex: none; margin: 0; font: 400 12px/1.35 var(--sans); color: var(--text); }
.devin-session dd { flex: 1 1 auto; min-width: 0; margin: 0; font: 400 11.5px/1.35 var(--mono); color: var(--text-2); text-align: right; overflow-wrap: anywhere; }
.devin-total { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin: 0; padding-top: 6px; border-top: 1px solid var(--line); min-width: 0; }
.devin-total .devin-label { flex: none; }
.devin-total .devin-meter { flex: 1 1 40px; }
.devin-total .devin-value { margin-left: auto; }
.devin-text { margin: 0; padding: 8px 10px 10px; font: 400 11.5px/1.45 var(--mono); color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
