// The pace policy of each quota account (WHR-376 § 2.1), by stable account key:
// DATA_DIR/pacing.json, written atomically, one write at a time. Only the user
// changes it, from Settings › Pace; an account without an entry keeps the
// default, 'unlimited' (shown as 'Free'). A saved policy keeps its mode.
import path from 'node:path'
import { readJsonOrMissing, writeFileAtomic } from './atomicWrite'
import { ACCOUNT_KEY } from '../../shared/quotaAccount'
import { DEFAULT_PACE, mergePolicy, type PacePolicy } from '../../shared/pm/pacing'
import { DATA_DIR } from './env'

export const PACING_FILE = path.join(DATA_DIR, 'pacing.json')

// A stored burn whose reset has passed is dropped.
// Strict (for a change): only a missing file is empty; anything else throws,
// so a change never resets the other accounts' policies.
async function loadPolicies(file: string, now: number): Promise<Record<string, PacePolicy>> {
  const raw = ((await readJsonOrMissing(file)) as { policies?: unknown } | undefined)?.policies
  const out: Record<string, PacePolicy> = {}
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (ACCOUNT_KEY.test(k) && v && typeof v === 'object') out[k] = mergePolicy(DEFAULT_PACE, v, now)
  }
  return out
}

export const readPolicies = (file = PACING_FILE, now = Date.now()) => loadPolicies(file, now).catch(() => ({}) as Record<string, PacePolicy>)

export const policyIn = (policies: Record<string, PacePolicy>, key: string) => policies[key] ?? DEFAULT_PACE

let queue: Promise<unknown> = Promise.resolve()

// Applies the user's changes to an account's policy. Returns the new policy.
export function setPolicy(key: string, patch: unknown, file = PACING_FILE, now = Date.now()): Promise<PacePolicy> {
  const run = queue.then(async () => {
    const policies = await loadPolicies(file, now)
    const policy = mergePolicy(policyIn(policies, key), patch, now)
    policies[key] = policy
    await writeFileAtomic(file, JSON.stringify({ v: 1, policies }) + '\n')
    return policy
  })
  queue = run.catch(() => {})
  return run
}
