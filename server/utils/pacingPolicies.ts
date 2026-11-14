// The pace policy of each quota account (WHR-376 § 2.1), by stable account key:
// DATA_DIR/pacing.json, written atomically, one write at a time. Only the user
// changes it, from Settings › Pace; an account without an entry keeps the
// default, 'unlimited' (shown as 'Free'). A saved policy keeps its mode.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_KEY } from '../../shared/quotaAccount'
import { DEFAULT_PACE, mergePolicy, type PacePolicy } from '../../shared/pm/pacing'
import { DATA_DIR } from './env'

export const PACING_FILE = path.join(DATA_DIR, 'pacing.json')

// A stored burn whose reset has passed is dropped.
export async function readPolicies(file = PACING_FILE, now = Date.now()): Promise<Record<string, PacePolicy>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))?.policies
    const out: Record<string, PacePolicy> = {}
    for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (ACCOUNT_KEY.test(k) && v && typeof v === 'object') out[k] = mergePolicy(DEFAULT_PACE, v, now)
    }
    return out
  } catch { return {} }
}

export const policyIn = (policies: Record<string, PacePolicy>, key: string) => policies[key] ?? DEFAULT_PACE

let queue: Promise<unknown> = Promise.resolve()

// Applies the user's changes to an account's policy. Returns the new policy.
export function setPolicy(key: string, patch: unknown, file = PACING_FILE, now = Date.now()): Promise<PacePolicy> {
  const run = queue.then(async () => {
    const policies = await readPolicies(file, now)
    const policy = mergePolicy(policyIn(policies, key), patch, now)
    policies[key] = policy
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify({ v: 1, policies }) + '\n', { mode: 0o600 })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return policy
  })
  queue = run.catch(() => {})
  return run
}
