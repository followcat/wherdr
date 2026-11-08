<script setup lang="ts">
// One level from the scale (Muted → All activity), with the fine events
// folded under "Customize". Used by the default and by every exception.
import { LEVEL_EVENTS, NOTIFICATION_EVENTS, NOTIFICATION_LEVELS, levelOf, type NotificationEvent, type NotificationLevel } from '#shared/notificationRules'
const props = defineProps<{ events: NotificationEvent[], label: string, muted?: boolean }>()
const emit = defineEmits<{ change: [events: NotificationEvent[]] }>()
const level = computed(() => props.muted ? 'muted' : levelOf(props.events))
const items = computed(() => [
  ...(level.value === 'custom' ? [{ label: levelLabel('custom'), value: 'custom', disabled: true }] : []),
  ...NOTIFICATION_LEVELS.map(l => ({ label: levelLabel(l), value: l })),
])
function pick(value: string) { emit('change', [...LEVEL_EVENTS[value as NotificationLevel]]) }
function toggle(event: NotificationEvent, on: boolean) {
  emit('change', NOTIFICATION_EVENTS.filter(e => e === event ? on : props.events.includes(e)))
}
</script>

<template>
  <div class="notification-level">
    <USelect :model-value="level" :items="items" size="lg" class="w-full" :aria-label="label" data-testid="notification-level" @update:model-value="v => pick(String(v))" />
    <small class="notification-level-hint">{{ level === 'custom' ? t('Only the events checked under Customize.') : levelHint(level) }}</small>
    <details class="notification-customize" :open="level === 'custom' || undefined">
      <summary><UIcon name="i-lucide-chevron-right" class="notification-chev" />{{ t('Customize') }}</summary>
      <div class="notification-events">
        <label v-for="event in NOTIFICATION_EVENTS" :key="event"><input type="checkbox" :checked="!muted && events.includes(event)" @change="toggle(event, ($event.target as HTMLInputElement).checked)"> {{ eventLabel(event) }}</label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.notification-level { display:flex; flex-direction:column; gap:6px; min-width:0; }
.notification-level-hint { color:var(--muted); font-size:12px; }
.notification-customize summary { cursor:pointer; min-height:36px; display:flex; align-items:center; gap:4px; color:var(--muted); font-size:13px; list-style:none; }
.notification-customize summary::-webkit-details-marker { display:none; }
.notification-chev { transition:transform .15s; }
.notification-customize[open] .notification-chev { transform:rotate(90deg); }
.notification-events { display:flex; flex-wrap:wrap; gap:4px 18px; }
.notification-events label { display:flex; align-items:center; min-height:44px; gap:6px; }
.notification-events input { accent-color:var(--accent); }
</style>
