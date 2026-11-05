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
  let names: string[]
  try { names = await fs.readdir(dir) }
  catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes(String((e as { code?: string }).code))) throw e
    names = []
  }
  const locks = names.filter(n => n.endsWith('.lock') && transcriptPath(home, n.slice(0, -5), honorEnv))
  // Never select an identity from a truncated or ambiguous scan.
  if (locks.length > 4096) return null
  if (proc.startedAt != null) {
    if (locks.length && !fs.readSmallMany) return null
    const entries = await fs.readSmallMany?.(locks.map(n => path.join(dir, n)), 32) || []
    const matches: string[] = []
    for (let i = 0; i < locks.length; i++) {
      const { stat: st, body } = entries[i] || {}
      if (!st?.isFile || st.size > 32 || st.mtimeMs <= proc.startedAt || !body || body.length > 32) continue
      const pid = body.toString('utf8').trim()
      if (/^\d+$/.test(pid) && Number(pid) === proc.pid) matches.push(locks[i]!.slice(0, -5))
    }
    if (matches.length) return matches.length === 1 ? matches[0]! : null
  }
  return proc.argvExact === true ? devinResume(proc.argv || []) : null
}
