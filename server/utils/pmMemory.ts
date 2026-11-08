// A machine's memory for automatic starts (shared/pm/memory.ts): its
// /proc/meminfo through herdr-core (read at most every 20 s), the agents
// running on it across all projects, and the user's settings, kept in
// DATA_DIR/machine-memory.json by machine key ('' = the wherdr host).
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_MEMORY, agentCap, mergeMemory, memoryLine, memoryShort, memoryWait, parseMeminfo, type MachineMemory, type MemorySettings } from '../../shared/pm/memory'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
import { DATA_DIR } from './env'

export const MEMORY_FILE = path.join(DATA_DIR, 'machine-memory.json')

export async function readMemorySettings(file = MEMORY_FILE): Promise<Record<string, MemorySettings>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))?.machines
    return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).map(([k, v]) => [k, mergeMemory(DEFAULT_MEMORY, v && typeof v === 'object' ? { minFreeGb: (v as MemorySettings).minFreeMb / 1024, maxAgents: (v as MemorySettings).maxAgents } : {})]))
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

const read = new Map<string, { at: number, mem: MachineMemory | null }>()
// Forgets a reading: an agent just started there, its memory is not in it yet.
export const forgetMemory = (machine: string) => read.delete(machine)

async function machineMemory(deps: CoreAdminDeps, machine: string, now = Date.now()) {
  const hit = read.get(machine)
  if (hit && now - hit.at < 20_000) return hit.mem
  let mem: MachineMemory | null = null
  try { mem = parseMeminfo((await exec(deps, machineOn(deps, machine).on, 'cat /proc/meminfo', [], undefined, 10)).out) } catch {}
  read.set(machine, { at: now, mem })
  return mem
}

export interface MemoryState { key: string, label: string, mem: MachineMemory | null, settings: MemorySettings, agents: number, cap?: number, line: string, short?: string }

// Where a machine stands: its reading, its settings, its agents (runs not ended, every project).
export async function memoryState(deps: CoreAdminDeps & { store: PmStore }, machine: string): Promise<MemoryState> {
  const label = deps.machines().find(m => m.key === machine)?.label ?? machine
  const [mem, all, runs] = await Promise.all([machineMemory(deps, machine), readMemorySettings(), deps.store.runs()])
  const settings = all[machine] ?? DEFAULT_MEMORY
  const agents = runs.filter(r => r.machine === machine && r.state !== 'ended').length
  const short = memoryShort(mem, settings, agents)
  const cap = agentCap(settings, mem)
  return { key: machine, label, mem, settings, agents, ...(cap !== undefined ? { cap } : {}), line: memoryLine(mem, settings, agents), ...(short ? { short } : {}) }
}

// Why an automatic start of a task of `project` waits for memory, as its card
// says it, or undefined. A failed read never holds a start.
export async function memoryHold(deps: CoreAdminDeps & { store: PmStore }, project: string): Promise<string | undefined> {
  try {
    const p = (await deps.store.projects()).find(x => x.key === project)
    const s = p && await memoryState(deps, p.machine)
    return s?.short && memoryWait(s.label, s.short)
  } catch { return undefined }
}

// Settings › Machines and › Pace: every machine wherdr reaches.
export const memoryView = async (deps: CoreAdminDeps & { store: PmStore }) =>
  ({ machines: await Promise.all(deps.machines().filter(m => m.local || m.status === 'online').map(m => memoryState(deps, m.key))) })
