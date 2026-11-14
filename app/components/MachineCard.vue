<script setup lang="ts">
// One machine in Settings › Machines, in fixed columns so every card lines up:
// name, state badge, then keep awake / rename / forget (an absent one keeps its
// slot); under it the keep-awake line, then the memory line and its settings.
import type { MachineInfo } from '#shared/types'

const props = defineProps<{ machine: Pick<MachineInfo, 'key' | 'label' | 'local' | 'status' | 'error'>, memory?: MemoryRow, busy?: boolean, editing?: boolean }>()
const emit = defineEmits<{ edit: [], cancel: [], save: [name: string], forget: [], reconnect: [] }>()
const STATE: Record<string, string> = { online: 'Connected', connecting: 'Connecting…', offline: 'Offline' }
const online = computed(() => props.machine.local || props.machine.status === 'online')
const newName = ref('')
watch(() => props.editing, (on) => { if (on) newName.value = props.machine.label })
const gb = (mb: number) => Math.round(mb / 102.4) / 10
// An empty field is Auto: its placeholder shows what wherdr picked.
const auto = (v?: number, unit = '') => v === undefined ? t('Auto') : `${t('Auto')} (${unit ? `≈${gb(v)} ${unit}` : v})`
const pickDays = (r: MemoryRow, e: Event) => {
  const v = (e.target as HTMLSelectElement).value
  return saveHours(r, v === 'always' ? null : { days: v as 'weekdays' | 'all' })
}
const time = (r: MemoryRow, field: 'from' | 'to', e: Event) => saveHours(r, { [field]: (e.target as HTMLInputElement).value })
</script>

<template>
  <div class="settings-card machine-card" :data-testid="machine.local ? 'local-machine' : 'core-machine'">
    <form v-if="editing" class="rename-form" @submit.prevent="newName.trim() && emit('save', newName.trim())">
      <UInput v-model="newName" size="lg" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" maxlength="32" :aria-label="t('Name')" autofocus />
      <UButton type="submit" size="sm" color="primary" variant="solid" :loading="busy" :disabled="!newName.trim()">{{ t('Save') }}</UButton>
      <UButton type="button" size="sm" color="neutral" variant="outline" @click="emit('cancel')">{{ t('Cancel') }}</UButton>
    </form>
    <template v-else>
      <b class="machine-name" :title="machine.label">{{ machine.label }}</b>
      <span class="mono-label machine-state" :data-status="machine.local ? 'local' : machine.status" data-testid="machine-state">{{ machine.local ? t('Host') : t(STATE[machine.status] || machine.status) }}</span>
      <span class="machine-actions">
        <UButton v-if="online" color="neutral" variant="ghost" size="sm" icon="i-lucide-sun" :aria-label="t('Keep awake')" data-testid="machine-awake-open" @click="openAwake(machine)" />
        <i v-else />
        <template v-if="!machine.local">
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-pencil" :aria-label="t('Rename')" data-testid="machine-rename" @click="emit('edit')" />
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-trash-2" :aria-label="t('Forget')" data-testid="machine-forget" @click="emit('forget')" />
        </template>
      </span>
    </template>
    <div class="machine-sub">
      <small v-if="machine.error" class="muted">{{ machine.error }}</small>
      <UButton v-if="!online" class="machine-reconnect" color="neutral" variant="outline" size="sm" :loading="busy" @click="emit('reconnect')">{{ t('Reconnect') }}</UButton>
      <MachineAwake :machine-key="machine.key" :online="online" />
    </div>
    <div v-if="memory" class="machine-memory">
      <span class="mono-label" :class="{ wait: memory.short }" data-testid="memory-line">{{ memory.line }}</span>
      <span v-if="memory.pausedAll" class="mono-label wait" data-testid="machine-paused-all">{{ t('Paused in every project') }}</span>
      <div class="memory-form">
        <label>{{ t('Automatic starts wait under (GB free)') }}
          <input class="pm-select" type="number" min="0" max="256" step="0.5" :value="memory.settings.minFreeMb === undefined ? '' : gb(memory.settings.minFreeMb)" :placeholder="auto(memory.autoReserve, 'GB')" data-testid="memory-min" @change="saveMemory(memory, 'minFreeGb', $event)">
        </label>
        <label>{{ t('Agents at once, all projects') }}
          <input class="pm-select" type="number" min="1" max="50" :value="memory.settings.maxAgents ?? ''" :placeholder="auto(memory.cap)" data-testid="memory-cap" @change="saveMemory(memory, 'maxAgents', $event)">
        </label>
        <label>{{ t('Available') }}
          <select class="pm-select" :value="memory.settings.hours?.days ?? 'always'" data-testid="memory-hours" @change="pickDays(memory, $event)">
            <option value="always">{{ t('Always') }}</option>
            <option value="weekdays">{{ t('Weekdays') }}</option>
            <option value="all">{{ t('Every day') }}</option>
          </select>
        </label>
        <template v-if="memory.settings.hours">
          <label>{{ t('From') }}<input class="pm-select" type="time" :value="memory.settings.hours.from" @change="time(memory, 'from', $event)"></label>
          <label>{{ t('To') }}<input class="pm-select" type="time" :value="memory.settings.hours.to" @change="time(memory, 'to', $event)"></label>
        </template>
      </div>
      <small class="muted" data-testid="memory-auto-hint">{{ t('Leave empty: wherdr decides from the machine\'s memory and cores') }}</small>
    </div>
  </div>
</template>

<style scoped>
/* Name | state | three 44 px action slots: the same columns on every card. */
.machine-card { display: grid; grid-template-columns: minmax(0, 1fr) auto 132px; align-items: center; column-gap: 12px; padding: 13px 16px; }
.machine-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.machine-state { white-space: nowrap; justify-self: end; }
.machine-state[data-status='online'] { color: var(--green, var(--text)); }
.machine-actions { display: grid; grid-template-columns: repeat(3, 44px); justify-items: center; }
.rename-form { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; }
.machine-sub { grid-column: 1 / -1; display: grid; gap: 4px; justify-items: start; overflow-wrap: anywhere; }
.machine-sub > :deep(:first-child) { margin-top: 6px; }
.machine-memory { grid-column: 1 / -1; display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.machine-memory > .mono-label { color: var(--green); overflow-wrap: anywhere; }
.machine-memory > .mono-label.wait { color: var(--ochre); }
.memory-form { display: flex; flex-wrap: wrap; gap: 12px; }
.memory-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }
.memory-form input { width: 180px; }
@media (max-width: 699px) {
  .memory-form { flex-direction: column; }
  .memory-form input, .memory-form select { width: 100%; }
}
</style>
