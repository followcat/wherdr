<script setup lang="ts">
// Each machine's memory and agents at once (all projects), and whether
// automatic starts may go there now. `edit`: also its settings (Settings ›
// Machines); Settings › Pace shows the state only.
import type { MachineMemory, MemorySettings } from '#shared/pm/memory'

defineProps<{ edit?: boolean }>()
interface Row { key: string, label: string, mem: MachineMemory | null, settings: MemorySettings, agents: number, cap?: number, line: string, short?: string }
const rows = ref<Row[] | null>(null)
const error = ref('')
const load = () => api<{ machines: Row[] }>('/api/machine/memory').then((v) => { rows.value = v.machines }, (e: Error) => { error.value = e.message })
onMounted(load)

// An emptied cap goes back to the default (one agent per 1.5 GB of RAM).
async function save(r: Row, field: 'minFreeGb' | 'maxAgents', e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  error.value = ''
  try { rows.value = (await api<{ machines: Row[] }>('/api/machine/memory', { key: r.key, [field]: v === '' && field === 'maxAgents' ? null : Number(v) })).machines }
  catch (err) { error.value = (err as Error).message }
}
const gb = (mb: number) => Math.round(mb / 102.4) / 10
</script>

<template>
  <div class="settings-card memory-card" data-testid="machine-memory">
    <div v-for="r in rows ?? []" :key="r.key" class="memory-row">
      <span class="memory-head"><b>{{ r.label }}</b><span class="mono-label" :class="{ wait: r.short }" data-testid="memory-line">{{ r.line }}</span></span>
      <div v-if="edit" class="memory-form">
        <label>{{ t('Automatic starts wait under (GB free)') }}
          <input class="pm-select" type="number" min="0" max="256" step="0.5" :value="gb(r.settings.minFreeMb)" data-testid="memory-min" @change="save(r, 'minFreeGb', $event)">
        </label>
        <label>{{ t('Agents at once, all projects') }}
          <input class="pm-select" type="number" min="1" max="50" :value="r.settings.maxAgents ?? ''" :placeholder="r.cap ? String(r.cap) : ''" data-testid="memory-cap" @change="save(r, 'maxAgents', $event)">
        </label>
      </div>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p class="muted settings-hint">{{ t('Automatic starts (autopilot, chains, automations) wait while a machine is short on memory, its swap is over 90 % used or it runs its cap of agents; they start by themselves once memory is back. Your own starts still go.') }}</p>
  </div>
</template>

<style scoped>
.memory-card { padding: 0 16px; margin-top: 12px; }
.memory-row { display: flex; flex-direction: column; gap: 8px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.memory-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; justify-content: space-between; }
.memory-head .mono-label { color: var(--green); overflow-wrap: anywhere; }
.memory-head .mono-label.wait { color: var(--ochre); }
.memory-form { display: flex; flex-wrap: wrap; gap: 12px; }
.memory-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }
.memory-form input { width: 120px; }
.memory-card .settings-hint { padding: 12px 0; margin: 0; }
</style>
