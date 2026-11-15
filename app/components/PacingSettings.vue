<script setup lang="ts">
// Settings › Agents › Pace: one row per quota account. The weekly bar with the target
// line (or the reserve's limit), today's use, the 5-hour window, the mode and
// its settings ('Free' has none: no line, no reserve, no burn), the end-of-week burn, the account's name, and whether automatic
// work may start now.
// A program with no reading at all shows 'Quota unknown'.
import type { PaceRow } from '#shared/pm/pace'
import { burning, type PaceMode, type PacePolicy, type PaceReason } from '#shared/pm/pacing'
import { defaultAccountName } from '#shared/quotaAccount'
import { creditsText } from '~/utils/quotas'

const props = defineProps<{ active: boolean }>()
const rows = ref<PaceRow[] | null>(null)
const error = ref('')
const busy = ref('')
const open = ref<string | null>(null)
const names = reactive<Record<string, string>>({})

async function load() {
  error.value = ''
  try { set(await api<{ rows: PaceRow[] }>('/api/pacing')) }
  catch (e) { error.value = (e as Error).message }
}
function set(v: { rows: PaceRow[] }) {
  rows.value = v.rows
  for (const r of v.rows) if (r.account) names[r.account.key] = r.account.name ?? ''
}
watch(() => props.active, (on) => { if (on) load() }, { immediate: true })

async function run(what: string, fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const change = (key: string, policy: Partial<Omit<PacePolicy, 'burn'>> & { burn?: PacePolicy['burn'] | null }) => run(key, async () => set(await api<{ rows: PaceRow[] }>('/api/pacing', { key, policy })))
function rename(r: PaceRow) {
  const a = r.account
  if (!a || names[a.key]!.trim() === (a.name ?? '')) return
  run(`name:${a.key}`, async () => {
    await api('/api/quotas/name', { key: a.key, name: names[a.key]!.trim() })
    await load()
  })
}
// A number field saves only a whole number in its range; anything else (an
// emptied field included) keeps the saved value and says why.
type NumField = 'cap' | 'reserve5h' | 'reservePerDay'
const RANGES: Record<NumField, [number, number]> = { cap: [10, 100], reserve5h: [0, 90], reservePerDay: [0, 14] }
const invalid = ref<{ key: string, field: NumField } | null>(null)
function setNumber(r: PaceRow, field: NumField, e: Event) {
  const el = e.target as HTMLInputElement
  const [lo, hi] = RANGES[field]
  const n = Number(el.value)
  if (el.value.trim() === '' || !Number.isInteger(n) || n < lo || n > hi) {
    el.value = String(r.policy[field])
    invalid.value = { key: r.account!.key, field }
    return
  }
  invalid.value = null
  change(r.account!.key, { [field]: n })
}

// End-of-week burn: on until the weekly reset of the reading (none: it cannot start).
const unlimited = (r: PaceRow) => r.policy.mode === 'unlimited'
const burnOn = (r: PaceRow) => !unlimited(r) && burning(r.policy.burn, Date.now())
const toggleBurn = (r: PaceRow, on: boolean) => change(r.account!.key, { burn: on && r.week ? { until: r.week.resetsAt } : null })
// 'Burning until Sun 19:00'.
const burnText = (r: PaceRow) => burnOn(r) ? tl(`Burning until ${when(r.policy.burn!.until)}`) : ''
const invalidText = (field: NumField) => tl(`Enter a whole number from ${RANGES[field][0]} to ${RANGES[field][1]}: the saved value is kept.`, `Saisis un nombre entier de ${RANGES[field][0]} à ${RANGES[field][1]} : la valeur enregistrée est gardée.`)
// Working days: the last chosen day stays on (with none, automatic work would wait until the reset).
const lastDay = (r: PaceRow, d: number) => r.policy.days.length === 1 && r.policy.days[0] === d
const toggleDay = (r: PaceRow, d: number) => {
  if (lastDay(r, d)) return
  change(r.account!.key, { days: r.policy.days.includes(d) ? r.policy.days.filter(x => x !== d) : [...r.policy.days, d] })
}

const modeItems = computed(() => [
  { value: 'unlimited', label: t('Free') },
  { value: 'free', label: tl('Free with reserve', 'Libre avec réserve') },
  { value: 'everyday', label: tl('Every day', '7/7') },
  { value: 'workdays', label: tl('Working days', 'Jours ouvrés') },
] satisfies { value: PaceMode, label: string }[])
// Monday first.
const days = computed(() => [1, 2, 3, 4, 5, 6, 0].map(d => ({ d, label: new Date(2026, 0, 4 + d).toLocaleDateString(language, { weekday: 'short' }) })))

const machineName = (key: string) => key ? (appConfig.value.machines?.find(m => m.key === key)?.label || key) : (appConfig.value.hostLabel || t('This machine'))
const pct = (n: number) => `${Math.round(n)} %`
// Same reading as the quota table (Settings › Appearance › Quotas): what is used, or what is left.
const used = computed(() => quotaDisplay.value === 'used')
const shown = (usedPct: number) => used.value ? usedPct : 100 - usedPct
const amount = (usedPct: number) => used.value ? tl(`${pct(usedPct)} used`, `${pct(usedPct)} utilisés`) : tl(`${pct(100 - usedPct)} left`, `${pct(100 - usedPct)} restants`)
const barStyle = (usedPct: number) => ({ width: `${Math.min(100, Math.max(0, shown(usedPct)))}%` })
const tickStyle = (usedPct: number) => ({ left: `${Math.min(100, Math.max(0, shown(usedPct)))}%` })
const when = (ms: number) => new Date(ms).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const limitLabel = (r: PaceRow) => r.week?.label === 'line' ? tl('line', 'ligne') : tl('limit', 'limite')
function reasonText(reason: PaceReason) {
  const text: Record<PaceReason, [string, string]> = {
    limited: ['limit reached', 'limite atteinte'],
    ahead: ['ahead of the line', 'en avance sur la ligne'],
    reserveWeek: ['weekly reserve', 'réserve semaine'],
    reserve5h: ['5 h reserve', 'réserve 5 h'],
    stale: ['reading too old', 'relevé trop vieux'],
  }
  return tl(...text[reason])
}
function state(r: PaceRow) {
  const v = r.verdict
  if (v.go) return tl('Auto: go', 'Auto : go')
  const until = v.until ? tl(` until ${when(v.until)}`, ` jusqu’à ${when(v.until)}`) : ''
  return tl(`Auto: waiting (${reasonText(v.reason)})`, `Auto : attend (${reasonText(v.reason)})`) + until
}
// Codex "limit reached" and the account's credits, under the bars.
function limitNote(r: PaceRow) {
  const credits = r.credits ? creditsText(r.credits) : ''
  if (r.limit === 'credits') return tl(`Limit reached · work goes on with ${credits}`)
  if (r.limit === 'expired') return tl(`Limit reset since the last reading${credits ? ` · ${credits}` : ''}`)
  return credits ? tl(`Credits: ${credits}`) : ''
}
const unknown = (r: PaceRow) => !r.account || (r.verdict.go && r.verdict.unknown)
</script>

<template>
  <div class="settings-group pace-settings" data-testid="pace-settings">
    <h3>{{ t('Pace') }}</h3>
    <SettingsSkeleton v-if="!rows" :error="error" @retry="load" />
    <p v-else-if="error" class="pace-error">{{ error }}</p>
    <div v-if="rows" class="settings-card pace-card">
      <div v-for="r in rows" :key="r.account?.key ?? r.program" class="pace-row" data-testid="pace-row">
        <template v-if="r.account">
          <div class="pace-head">
            <input
              v-model="names[r.account.key]" class="pace-name" maxlength="40" :placeholder="defaultAccountName(r.account.key)"
              :aria-label="tl('Account name', 'Nom du compte')" data-testid="pace-name"
              @blur="rename(r)" @keydown.enter="($event.target as HTMLInputElement).blur()"
            >
            <USelect
              :model-value="r.policy.mode" :items="modeItems" size="lg" class="pace-mode" :disabled="busy !== ''" :aria-label="tl('Mode', 'Mode')"
              data-testid="pace-mode" @update:model-value="v => change(r.account!.key, { mode: v as PaceMode })"
            />
          </div>
          <small class="mono-label">{{ r.program }} · {{ r.account.machines.map(machineName).join(', ') }}</small>
        </template>
        <small v-else class="mono-label">{{ r.program }}</small>

        <p v-if="unknown(r)" class="pace-unknown" data-testid="pace-unknown">
          {{ tl('Quota unknown: task-count limits only', 'Quota inconnu : limites en tâches seulement') }}
        </p>
        <template v-else>
          <div v-if="r.week" class="pace-line">
            <span class="mono-label">{{ tl('Week', 'Semaine') }}</span>
            <span class="pace-bar"><i :style="barStyle(r.week.used)" /><b v-if="r.week.label !== 'burn'" :style="tickStyle(r.week.limit)" /></span>
            <span class="pace-num" data-testid="pace-week">{{ amount(r.week.used) }} · {{ r.week.label === 'burn' ? t('no pace limit') : `${limitLabel(r)} ${amount(r.week.limit)}` }}</span>
          </div>
          <div v-if="r.five" class="pace-line">
            <span class="mono-label">5 h</span>
            <span class="pace-bar"><i :style="barStyle(r.five.used)" /><b v-if="!burnOn(r)" :style="tickStyle(unlimited(r) ? 100 : 100 - r.policy.reserve5h)" /></span>
            <span class="pace-num">{{ amount(r.five.used) }}</span>
          </div>
          <p class="pace-meta">
            <span v-if="r.today !== null">{{ tl('Today', 'Aujourd’hui') }} +{{ pct(r.today) }}</span>
            <span v-if="r.week">{{ tl('Reset', 'Reset') }} {{ when(r.week.resetsAt) }}</span>
            <span v-if="r.account && burnText(r)" class="pace-burn-on" data-testid="pace-burn-state">{{ burnText(r) }}</span>
            <span class="pace-state" :class="{ wait: !r.verdict.go }" data-testid="pace-state">{{ state(r) }}</span>
          </p>
        </template>
        <p v-if="limitNote(r)" class="pace-unknown" data-testid="pace-credits">{{ limitNote(r) }}</p>

        <template v-if="r.account && !unlimited(r)">
          <button type="button" class="pace-more mono-label" :aria-expanded="open === r.account.key" data-testid="pace-more" @click="open = open === r.account.key ? null : r.account.key">
            <UIcon :name="open === r.account.key ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />{{ tl('Mode settings', 'Réglages du mode') }}
          </button>
          <div v-if="open === r.account.key" class="pace-form">
            <div v-if="r.policy.mode === 'workdays'" class="pace-days" role="group" :aria-label="tl('Working days', 'Jours ouvrés')">
              <button
                v-for="d in days" :key="d.d" type="button" :class="{ on: r.policy.days.includes(d.d) }" :aria-pressed="r.policy.days.includes(d.d)"
                :disabled="busy !== '' || lastDay(r, d.d)" data-testid="pace-day" @click="toggleDay(r, d.d)"
              >
                {{ d.label }}
              </button>
            </div>
            <label v-if="r.policy.mode !== 'free'">{{ tl('Line cap', 'Plafond de la ligne') }} (%)
              <input class="pm-select" type="number" min="10" max="100" :value="r.policy.cap" data-testid="pace-cap" @change="setNumber(r, 'cap', $event)">
            </label>
            <label v-else>{{ tl('Weekly reserve per day left', 'Réserve semaine par jour restant') }} (%)
              <input class="pm-select" type="number" min="0" max="14" :value="r.policy.reservePerDay" data-testid="pace-per-day" @change="setNumber(r, 'reservePerDay', $event)">
            </label>
            <label>{{ tl('5 h reserve', 'Réserve 5 h') }} (%)
              <input class="pm-select" type="number" min="0" max="90" :value="r.policy.reserve5h" data-testid="pace-5h" @change="setNumber(r, 'reserve5h', $event)">
            </label>
            <label class="settings-toggle pace-burn">
              <span>
                <b>{{ t('End-of-week burn') }}</b>
                <small data-testid="pace-burn-hint">{{ burnText(r) || (r.week ? t('Until the weekly reset, automatic work runs with no pace limit; it turns off at the reset.') : t('Needs a quota reading to know the weekly reset.')) }}</small>
              </span>
              <USwitch :model-value="burnOn(r)" size="xl" :disabled="busy !== '' || (!r.week && !burnOn(r))" data-testid="pace-burn" @update:model-value="v => toggleBurn(r, v)" />
            </label>
            <p v-if="invalid?.key === r.account.key" class="pace-error" data-testid="pace-invalid">{{ invalidText(invalid.field) }}</p>
            <p v-if="r.policy.mode === 'workdays'" class="muted pace-hint">{{ tl('At least one day stays chosen. Days not chosen add nothing to the line.', 'Au moins un jour reste choisi. Les jours non choisis n’ajoutent rien à la ligne.') }}</p>
          </div>
        </template>
      </div>
    </div>
    <MachineMemorySettings v-if="active" />
    <p class="muted settings-hint">
      {{ tl('Automatic work (autopilot, automations) waits when an account is ahead of its pace. Your own starts never wait.', 'Le travail automatique (autopilote, automatisations) attend quand un compte est en avance sur son rythme. Tes propres lancements n’attendent jamais.') }}
    </p>
  </div>
</template>

<style scoped>
.pace-card { padding: 0 16px; }
.pace-row { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-top: 1px solid var(--line); }
.pace-row:first-child { border-top: 0; }
.pace-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pace-name { flex: 1 1 180px; min-width: 0; min-height: 44px; padding: 8px; border: 1px solid transparent; border-radius: 0; background: transparent; color: var(--text); font: 700 16px var(--font-display, inherit); text-transform: uppercase; letter-spacing: .02em; }
.pace-name:focus { border-color: var(--line); background: var(--bg); outline: none; }
.pace-head :deep(.pace-mode) { flex: 0 1 auto; min-width: 0; }
.pace-line { display: grid; grid-template-columns: 64px 1fr auto; gap: 10px; align-items: center; }
.pace-bar { position: relative; height: 6px; background: var(--line); }
.pace-bar i { display: block; height: 100%; background: var(--teal); }
.pace-bar b { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--text); } /* overflow-safe: centres a 2px marker inside the bar */
.pace-num { font: 500 13px var(--font-mono); white-space: nowrap; }
/* Phone: the numbers go under the bar, which keeps its full width. */
@media (max-width: 599px) {
  .pace-line { grid-template-columns: 52px 1fr; row-gap: 4px; }
  .pace-num { grid-column: 2; }
}
.pace-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; font: 500 12px var(--font-mono); color: var(--text-2); text-transform: uppercase; }
.pace-state { color: var(--green); }
.pace-burn-on { color: var(--ochre); }
.pace-form .pace-burn { flex-basis: 100%; flex-direction: row; }
.pace-state.wait { color: var(--ochre); }
.pace-unknown { margin: 0; font-size: 13px; color: var(--text-2); }
.pace-error, .pace-hint { flex-basis: 100%; margin: 0; font-size: 13px; }
.pace-error { color: var(--rose); }
.pace-more { display: flex; align-items: center; gap: 6px; align-self: flex-start; min-height: 32px; background: none; border: 0; padding: 0; cursor: pointer; }
.pace-form { display: flex; flex-wrap: wrap; gap: 12px; }
.pace-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }
.pace-form input { width: 120px; }
.pace-days { display: flex; flex-wrap: wrap; gap: 4px; flex-basis: 100%; }
.pace-days button { min-width: 44px; min-height: 36px; border: 1px solid var(--line); border-radius: 0; background: var(--bg); color: var(--text-2); font: 500 12px var(--font-mono); text-transform: uppercase; cursor: pointer; }
.pace-days button.on { border-color: var(--accent); color: var(--text); }
</style>
