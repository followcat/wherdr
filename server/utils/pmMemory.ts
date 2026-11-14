// A machine's memory for automatic starts (shared/pm/memory.ts): its
// capacity (shared/pm/capacity.ts, Linux or macOS) through herdr-core (read at most every 20 s), the agents
// running on it across all projects, and the user's settings, kept in
// DATA_DIR/machine-memory.json by machine key ('' = the wherdr host).
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_MEMORY, agentCap, autoReserveOf, availabilityLine, mergeMemory, memoryLine, memoryShort, type MemorySettings } from '../../shared/pm/memory'
import { CAPACITY_SCRIPT, parseCapacity, type MachineCapacity } from '../../shared/pm/capacity'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import { leftoversKilled } from './pmProcs'
import type { PmStore } from './pmStore'
import { DATA_DIR } from './env'
import { agentsAtWork } from '../../shared/pm/release'
import { taskPlan } from '../../shared/pm/run'
import { weightOf, type Weight } from '../../shared/pm/weight'
import { learnedEstimates } from '../../shared/pm/peaks'
import { pausedEverywhere } from '../../shared/pm/project'
import type { Estimate } from '../../shared/pm/placement'

export const MEMORY_FILE = path.join(DATA_DIR, 'machine-memory.json')

export async function readMemorySettings(file = MEMORY_FILE): Promise<Record<string, MemorySettings>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))?.machines
    return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).map(([k, v]) => [k, mergeMemory(DEFAULT_MEMORY, v && typeof v === 'object' ? { ...(typeof (v as MemorySettings).minFreeMb === 'number' ? { minFreeGb: (v as MemorySettings).minFreeMb! / 1024 } : {}), maxAgents: (v as MemorySettings).maxAgents, hours: (v as MemorySettings).hours } : {})]))
  } catch { return {} }
}

let queue: Promise<unknown> = Promise.resolve()
export function setMemorySettings(key: string, patch: unknown, file = MEMORY_FILE): Promise<MemorySettings> {
  const run = queue.then(async () => {
    const all = await readMemorySettings(file)
    const s = all[key] = mergeMemory(all[key] ?? DEFAULT_MEMORY, patch)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify({ v: 1, machines: all }) + '\n', { mode: 0o600 })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return s
  })
  queue = run.catch(() => {})
  return run
}

const read = new Map<string, { at: number, mem: MachineCapacity | null }>()
// Forgets a reading: an agent just started there, its memory is not in it yet.
export const forgetMemory = (machine: string) => read.delete(machine)

export async function machineCapacity(deps: CoreAdminDeps, machine: string, now = Date.now()) {
  const hit = read.get(machine)
  if (hit && now - hit.at < 20_000) return hit.mem
  let mem: MachineCapacity | null = null
  try { mem = parseCapacity((await exec(deps, machineOn(deps, machine).on, CAPACITY_SCRIPT, [], undefined, 10)).out) } catch {}
  read.set(machine, { at: now, mem })
  return mem
}

export interface MemoryState { key: string, label: string, online: boolean, mem: MachineCapacity | null, settings: MemorySettings, agents: number, cap?: number, autoReserve?: number, line: string, short?: string }

// The agents at work on a machine, every project: those that hold their task's
// step under way (agentsAtWork), not those of a task that waits for the user.
// Each one's estimate comes from its task's weight, learned in its project (peaks.ts).
export async function atWork(store: PmStore, machine: string): Promise<(Estimate & { weight: Weight, task: string })[]> {
  const [runs, tasks, projects] = await Promise.all([store.runs(), store.tasks(), store.projects()])
  const known = new Map<string, { holder?: string, estimate: Estimate & { weight: Weight } }>()
  for (const t of tasks.filter(x => runs.some(r => r.task === x.id && r.machine === machine && r.state !== 'ended'))) {
    const p = projects.find(x => x.key === t.project), tpl = p ? await store.workflow(p.key) : null
    const w = weightOf(tpl, t).weight, { mb, cores } = learnedEstimates(tpl, tasks.filter(x => x.project === t.project), runs)[w]
    known.set(t.id, { holder: tpl && t.step ? taskPlan(tpl, t, p)[t.step.at]?.holder : undefined, estimate: { mb, cores, weight: w } })
  }
  return agentsAtWork(runs, tasks, machine, t => known.get(t.id)?.holder).map(r => ({ ...known.get(r.task)!.estimate, task: r.task }))
}

// The orphan sweep's work (pmProcs.ts), when it acted.
const leftovers = (machine: string) => {
  const n = leftoversKilled(machine)
  return n ? ` · ${n} leftover process${n === 1 ? '' : 'es'} killed` : ''
}

// Where a machine stands: online or not and its hours, its reading (none
// while offline), its settings, its agents at work, the leftovers killed.
export async function memoryState(deps: CoreAdminDeps & { store: PmStore }, machine: string): Promise<MemoryState> {
  const m = deps.machines().find(x => x.key === machine)
  const label = m?.label ?? machine, online = !!m && (m.local || m.status === 'online')
  const [mem, all, running] = await Promise.all([online ? machineCapacity(deps, machine) : null, readMemorySettings(), atWork(deps.store, machine)])
  const agents = running.length
  const settings = all[machine] ?? DEFAULT_MEMORY
  const short = memoryShort(mem, settings, agents)
  const cap = agentCap(settings, mem)
  const there = availabilityLine(online, settings.hours)
  return { key: machine, label, online, mem, settings, agents, ...(cap !== undefined ? { cap } : {}), ...(mem ? { autoReserve: autoReserveOf(mem) } : {}), line: (online ? `${there} · ${memoryLine(mem, settings, agents)}` : there) + leftovers(machine), ...(short ? { short } : {}) }
}

// Settings › Machines and › Pace: every machine wherdr knows, offline ones too (their hours can be set).
// pausedAll: some project allows it, and every one that does has it paused.
export async function memoryView(deps: CoreAdminDeps & { store: PmStore }) {
  const projects = await deps.store.projects()
  return { machines: await Promise.all(deps.machines().map(async m => ({ ...(await memoryState(deps, m.key)), ...(pausedEverywhere(projects, m.key) ? { pausedAll: true } : {}) }))) }
}
