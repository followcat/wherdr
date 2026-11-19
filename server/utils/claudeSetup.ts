// Claude quota suggestion declined or skipped, per machine key (the home
// machine menu's "Don't suggest", or the setup guide's Quotas step left
// without installing). Kept in the data folder so every device stops offering
// it; Settings still shows each machine's state and its Install button.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './env'
import { writeJsonAtomicSync } from './atomicWrite'
import { MACHINE_KEY_RE } from '../../shared/ids'

export const CLAUDE_SETUP_FILE = path.join(DATA_DIR, 'claude-quotas.json')

const validKey = (k: unknown): k is string => typeof k === 'string' && (k === '' || MACHINE_KEY_RE.test(k))

export function readDismissed(file = CLAUDE_SETUP_FILE): Set<string> {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { dismissed?: unknown }
    return new Set(Array.isArray(saved.dismissed) ? saved.dismissed.filter(validKey) : [])
  } catch { return new Set() }
}

// Adds (dismissed) or removes keys; returns the resulting list.
export function writeDismissed(keys: readonly string[], dismissed: boolean, file = CLAUDE_SETUP_FILE): string[] {
  const set = readDismissed(file)
  for (const k of keys) {
    if (!validKey(k)) continue
    if (dismissed) set.add(k)
    else set.delete(k)
  }
  const list = [...set].sort()
  writeJsonAtomicSync(file, { dismissed: list })
  return list
}
