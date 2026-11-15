<script setup lang="ts">
// Table of remaining quotas (5-hour window and week), one row per account:
// at the top of the home screen (accounts shared by all machines) and under the header
// of a machine (its Claude account, when accounts differ). Same thin-line
// grid as the counters; the bar shows what remains, like a battery,
// or what is used (Settings → Appearance → Quotas). The color follows urgency.
// Reading older than an hour: age in ochre, numbers dimmed. A window whose
// value is no longer known (reset since the reading, or read longer ago than
// the window lasts, windowStale): dashed bar and `?` for the number, same
// height as any row; hovering or tapping it says how to refresh it. Window
// (5 h or week) missing from Claude's reading (it just restarted): "new window".
// `api`: Claude Code runs on API billing there (no rate limits): a muted
// label in place of the gauges, never a warning colour.
// Codex "limit reached" (shared/quotaLimit.ts): blocked until its reset; with
// credits on the account, work goes on with them; once its reset has passed,
// the reading no longer says blocked. The account's credits show under the row.
import type { Quota, QuotaWindow } from '#shared/types'
import { limitState } from '#shared/quotaLimit'
import { type QuotaRow, creditsText, quotaLevel, quotaShown, resetText, STALE_MS, windowStale } from '~/utils/quotas'

defineProps<{ rows: QuotaRow[], api?: boolean }>()

const now = quotaNow
const shown = (w: QuotaWindow) => quotaShown(w, now.value, quotaDisplay.value)
const level = (w: QuotaWindow) => quotaLevel(w, now.value)
const stale = (r: QuotaRow) => now.value - r.q.at > STALE_MS
const unknown = (w: QuotaWindow, r: QuotaRow) => windowStale(w, r.q.at, now.value)
const refreshTip = (r: QuotaRow) => tl(`Last read ${ago(r.q.at)}: send a message to a ${kindLabel(r.agent)} agent to refresh`)
// Tooltip of a `?` window: hover on a computer, a tap on a phone.
const tipOpen = ref<string | null>(null)
function resetLabel(w: QuotaWindow) {
  if (w.fresh) return t('new window')
  const s = resetText(w, now.value, language)
  return s === null ? t('reset') : s || '—'
}
const limit = (q: Quota) => limitState(q, now.value)
// Codex hit its usage limit: no gauges, the reset time from its message.
function limitedLabel(q: Quota) {
  const resetsAt = q.limited!.resetsAt
  let text = ''
  if (resetsAt) {
    const d = new Date(resetsAt)
    const time = d.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })
    text = Math.abs(resetsAt - now.value) < 86400000 ? time : `${d.toLocaleDateString(language, { weekday: 'short' })} ${time}`
  }
  const state = limit(q)
  if (state === 'expired') return text ? tl(`Reset since the last reading (limit lifted ${text})`) : tl('Limit over since the last reading')
  if (state === 'credits') return tl(`Limit reached · work goes on with ${creditsText(q.credits!)}`)
  return text ? tl(`Limit reached · resets ${text}`, `Limite atteinte · réinitialisation ${text}`) : tl('Limit reached', 'Limite atteinte')
}
// Line under the row: the credits, when the limit line does not already say them.
const note = (r: QuotaRow) => (r.q.credits && limit(r.q) !== 'credits' ? tl(`Credits: ${creditsText(r.q.credits)}`) : '')
// Short age of the reading, under each row's logo ("3 min", "2 h").
function agoShort(at: number) {
  const m = Math.round((now.value - at) / 60000)
  if (m < 1) return '< 1 min'
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : tl(`${Math.round(h / 24)} d`, `${Math.round(h / 24)} j`)
}
function ago(at: number) {
  const m = Math.round((now.value - at) / 60000)
  if (m < 1) return t('just now')
  if (m < 60) return tl(`${m} min ago`, `il y a ${m} min`)
  const h = Math.round(m / 60)
  return h < 48 ? tl(`${h} h ago`, `il y a ${h} h`) : tl(`${Math.round(h / 24)} d ago`, `il y a ${Math.round(h / 24)} j`)
}
</script>

<template>
  <section v-if="rows.length || api" class="quotas" :aria-label="t(quotaDisplay === 'used' ? 'Used quotas' : 'Remaining quotas')">
    <div v-if="api" class="quota-row quota-api" data-testid="quota-claude-api">
      <div class="quota-who" :title="kindLabel('claude')">
        <AgentAvatar agent="claude" />
      </div>
      <p class="quota-api-label">{{ tl('Claude · API usage, no quota', 'Claude · usage API, pas de quota') }}</p>
    </div>
    <div v-for="r in rows" :key="r.key" class="quota-row" :class="{ stale: stale(r), 'quota-api': r.q.limited }">
      <div class="quota-who" :title="`${kindLabel(r.agent)} · ${t('updated')} ${ago(r.q.at)}`">
        <AgentAvatar :agent="r.agent" />
        <small><UIcon v-if="stale(r)" name="i-lucide-clock-alert" />{{ agoShort(r.q.at) }}</small>
      </div>
      <p v-if="r.q.limited" class="quota-api-label" :class="{ 'quota-limited': limit(r.q) === 'reached' }" :title="stale(r) ? refreshTip(r) : undefined" data-testid="quota-limited">{{ limitedLabel(r.q) }}</p>
      <template v-else>
      <template v-for="(w, k) in { five: r.q.five, week: r.q.week }" :key="k">
        <div
          v-if="w && unknown(w, r)" class="quota guessed" :class="{ open: tipOpen === `${r.key}-${k}` }" tabindex="0"
          :aria-label="refreshTip(r)" data-testid="quota-unknown" @click="tipOpen = tipOpen === `${r.key}-${k}` ? null : `${r.key}-${k}`" @blur="tipOpen = null"
        >
          <div class="quota-top">
            <span class="quota-label">{{ k === 'five' ? '5 h' : t('Week') }}</span>
            <b>?</b>
          </div>
          <div class="quota-bar"><i :style="{ width: `${shown(w)}%` }" /></div>
          <div class="quota-reset"><UIcon name="i-lucide-rotate-cw" />{{ resetLabel(w) }}</div>
          <span class="quota-tip" role="tooltip">{{ refreshTip(r) }}</span>
        </div>
        <div v-else-if="w" class="quota" :class="level(w)">
          <div class="quota-top">
            <span class="quota-label">{{ k === 'five' ? '5 h' : t('Week') }}</span>
            <b>{{ shown(w) }}<small>%</small></b>
          </div>
          <div class="quota-bar"><i :style="{ width: `${shown(w)}%` }" /></div>
          <div class="quota-reset"><UIcon name="i-lucide-rotate-cw" />{{ resetLabel(w) }}</div>
        </div>
        <div v-else class="quota empty" />
      </template>
      </template>
      <p v-if="note(r)" class="quota-note" data-testid="quota-note">{{ note(r) }}</p>
    </div>
  </section>
</template>
