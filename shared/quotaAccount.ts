// Stable account keys for the quota readings (pacing, WHR-376 § 2.1). A key is
// the program plus the first 8 characters of the account fingerprint
// (`claude:1a2b3c4d`): enough to tell accounts apart, never the whole
// fingerprint. Without a fingerprint, the weekly reset time stands in (fixed for
// an account: `claude:reset-thu21`, UTC weekday and hour), and failing that the
// first machine that read it (`codex:machine-local`).
import type { QuotaAccount, QuotaWindow } from './types'

export type QuotaProgram = QuotaAccount['program']

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const HOUR = 3600000

export function accountKey(program: QuotaProgram, fingerprint: string | null | undefined, week: QuotaWindow | null | undefined, machine: string): string {
  if (fingerprint && /^[0-9a-f]{8,}$/.test(fingerprint)) return `${program}:${fingerprint.slice(0, 8)}`
  if (week?.resetsAt) {
    const d = new Date(Math.round(week.resetsAt / HOUR) * HOUR)
    return `${program}:reset-${DAYS[d.getUTCDay()]}${String(d.getUTCHours()).padStart(2, '0')}`
  }
  const m = machine.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `${program}:machine-${m || 'local'}`
}

// Keys as accountKey writes them: what the rename route accepts.
export const ACCOUNT_KEY = /^(claude|codex):[a-z0-9-]{1,48}$/

// Two different fingerprints sharing their first 8 characters (or two
// accounts with the same reset hour) still get distinct keys: `-2`, `-3`...
export function uniqueKey(key: string, taken: Set<string>): string {
  let k = key
  for (let n = 2; taken.has(k); n++) k = `${key}-${n}`
  taken.add(k)
  return k
}

// The user's name for an account: one line, at most 40 characters; '' = none.
export const ACCOUNT_NAME_MAX = 40
export function cleanAccountName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_NAME_MAX).trim() : ''
}

// The account an agent of `program` on `machine` ('' = local) uses: the one
// whose readings come from that machine. null: no reading of it there (API
// billing, status line not set up, no recent Codex conversation).
export function accountFor(accounts: QuotaAccount[] | undefined, machine: string, program: QuotaProgram): QuotaAccount | null {
  return accounts?.find(a => a.program === program && a.machines.includes(machine)) ?? null
}

// A readable name for an account the user has not named: its program and a
// short id ('Claude a1b2', 'Claude mon08', 'Codex local').
export function defaultAccountName(key: string): string {
  const [program = '', id = ''] = key.split(':')
  const short = /^[0-9a-f]{8}/.test(id) ? id.slice(0, 4) : id.replace(/^(reset|machine)-/, '')
  return `${program.charAt(0).toUpperCase()}${program.slice(1)} ${short}`.trim()
}
