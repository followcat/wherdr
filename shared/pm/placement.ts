// Where a task starts: the machine among its project's allowed ones where it
// fits now, or a hold that names each machine's reason. Pure: the server reads
// each machine (capacity, settings, agents at work, readiness, pace) and asks.
import type { MachineCapacity, Pressure } from './capacity'
import { agentCap, memoryStrain, reserveOf, capacityParts, hoursLabel, hoursWait, roomWord, type MemorySettings } from './memory'
import { WEIGHTS, WEIGHT_DEFAULTS, type Weight } from './weight'

export interface Estimate { mb: number, cores: number }

export interface Candidate {
  key: string
  label: string
  online: boolean
  wait?: string // why it takes no task now, whatever the room: not ready, its account paced
  capacity: MachineCapacity | null // null: not read
  settings: MemorySettings
  running: Estimate[] // the agents at work on it, every project
}

// How a project spreads its tasks over its allowed machines (project sheet):
// strongest: light and standard work at home when it fits, heavy work on the
// machine with most room; balance: every task on the one with the largest
// share of memory and cores left after it; home: home while it fits, the others only once it is full.
export const STRATEGIES = ['strongest', 'balance', 'home'] as const
export type Strategy = typeof STRATEGIES[number]
export const STRATEGY_LABELS: Record<Strategy, string> = { strongest: 'Heavy to the strongest', balance: 'Balance the load', home: 'Home first' }
// One line each, under the picker and in the Machines view.
export const STRATEGY_HINTS: Record<Strategy, string> = {
  strongest: 'Light and standard work at home while it fits, heavy work on the machine with most room',
  balance: 'Each task on the machine with the most memory and cores left after it',
  home: 'Every task at home; the other machines only once home is full',
}
export const isStrategy = (s: unknown): s is Strategy => STRATEGIES.includes(s as Strategy)

// best: where a start that must go (the user's) goes when nothing fits.
// anyway: the task fits no allowed machine even with all its agents gone, so
// waiting cannot help: it goes to the best one, and this says why.
export type Placement = { machine: string, anyway?: string } | { hold: string, best?: string }

// A machine switched off for a project: no new task of it goes there.
export const PAUSED = 'paused for this project'
const HEAVY_LOAD = 0.8 // heavy work waits while the 1-minute load per core is over this
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const sum = (xs: Estimate[], k: keyof Estimate) => xs.reduce((n, x) => n + x[k], 0)

// The memory a machine has left for one more task: the least of what it reads
// free and what its agents' estimates leave, both above its minimum free.
// Infinity when it cannot be read.
export function roomOf(c: Candidate) {
  const m = c.capacity
  if (!m) return Infinity
  return Math.min(m.available, m.total - sum(c.running, 'mb')) - reserveOf(c.settings, m)
}

// Too small for the task even empty: its RAM less its reserve under the
// estimate. Unknown when it cannot be read.
const tooSmall = (c: Candidate, e: Estimate) => !!c.capacity && c.capacity.total - reserveOf(c.settings, c.capacity) < e.mb

// Why the task does not fit the machine now, or undefined. Two checks: the live
// reading (catches what wherdr does not track) and the bookkeeping of the
// agents' estimates (an agent started seconds ago has not reached its peak).
// Outside its availability hours, or heavy work just before it leaves: it waits too.
export function misfit(c: Candidate, weight: Weight, e: Estimate, now = new Date()): string | undefined {
  if (!c.online) return 'offline'
  if (c.wait) return c.wait
  const away = hoursWait(c.settings.hours, weight === 'heavy', now)
  if (away) return away
  const m = c.capacity
  const agents = c.running.length
  // The user's cap, else one agent per 1.5 GB of RAM (as Settings › Machines shows it).
  const cap = agentCap(c.settings, m)
  if (cap !== undefined && agents >= cap) return `full: ${agents} agents (cap ${cap})`
  if (!m) return undefined
  // Idle (no agent of wherdr at work there): it takes one task its RAM can
  // hold, whatever it reads free; the reserve holds the second one and beyond.
  const idle = agents === 0
  if (idle && e.mb > m.total) return `${gb(m.total)} of RAM, under ${gb(e.mb)}`
  const reserve = idle ? 0 : reserveOf(c.settings, m)
  if (!idle && m.available - e.mb < reserve) return `${gb(m.available)} ${roomWord(m)}, needs ${gb(e.mb + reserve)} with its reserve`
  const strain = memoryStrain(m, weight === 'light')
  if (strain) return strain
  if (sum(c.running, 'mb') + e.mb > m.total - reserve) return `${agents} agents take ≈${gb(sum(c.running, 'mb'))} of ${gb(m.total)}`
  if (m.cores && sum(c.running, 'cores') + e.cores > m.cores) return `${agents} agents take its ${m.cores} cores`
  if (weight === 'heavy' && m.cores && m.load1 / m.cores > HEAVY_LOAD) return `load ${m.load1.toFixed(1)} on ${m.cores} cores`
}

// Most room first, then most cores, then fewest agents.
const stronger = (a: Candidate, b: Candidate) =>
  roomOf(b) - roomOf(a) || (b.capacity?.cores ?? 0) - (a.capacity?.cores ?? 0) || a.running.length - b.running.length
// The share of a machine left once the task runs: the lesser of its memory's
// and its cores' (agents' estimates count at once, the reading lags). Infinity
// when it cannot be read.
function leftShare(c: Candidate, e: Estimate) {
  const m = c.capacity
  if (!m) return Infinity
  const mem = (roomOf(c) - e.mb) / m.total
  return m.cores ? Math.min(mem, (m.cores - sum(c.running, 'cores') - e.cores) / m.cores) : mem
}
// Most of it left, then fewest agents.
const roomier = (e: Estimate) => (a: Candidate, b: Candidate) =>
  leftShare(b, e) - leftShare(a, e) || a.running.length - b.running.length

const label = (c: Candidate) => c.label || 'this host'

// pinned: the machine the task must go to (its own once started); otherwise
// the candidates are the project's allowed machines. prefer: the one asked for
// a new task; while it is offline, the task goes to another that fits, else
// waits for it. strategy: the project's (STRATEGIES), which the hold names.
export function placeTask(args: {
  weight: Weight, estimate?: Estimate, home: string, pinned?: string, prefer?: string, candidates: Candidate[], strategy?: Strategy, now?: Date
}): Placement {
  const { weight, estimate = WEIGHT_DEFAULTS[weight], home, pinned, prefer, candidates, strategy = 'strongest', now = new Date() } = args
  if (prefer !== undefined) {
    const own = candidates.find(c => c.key === prefer)
    if (own?.online) return placeTask({ ...args, prefer: undefined, pinned: prefer })
    const other = placeTask({ ...args, prefer: undefined, candidates: candidates.filter(c => c.key !== prefer) })
    return 'machine' in other ? other : { hold: `Waits for ${own ? label(own) : prefer} (offline)`, ...(other.best !== undefined ? { best: other.best } : {}) }
  }
  const pool = pinned === undefined ? candidates : candidates.filter(c => c.key === pinned)
  const why = new Map(pool.map(c => [c.key, misfit(c, weight, estimate, now)]))
  const fits = pool.filter(c => !why.get(c.key))
  const homeFirst = strategy === 'home' || (strategy === 'strongest' && weight !== 'heavy')
  const pick = (homeFirst && fits.find(c => c.key === home)) || [...fits].sort(strategy === 'balance' ? roomier(estimate) : stronger)[0]
  if (pick) return { machine: pick.key }
  // Nothing fits: the machine a start that must go takes, home when it has as much room.
  const usable = pool.filter(c => c.online && !c.wait).sort(stronger)
  const top = usable[0], h = usable.find(c => c.key === home)
  const best = pinned ?? (h && top && roomOf(h) >= roomOf(top) ? h.key : top?.key)
  if (pinned !== undefined && !pool[0]?.online) return { hold: `Waits for ${pool[0] ? label(pool[0]) : pinned} (offline)`, best }
  // Every machine it may use now is too small for it: waiting would last forever.
  const at = usable.find(c => c.key === best)
  if (at && usable.every(c => tooSmall(c, estimate)))
    return { machine: at.key, anyway: `${weight} (≈${gb(estimate.mb)}) is more than any allowed machine can take: runs on ${label(at)} (${gb(at.capacity!.total)}) instead of waiting` }
  const reasons = pool.map(c => `${label(c)}: ${why.get(c.key)}`).join('; ')
  return { hold: `Waits for room (${STRATEGY_LABELS[strategy]}): ${weight} (≈${gb(estimate.mb)}) fits nowhere — ${reasons}`, ...(best !== undefined ? { best } : {}) }
}

// placeTask's hold for room, short: "no room on machine-a (needs ≈3.4 GB: 3.1 GB
// free, …)" for one machine. Undefined: not a hold for room.
const ROOM_HOLD = /^Waits for room \([^)]*\): \S+ \(≈([\d.]+ GB)\) fits nowhere — (.*)$/
export const isRoomHold = (hold: string) => ROOM_HOLD.test(hold)
export function roomShort(hold: string): string | undefined {
  const m = ROOM_HOLD.exec(hold)
  if (!m) return
  const one = m[2]!.includes('; ') ? undefined : /^(.+?): (.*)$/.exec(m[2]!)
  return one ? `no room on ${one[1]} (needs ≈${m[1]}: ${one[2]})` : `no room (needs ≈${m[1]}): ${m[2]}`
}

// An allowed machine as `autopilot show` gives it. running: its agents at work
// with their task's weight; unchecked: another machine than home whose
// readiness for the project was not checked yet (it is before its first task);
// paused: switched off for the project, it takes no new task of it.
export type MachineView = Omit<Candidate, 'running'> & { home: boolean, running: (Estimate & { weight: Weight, task?: string })[], unchecked?: boolean, paused?: boolean }

// A machine's card in the project's Machines view: its state, its memory in MB
// for the bar (its agents' estimates, the rest of what is used, free, the
// reserve automatic starts leave), its agents, and the heaviest weight it takes
// now. why: why it takes nothing, else why not the next heavier weight.
export interface MachineNow {
  key: string, label: string, home: boolean, state: 'online' | 'offline' | 'paused'
  memory?: { total: number, agents: number, other: number, free: number, reserve: number }
  cores?: number, load?: number, pressure?: Pressure, cap?: number, hours?: string, unchecked?: true
  agents: { task?: string, weight: Weight }[]
  takes?: Weight, why?: string
}
// estimates: the project's per weight (learned, else the defaults), as placement counts them.
export function machineNow(c: MachineView, estimates: Record<Weight, Estimate> = WEIGHT_DEFAULTS, now = new Date()): MachineNow {
  const m = c.capacity, cap = agentCap(c.settings, m)
  const base = {
    key: c.key, label: label(c), home: c.home, agents: c.running.map(r => ({ weight: r.weight, ...(r.task ? { task: r.task } : {}) })),
    ...(cap !== undefined ? { cap } : {}), ...(c.settings.hours ? { hours: hoursLabel(c.settings.hours) } : {}), ...(c.unchecked ? { unchecked: true as const } : {}),
  }
  if (!c.online) return { ...base, state: c.paused ? 'paused' : 'offline', why: c.paused ? PAUSED : 'offline' }
  const used = m ? m.total - m.available : 0, mine = Math.min(sum(c.running, 'mb'), used)
  const reading = m ? { memory: { total: m.total, agents: mine, other: used - mine, free: m.available, reserve: reserveOf(c.settings, m) }, load: m.load1, ...(m.cores ? { cores: m.cores } : {}), ...(m.pressure ? { pressure: m.pressure } : {}) } : {}
  if (c.paused) return { ...base, ...reading, state: 'paused', why: PAUSED }
  const heaviest = WEIGHTS.slice().reverse()
  const takes = heaviest.find(w => !misfit(c, w, estimates[w], now))
  const short = takes ? heaviest[heaviest.indexOf(takes) - 1] : 'light'
  const why = short && misfit(c, short, estimates[short], now)
  return { ...base, ...reading, state: 'online', ...(takes ? { takes } : {}), ...(why ? { why: takes ? `${short}: ${why}` : why } : {}) }
}

// "machine-a (home): 9.1 GB free of 32.0 GB · 8 cores, load 2.1 · 2 of 21 agents
// · running 1 heavy, 1 light · fits heavy": the heaviest weight it takes now,
// else why it takes nothing (full, not ready, paced).
export function machineLine(c: MachineView, estimates: Record<Weight, Estimate> = WEIGHT_DEFAULTS): string {
  const name = `${c.label || 'this host'}${c.home ? ' (home)' : ''}`
  const hours = c.settings.hours ? [`available ${hoursLabel(c.settings.hours)}`] : []
  if (c.paused) return `${name}: ${PAUSED}${c.running.length ? ` · ${c.running.length} agents at work` : ''}`
  if (!c.online) return [`${name}: offline`, ...hours].join(' · ')
  const count = WEIGHTS.slice().reverse().map(w => [w, c.running.filter(r => r.weight === w).length] as const).filter(([, n]) => n)
  const fits = WEIGHTS.slice().reverse().find(w => !misfit(c, w, estimates[w]))
  return `${name}: ${[
    ...capacityParts(c.capacity, c.settings, c.running.length),
    ...hours,
    ...(count.length ? [`running ${count.map(([w, n]) => `${n} ${w}`).join(', ')}`] : []),
    fits ? `fits ${fits}${c.unchecked ? ' (readiness checked before its first task)' : ''}` : `takes nothing now: ${misfit(c, 'light', estimates.light)}`,
  ].join(' · ')}`
}
