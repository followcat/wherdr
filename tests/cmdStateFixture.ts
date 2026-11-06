// Neutral in-memory MachineFs + deferred gates for Command Code state and
// reader tests — fake disks only, never a real home/proc/agent.
import type { FsStat, MachineFs } from '../server/utils/fsx'
import { results } from './cmdParserFixture'

export const WATCH_BYTES = 64 * 1024
export const WATCH_SPAN = 4 * 1024 * 1024
export const line = (id: string, out: string) =>
  JSON.stringify(results(id, [{ tool_use_id: 't1', content: out }], 10))

// `size` overrides the stat size only: a file whose bytes are synthesized
// per range by `onRead` can claim any size without a real allocation.
export interface MemFile { body: Buffer, size?: number, mtimeMs?: number, ino?: number, isDir?: boolean }
const ENOENT = () => Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
const statOf = (f: MemFile | undefined): FsStat | null =>
  f ? { size: f.size ?? f.body.length, mtimeMs: f.mtimeMs ?? 1, isFile: f.isDir !== true, isDir: f.isDir === true, ino: f.ino } : null

export interface MemIo {
  reads?: { start: number, len: number }[]
  stats?: { n: number }
  onStat?: () => Promise<void> | void
  onRead?: (start: number, len: number) => Promise<Buffer | void> | Buffer | void
}
export function memFs(disk: Record<string, MemFile>, io: MemIo = {}): MachineFs {
  return {
    stat: async (p) => {
      // Captured BEFORE any gate: what resolves after onStat is genuinely
      // the old evidence, not the disk's state at release time.
      const st = statOf(disk[p])
      if (io.onStat) await io.onStat()
      if (io.stats) io.stats.n++
      if (!st) throw ENOENT()
      return st
    },
    statMany: async ps => ps.map(p => statOf(disk[p])),
    readdir: async () => [],
    readFile: async () => '',
    read: async (p, start, len) => {
      io.reads?.push({ start, len })
      const custom = io.onRead ? await io.onRead(start, len) : undefined
      if (custom) return custom
      const f = disk[p]
      if (!f) throw ENOENT()
      return f.body.subarray(start, start + len)
    },
  }
}

// A deferred gate: `resolve` releases awaiting IO; `promise` can itself be
// awaited to learn the IO actually arrived — no polling, no sleeps.
export function defer<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
