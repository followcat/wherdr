// Which Antigravity conversation a running `agy` process owns: the files it
// holds open say it exactly (conversation database + WAL, presence lock); its
// launch `--conversation` flag is a hint used only when the descriptor scan is
// empty or unavailable. Several candidates or an incomplete scan never resolve
// to a session — a wrong guess would put another conversation on screen.
import path from 'node:path'
import type { MachineFs } from './fsx'
import { agyCliDir } from './agyTranscripts'

export interface AgyProcess {
  pid?: number
  argv?: string[]
  argvExact?: boolean
}

export interface AgySessionGuess { id: string | null, ambiguous: boolean }

const AGY_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
// <cli dir>/conversations/<uuid>.db(.-wal/.-shm) or <cli dir>/presence/<uuid>.lock.
const agyFile = (base: string) => new RegExp(
  `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:conversations|presence)/([\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12})\\.(?:db(?:-wal|-shm)?|lock)$`,
  'i',
)

// Exact `--conversation <uuid>` / `--conversation=<uuid>` in the launch argv.
export function agyConversationFlag(argv: string[]): string | null {
  for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i]!
    const id = arg === '--conversation' ? argv[i + 1] : arg.startsWith('--conversation=') ? arg.slice(15) : null
    if (id && AGY_ID.test(id)) return id
  }
  return null
}

// Conversation ids an open-descriptor list points at (empty when none).
export function agyFdsSessions(paths: string[], home: string, honorEnv: boolean): string[] {
  const base = path.resolve(agyCliDir(home, honorEnv))
  const match = agyFile(base)
  const found = new Set<string>()
  for (const p of paths) {
    const m = match.exec(path.resolve(String(p || '').replace(/ \(deleted\)$/, '')))
    if (m) found.add(m[1]!.toLowerCase())
  }
  return [...found]
}

export async function agySession(fs: MachineFs, home: string, proc: AgyProcess, honorEnv: boolean): Promise<AgySessionGuess> {
  if (Number.isSafeInteger(proc.pid) && proc.pid! > 0 && fs.readProcessFiles) {
    const files = await fs.readProcessFiles(proc.pid!)
    if (files) {
      const ids = agyFdsSessions(files, home, honorEnv)
      // An ambiguous descriptor set (two conversations held open) resolves to nothing.
      if (ids.length) return { id: ids.length === 1 ? ids[0]! : null, ambiguous: ids.length !== 1 }
    }
  }
  return { id: proc.argvExact === true ? agyConversationFlag(proc.argv || []) : null, ambiguous: false }
}
