// Memory-aware starts: an automatic start (a wake, an 'after' chain, an
// automation) on a machine waits while the machine is short on memory, or
// while it already runs as many agents as its cap, across all projects. The
// user's own starts still go, with a word that the machine is short.

// What /proc/meminfo says, in MB.
export interface MachineMemory { total: number, available: number, swapTotal: number, swapFree: number }

// The user's settings for one machine (Settings › Machines).
export interface MemorySettings {
  minFreeMb: number // automatic starts wait while less memory than this is available
  maxAgents?: number // agents at once on the machine; unset: one per MB_PER_AGENT of its RAM
}

export const DEFAULT_MEMORY: MemorySettings = { minFreeMb: 2048 }
export const SWAP_MAX = 0.9 // automatic starts wait while more of the swap than this is used
export const MB_PER_AGENT = 1536

// /proc/meminfo's text: null when MemTotal or MemAvailable is missing (not Linux).
export function parseMeminfo(text: string): MachineMemory | null {
  const kb = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text); return m ? Math.round(Number(m[1]) / 1024) : null }
  const total = kb('MemTotal'), available = kb('MemAvailable')
  if (total === null || available === null) return null
  return { total, available, swapTotal: kb('SwapTotal') ?? 0, swapFree: kb('SwapFree') ?? 0 }
}

// The machine's cap: the user's, else one agent per MB_PER_AGENT of RAM (at least one).
export const agentCap = (s: MemorySettings, mem: MachineMemory | null) =>
  s.maxAgents ?? (mem ? Math.max(1, Math.floor(mem.total / MB_PER_AGENT)) : undefined)

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const swapUsed = (m: MachineMemory) => (m.swapTotal ? (m.swapTotal - m.swapFree) / m.swapTotal : 0)

// Why the machine is short for one more agent, or undefined. `agents`: the
// agents running on it now, all projects together. An unknown reading holds
// only by the user's cap.
export function memoryShort(mem: MachineMemory | null, s: MemorySettings, agents: number): string | undefined {
  if (mem && mem.available < s.minFreeMb) return `${gb(mem.available)} free, under ${gb(s.minFreeMb)}`
  if (mem && swapUsed(mem) > SWAP_MAX) return `swap ${Math.round(swapUsed(mem) * 100)} % used`
  const cap = agentCap(s, mem)
  if (cap !== undefined && agents >= cap) return `${agents} agents already run on it (cap ${cap})`
}

// The words on a held task's card.
export const memoryWait = (machine: string, why: string) => `Waits for memory on ${machine}: ${why}`

// One line for `autopilot show` and Settings: "5.2 GB free of 16.0 GB · swap 3 % · 2 of 10 agents · go".
export function memoryLine(mem: MachineMemory | null, s: MemorySettings, agents: number): string {
  const cap = agentCap(s, mem)
  const short = memoryShort(mem, s, agents)
  return [
    mem ? `${gb(mem.available)} free of ${gb(mem.total)}` : 'memory unknown',
    ...(mem?.swapTotal ? [`swap ${Math.round(swapUsed(mem) * 100)} %`] : []),
    cap !== undefined ? `${agents} of ${cap} agents` : `${agents} agents`,
    short ? `wait: ${short}` : 'go',
  ].join(' · ')
}

// The user's changes, checked over `base`: minFreeGb 0-256 (GB), maxAgents 1-50 or null (back to the default).
export function mergeMemory(base: MemorySettings, patch: unknown): MemorySettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const out = { ...base }
  if (typeof p.minFreeGb === 'number' && p.minFreeGb >= 0 && p.minFreeGb <= 256) out.minFreeMb = Math.round(p.minFreeGb * 1024)
  if (p.maxAgents === null) delete out.maxAgents
  else if (Number.isInteger(p.maxAgents) && (p.maxAgents as number) >= 1 && (p.maxAgents as number) <= 50) out.maxAgents = p.maxAgents as number
  return out
}
