<script setup lang="ts">
// One autopilot routine (CoordinatorAutopilot's Routines, saved with the form):
// its switch, when it wakes the coordinator and its own goal on one line; Edit
// opens it in place. When: days of the week and a time, or Advanced, any fixed
// time shared/pm/schedule.ts reads (a cron).
import type { Routine } from '#shared/pm/autopilot'

const r = defineModel<Routine>({ required: true })
const props = defineProps<{ open?: boolean }>()
const emit = defineEmits<{ remove: [] }>()
const editing = ref(!!props.open)
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }
const WEEKDAYS = DAYS.slice(0, 5)
// The picker's days and time, read from `daily 08:00` or `mon,thu 09:00`; null: an advanced one.
function simple(when: string) {
  const m = /^(daily|[a-z]{3}(?:,[a-z]{3})*) (\d{1,2}):(\d{2})$/.exec(when.trim().toLowerCase())
  const days = m?.[1] === 'daily' ? DAYS : m?.[1]!.split(',') ?? []
  return m && days.every(d => DAYS.includes(d)) ? { days, time: `${m[2]!.padStart(2, '0')}:${m[3]}` } : null
}
const whenOf = (days: string[], time: string) => `${days.length === 7 ? 'daily' : DAYS.filter(d => days.includes(d)).join(',')} ${time}`
const picked = computed(() => simple(r.value.when))
const advanced = ref(!picked.value && !!r.value.when)
const days = computed(() => picked.value?.days ?? DAYS)
const time = computed(() => picked.value?.time ?? '09:00')
const patch = (p: Partial<Routine>) => { r.value = { ...r.value, ...p } }
const setDays = (d: string[]) => { if (d.length) patch({ when: whenOf(d, time.value) }) }
const toggleDay = (d: string) => setDays(days.value.includes(d) ? days.value.filter(x => x !== d) : [...days.value, d])
const setAdvanced = (on: boolean) => { advanced.value = on; if (!on && !picked.value) patch({ when: whenOf(DAYS, '09:00') }) }
const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const label = computed(() => {
  const p = picked.value
  if (!p) return r.value.when || tl('No time set')
  const d = same(p.days, DAYS) ? tl('Every day') : same(p.days, WEEKDAYS) ? tl('Weekdays') : DAYS.filter(x => p.days.includes(x)).map(x => tl(DAY_LABEL[x]!)).join(', ')
  return `${d} · ${p.time}`
})
</script>

<template>
  <div class="rt" :data-editing="editing ? '' : undefined" data-testid="autopilot-routine">
    <div class="rt-head">
      <USwitch :model-value="r.on" size="lg" :aria-label="tl('Routine on')" data-testid="routine-on" @update:model-value="patch({ on: $event })" />
      <button type="button" class="rt-sum" :aria-expanded="editing" @click="editing = !editing">
        <span class="mono-label">{{ label }}</span>
        <span class="rt-goal" :class="{ muted: !r.goal }">{{ r.goal || tl('No goal of its own: the autopilot\'s') }}</span>
      </button>
      <UButton type="button" color="neutral" variant="ghost" size="lg" :icon="editing ? 'i-lucide-chevron-up' : 'i-lucide-pencil'" :aria-label="editing ? tl('Close') : tl('Edit')" data-testid="routine-edit" @click="editing = !editing" />
      <UButton type="button" color="error" variant="ghost" size="lg" icon="i-lucide-trash-2" :aria-label="tl('Delete')" data-testid="routine-delete" @click="emit('remove')" />
    </div>
    <div v-if="editing" class="rt-edit">
      <template v-if="!advanced">
        <div class="rt-days" role="group" :aria-label="tl('Days')">
          <UButton v-for="d in DAYS" :key="d" type="button" size="lg" color="neutral" :variant="days.includes(d) ? 'solid' : 'outline'" :aria-pressed="days.includes(d)" :data-testid="`routine-day-${d}`" @click="toggleDay(d)">{{ tl(DAY_LABEL[d]!) }}</UButton>
        </div>
        <div class="rt-row">
          <UButton type="button" size="lg" color="neutral" variant="link" @click="setDays(DAYS)">{{ tl('Every day') }}</UButton>
          <UButton type="button" size="lg" color="neutral" variant="link" @click="setDays(WEEKDAYS)">{{ tl('Weekdays') }}</UButton>
          <UInput type="time" :model-value="time" size="xl" class="mono rt-time" :aria-label="tl('Time')" data-testid="routine-time" @update:model-value="patch({ when: whenOf(days, String($event) || '09:00') })" />
        </div>
      </template>
      <UInput v-else :model-value="r.when" size="xl" class="w-full mono" placeholder="0 8 * * 1-5" maxlength="60" autocapitalize="none" autocorrect="off" :spellcheck="false" :aria-label="tl('When (cron)')" data-testid="routine-cron" @update:model-value="patch({ when: String($event) })" />
      <USwitch :model-value="advanced" size="lg" :label="tl('Advanced')" :description="tl('A cron (minute hour day month weekday) or a list like mon,thu 09:00.')" data-testid="routine-advanced" @update:model-value="setAdvanced" />
      <UTextarea :model-value="r.goal" :rows="1" autoresize :maxrows="4" size="xl" class="w-full" :maxlength="500" :aria-label="tl('Routine goal')" data-testid="routine-goal"
        :placeholder="tl('What the coordinator does then, e.g. Summarise the night\'s work for me')" @update:model-value="patch({ goal: String($event) })" />
    </div>
  </div>
</template>

<style scoped>
.rt { display: grid; gap: 8px; min-width: 0; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
.rt-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rt-sum { display: grid; flex: 1; gap: 2px; min-width: 0; min-height: 44px; padding: 0; text-align: left; background: none; border: 0; color: var(--text); cursor: pointer; }
.rt-sum .mono-label { color: var(--text-2); }
.rt-goal { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt[data-editing] .rt-goal { white-space: normal; overflow-wrap: anywhere; }
.rt-edit { display: grid; gap: 8px; min-width: 0; }
.rt-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.rt-days > button { justify-content: center; min-height: 44px; padding-inline: 0; }
.rt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.rt-time { width: min(100%, 140px); margin-left: auto; }
</style>
