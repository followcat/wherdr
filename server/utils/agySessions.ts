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
const AGY_UUID = '[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}'
// Under <cli dir>: a presence lock (`presence/<uuid>.lock`) or a conversation
// database (`conversations/<uuid>.db` with its -wal/-shm sidecars). Subagents
// only ever open conversations/<subagent-uuid>.db*, never a presence lock.
const agyDescriptor = (base: string) => new RegExp(
  `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(presence|conversations)/(${AGY_UUID})\\.(lock|db(?:-wal|-shm)?)$`,
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

// The conversation ids an open-descriptor list points at, split into presence
// locks and conversation databases (both empty when none).
export function agyFdIds(paths: string[], home: string, honorEnv: boolean): { presence: string[], conversations: string[] } {
  const base = path.resolve(agyCliDir(home, honorEnv))
  const match = agyDescriptor(base)
  const presence = new Set<string>()
  const conversations = new Set<string>()
  for (const p of paths) {
    const m = match.exec(path.resolve(String(p || '').replace(/ \(deleted\)$/, '')))
    if (!m) continue
    const id = m[2]!.toLowerCase()
    if (m[1]!.toLowerCase() === 'presence' && m[3]!.toLowerCase() === 'lock') presence.add(id)
    else if (m[1]!.toLowerCase() === 'conversations' && /^db(?:-wal|-shm)?$/i.test(m[3]!)) conversations.add(id)
  }
  return { presence: [...presence], conversations: [...conversations] }
}

// Conversation ids an open-descriptor list points at (empty when none).
export function agyFdsSessions(paths: string[], home: string, honorEnv: boolean): string[] {
  const { presence, conversations } = agyFdIds(paths, home, honorEnv)
  return [...new Set([...presence, ...conversations])]
}

export async function agySession(fs: MachineFs, home: string, proc: AgyProcess, honorEnv: boolean): Promise<AgySessionGuess> {
  if (Number.isSafeInteger(proc.pid) && proc.pid! > 0 && fs.readProcessFiles) {
    const files = await fs.readProcessFiles(proc.pid!).catch(() => null)
    if (files) {
      const { presence, conversations } = agyFdIds(files, home, honorEnv)
      // The root conversation holds presence/<root>.lock and may also hold
      // its own conversations/<root>.db next to any subagent DBs; a subagent
      // only ever holds conversations/<subagent>.db. So one presence lock
      // owns the process unless the only open DB names another conversation.
      if (presence.length > 1) return { id: null, ambiguous: true }
      if (presence.length === 1) {
        const root = presence[0]!
        return conversations.length === 0 || conversations.includes(root)
          ? { id: root, ambiguous: false }
          : { id: null, ambiguous: true }
      }
      if (conversations.length === 1) return { id: conversations[0]!, ambiguous: false }
      if (conversations.length > 1) return { id: null, ambiguous: true }
    }
  }
  return { id: proc.argvExact === true ? agyConversationFlag(proc.argv || []) : null, ambiguous: false }
}
