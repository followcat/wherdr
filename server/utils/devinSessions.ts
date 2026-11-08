import path from 'node:path'
import type { MachineFs } from './fsx'
import { cliDir, transcriptPath } from './devinTranscripts'

export interface DevinProcess {
  pid?: number
  argv?: string[]
  argvExact?: boolean
  // Upper bound on process birth; a lock must be strictly later.
  startedAt?: number
}

// Flags are only identity hints: a current PID lock wins after /resume.
export function devinResume(argv: string[]): string | null {
  for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i]!
    const id = arg === '-r' || arg === '--resume' ? argv[i + 1] : arg.startsWith('--resume=') ? arg.slice(9) : null
    if (id && !id.startsWith('-') && !/[/\\\0]/.test(id)) return id
  }
  return null
}

export async function devinSession(fs: MachineFs, home: string, proc: DevinProcess, honorEnv: boolean): Promise<string | null> {
  if (!Number.isSafeInteger(proc.pid) || proc.pid! <= 0) return null
  const dir = path.join(cliDir(home, honorEnv), 'session_locks')
  if (proc.startedAt != null) {
    if (!fs.readPidLocks) return null
    const entries = await fs.readPidLocks(dir).catch(e => {
      if (!['ENOENT', 'ENOTDIR'].includes(String((e as { code?: string }).code))) throw e
      return []
    })
    // Never select an identity from a truncated or ambiguous scan.
    if (!entries) return null
    const matches: string[] = []
    for (const { name, stat: st, pid } of entries) {
      if (!st.isFile || st.size > 32 || st.mtimeMs <= proc.startedAt || !Number.isSafeInteger(pid) || pid !== proc.pid) continue
      if (name.endsWith('.lock') && transcriptPath(home, name.slice(0, -5), honorEnv)) matches.push(name.slice(0, -5))
    }
    if (matches.length) return matches.length === 1 ? matches[0]! : null
  }
  return proc.argvExact === true ? devinResume(proc.argv || []) : null
}
