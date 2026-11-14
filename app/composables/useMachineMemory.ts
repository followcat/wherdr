// Each machine's memory, agents at once and availability (all projects): read by
// Settings › Pace, edited on the machine cards of Settings › Machines.
import type { Hours, MemorySettings } from '#shared/pm/memory'
import type { MachineCapacity } from '#shared/pm/capacity'

export interface MemoryRow { key: string, label: string, mem: MachineCapacity | null, settings: MemorySettings, agents: number, cap?: number, autoReserve?: number, line: string, short?: string, pausedAll?: true }
export const memoryRows = ref<MemoryRow[] | null>(null)
export const memoryError = ref('')

async function send(body?: Record<string, unknown>) {
  memoryError.value = ''
  try { memoryRows.value = (await api<{ machines: MemoryRow[] }>('/api/machine/memory', body)).machines }
  catch (err) { memoryError.value = (err as Error).message }
}
export const loadMemory = () => send()

// An emptied field goes back to Auto (null): wherdr decides from the machine's RAM.
export function saveMemory(r: MemoryRow, field: 'minFreeGb' | 'maxAgents', e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  return send({ key: r.key, [field]: v === '' ? null : Number(v) })
}

// Availability hours: Always clears them; a new choice starts at 09:00-19:00.
export function saveHours(r: MemoryRow, patch: Partial<Hours> | null) {
  const hours = patch && { days: 'weekdays' as const, from: '09:00', to: '19:00', ...r.settings.hours, ...patch }
  return send({ key: r.key, hours })
}

export const memoryHint = () => t('Automatic starts (autopilot, chains, automations) wait while a machine is short on memory, its swap is over 90 % used (on macOS: its memory pressure is critical, or warn for all but light work) or it runs its cap of agents; they start by themselves once memory is back. Outside a machine\'s available hours (this server\'s time) they skip it, and heavy work skips it in its last 2 hours. Your own starts still go.')
