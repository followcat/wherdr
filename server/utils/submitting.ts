// Messages to Claude still being submitted (coreInput.ts): noted in
// DATA_DIR/submitting.json from before the send until Claude took them or
// wherdr gave up, so a restart of wherdr mid-send (the host updates itself)
// resumes them (WHR-419). Read by the server's user only, kept 2 minutes.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './env'

export interface Submitting { id: string, terminal: string, text: string, at: number }
export const SUBMITTING_TTL_MS = 120_000
const FILE = path.join(DATA_DIR, 'submitting.json')

function load(): Submitting[] {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list.filter(s => s && typeof s.terminal === 'string' && typeof s.text === 'string' && typeof s.at === 'number') : []
  } catch { return [] }
}

function save(list: Submitting[]) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 })
    fs.renameSync(tmp, FILE)
  } catch { /* a note lost only means no resume after a restart */ }
}

const fresh = (s: Submitting, now: number) => now - s.at < SUBMITTING_TTL_MS

/** Notes a message being submitted; returns what forgets it. */
export function noteSubmitting(terminal: string, text: string): () => void {
  const s = { id: randomUUID(), terminal, text, at: Date.now() }
  save([...load().filter(x => fresh(x, s.at)), s])
  return () => save(load().filter(x => x.id !== s.id && fresh(x, Date.now())))
}

/** At startup: the sends a restart interrupted, still fresh. */
export function takeSubmitting(): Submitting[] {
  const now = Date.now()
  const list = load()
  if (list.length) save([])
  return list.filter(s => fresh(s, now))
}
