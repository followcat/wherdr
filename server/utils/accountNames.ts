// The user's names for the quota accounts ("Work Pro", "Personal"), by stable
// account key (shared/quotaAccount.ts): DATA_DIR/account-names.json, written
// atomically, one write at a time.
import path from 'node:path'
import { readJsonOrMissing, writeFileAtomic } from './atomicWrite'
import { ACCOUNT_KEY, cleanAccountName } from '../../shared/quotaAccount'
import { DATA_DIR } from './env'

export const ACCOUNT_NAMES_FILE = path.join(DATA_DIR, 'account-names.json')

// Strict: only a missing file is empty; anything else throws, so a change
// never drops the other names.
async function loadAccountNames(file: string): Promise<Record<string, string>> {
  const raw = ((await readJsonOrMissing(file)) as { names?: unknown } | undefined)?.names
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const name = cleanAccountName(v)
    if (ACCOUNT_KEY.test(k) && name) out[k] = name
  }
  return out
}

export const readAccountNames = (file = ACCOUNT_NAMES_FILE) => loadAccountNames(file).catch(() => ({}) as Record<string, string>)

let queue: Promise<unknown> = Promise.resolve()

// Names an account; an empty name removes it. Returns the names.
export function setAccountName(key: string, name: string, file = ACCOUNT_NAMES_FILE): Promise<Record<string, string>> {
  const run = queue.then(async () => {
    const names = await loadAccountNames(file)
    const clean = cleanAccountName(name)
    if (clean) names[key] = clean
    else delete names[key]
    await writeFileAtomic(file, JSON.stringify({ v: 1, names }) + '\n')
    return names
  })
  queue = run.catch(() => {})
  return run
}
