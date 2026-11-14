// Memory-aware starts: an automatic start (a wake, an 'after' chain, an
// automation) on a machine waits while the machine is short on memory, or
// while it already runs as many agents as its cap, across all projects. The
// user's own starts still go, with a word that the machine is short.

import { CRITICAL_FREE, type MachineCapacity } from './capacity'

// The user's settings for one machine (Settings › Machines).
export interface MemorySettings {
  minFreeMb?: number // automatic starts wait while less memory than this is available; unset: autoReserve of its RAM
  maxAgents?: number // agents at once on the machine; unset: one per MB_PER_AGENT of its RAM
  hours?: Hours // when it is there for automatic starts; unset: always
}

// When a machine is there (a laptop at the office): its days, from and to as
// HH:MM in the server's time (to before from: over midnight, the days are the start's).
export interface Hours { days: 'weekdays' | 'all', from: string, to: string }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
export const hoursLabel = (h: Hours) => `${h.days === 'weekdays' ? 'weekdays' : 'every day'} ${h.from}-${h.to}`
// Heavy work needs this long before the machine leaves.
export const HEAVY_BEFORE_MIN = 120

// Why an automatic start does not go there at `now`, or undefined: outside its
// hours, or heavy work too close to the end of them.
export function hoursWait(h: Hours | undefined, heavy: boolean, now: Date): string | undefined {
  if (!h) return
  const from = minutes(h.from), to = minutes(h.to), t = now.getHours() * 60 + now.getMinutes()
  const span = (to - from + 1440) % 1440 || 1440
  const since = (t - from + 1440) % 1440 // minutes since its hours began (today or yesterday)
  const day = new Date(now.getTime() - since * 60_000).getDay()
  const inside = since < span && (h.days === 'all' || (day >= 1 && day <= 5))
  if (!inside) return `away (${hoursLabel(h)})`
  if (heavy && span - since < HEAVY_BEFORE_MIN) return `leaves at ${h.to}: too late for heavy work`
}

export const DEFAULT_MEMORY: MemorySettings = {}
export const SWAP_MAX = 0.9 // automatic starts wait while more of the swap than this is used
export const MB_PER_AGENT = 1536

// The Auto memory reserve: 15 % of the machine's RAM, at least 1 GB, at most
// 4 GB (8 GB: 1.2 GB, 18 GB: 2.7 GB, 32 GB and more: 4 GB). macOS (its
// pressure read): its available figure already leaves out what macOS keeps,
// so the reserve is the critical line, CRITICAL_FREE % of its RAM, within the
// same bounds (18 GB: 1.8 GB): under warn, light work still fits above it.
export const RESERVE_SHARE = 0.15
export const autoReserve = (totalMb: number, macos = false) =>
  Math.min(4096, Math.max(1024, Math.round(totalMb * (macos ? CRITICAL_FREE / 100 : RESERVE_SHARE))))
type Reading = Pick<MachineCapacity, 'total'> & Partial<Pick<MachineCapacity, 'pressure'>>
export const autoReserveOf = (mem: Reading) => autoReserve(mem.total, !!mem.pressure)
// The memory automatic starts leave free: the user's, else the Auto reserve
// (0 while the machine cannot be read: nothing to hold by then).
export const reserveOf = (s: MemorySettings, mem: Reading | null) =>
  s.minFreeMb ?? (mem ? autoReserveOf(mem) : 0)
// What the reading calls its room: "free" (Linux), "available" (macOS's estimate, by its pressure).
export const roomWord = (mem: Pick<MachineCapacity, 'pressure'>) => (mem.pressure ? 'available' : 'free')
// "5.2 GB free of 16.0 GB"; macOS: "pressure normal, ≈8.3 GB available of 18.0 GB".
export const memoryLabel = (mem: MachineCapacity) =>
  `${mem.pressure ? `pressure ${mem.pressure}, ≈` : ''}${gb(mem.available)} ${roomWord(mem)} of ${gb(mem.total)}`

// The machine's cap: the user's, else one agent per MB_PER_AGENT of RAM (at least one).
export const agentCap = (s: MemorySettings, mem: MachineCapacity | null) =>
  s.maxAgents ?? (mem ? Math.max(1, Math.floor(mem.total / MB_PER_AGENT)) : undefined)

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const swapUsed = (m: MachineCapacity) => (m.swapTotal ? (m.swapTotal - m.swapFree) / m.swapTotal : 0)

// Why the machine's memory takes no more work beyond its free figure, or
// undefined. macOS: its pressure (normal: the free rule alone; warn: light
// work only; critical: nothing). Linux: swap over SWAP_MAX.
export function memoryStrain(m: MachineCapacity, light: boolean): string | undefined {
  if (m.pressure === 'critical') return 'memory pressure critical'
  if (m.pressure === 'warn') return light ? undefined : 'memory pressure warn: light work only'
  if (swapUsed(m) > SWAP_MAX) return `swap ${Math.round(swapUsed(m) * 100)} % used`
}

// Why the machine is short for one more agent, or undefined. `agents`: the
// agents running on it now, all projects together. An unknown reading holds
// only by the user's cap; an idle one is not held by its reserve (placement.ts).
export function memoryShort(mem: MachineCapacity | null, s: MemorySettings, agents: number): string | undefined {
  if (agents && mem && mem.available < reserveOf(s, mem)) return `${gb(mem.available)} ${roomWord(mem)}, under ${gb(reserveOf(s, mem))}`
  const strain = mem && memoryStrain(mem, false)
  if (strain) return strain
  const cap = agentCap(s, mem)
  if (cap !== undefined && agents >= cap) return `${agents} agents already run on it (cap ${cap})`
}

// The reading's parts: "5.2 GB free of 16.0 GB" (macOS: "pressure normal, ≈8.3 GB available of 18.0 GB"), "8 cores, load 2.1", "swap 3 %", "2 of 10 agents".
export function capacityParts(mem: MachineCapacity | null, s: MemorySettings, agents: number): string[] {
  const cap = agentCap(s, mem)
  return [
    mem ? memoryLabel(mem) : 'memory unknown',
    ...(mem?.cores ? [`${mem.cores} cores, load ${mem.load1.toFixed(1)}`] : []),
    ...(mem?.swapTotal ? [`swap ${Math.round(swapUsed(mem) * 100)} %`] : []),
    cap !== undefined ? `${agents} of ${cap} agents` : `${agents} agents`,
  ]
}

// One line for Settings: "5.2 GB free of 16.0 GB · 8 cores, load 2.1 · swap 3 % · 2 of 10 agents · go".
export function memoryLine(mem: MachineCapacity | null, s: MemorySettings, agents: number): string {
  const short = memoryShort(mem, s, agents)
  return [...capacityParts(mem, s, agents), short ? `wait: ${short}` : 'go'].join(' · ')
}

// Whether a machine is there now, for `autopilot show` and Settings: "online · weekdays 09:00-19:00, away now".
export function availabilityLine(online: boolean, h: Hours | undefined, now = new Date()) {
  return [online ? 'online' : 'offline', ...(h ? [`${hoursLabel(h)}${hoursWait(h, false, now) ? ', away now' : ''}`] : [])].join(' · ')
}

// The user's changes, checked over `base`: minFreeGb 0-256 (GB, 0 turns the
// guard off) and maxAgents 1-50, each null to go back to Auto; hours.
export function mergeMemory(base: MemorySettings, patch: unknown): MemorySettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const out = { ...base }
  if (p.minFreeGb === null) delete out.minFreeMb
  else if (typeof p.minFreeGb === 'number' && p.minFreeGb >= 0 && p.minFreeGb <= 256) out.minFreeMb = Math.round(p.minFreeGb * 1024)
  if (p.maxAgents === null) delete out.maxAgents
  else if (Number.isInteger(p.maxAgents) && (p.maxAgents as number) >= 1 && (p.maxAgents as number) <= 50) out.maxAgents = p.maxAgents as number
  // hours: null (always there) or { days: 'weekdays' | 'all', from, to: 'HH:MM' }, from ≠ to.
  const h = p.hours as Partial<Hours> | null | undefined
  if (h === null) delete out.hours
  else if (h && (h.days === 'weekdays' || h.days === 'all') && HHMM.test(h.from ?? '') && HHMM.test(h.to ?? '') && h.from !== h.to) out.hours = { days: h.days, from: h.from!, to: h.to! }
  return out
}
