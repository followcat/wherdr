// The user's names for the quota accounts ("Work Pro", "Personal"), by stable
// account key (shared/quotaAccount.ts): DATA_DIR/account-names.json, written
// atomically, one write at a time.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_KEY, cleanAccountName } from '../../shared/quotaAccount'
import { DATA_DIR } from './env'

export const ACCOUNT_NAMES_FILE = path.join(DATA_DIR, 'account-names.json')

export async function readAccountNames(file = ACCOUNT_NAMES_FILE): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))?.names
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      const name = cleanAccountName(v)
      if (ACCOUNT_KEY.test(k) && name) out[k] = name
    }
    return out
  } catch { return {} }
}

let queue: Promise<unknown> = Promise.resolve()

// Names an account; an empty name removes it. Returns the names.
export function setAccountName(key: string, name: string, file = ACCOUNT_NAMES_FILE): Promise<Record<string, string>> {
  const run = queue.then(async () => {
    const names = await readAccountNames(file)
    const clean = cleanAccountName(name)
    if (clean) names[key] = clean
    else delete names[key]
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify({ v: 1, names }) + '\n', { mode: 0o600 })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return names
  })
  queue = run.catch(() => {})
  return run
}
