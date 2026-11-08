// DATA_DIR/pacing-log.jsonl (see shared/pacingLog.ts): appended when a reading
// changes, rewritten without its lines older than 8 days. Only this process
// writes it: the lines stay in memory after the first read, and the writes
// run one after another.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { type PacingEntry, LOG_KEEP_MS, changed, keepRecent, lastByAccount, parseEntry, usedToday } from '../../shared/pacingLog'
import { DATA_DIR } from './env'

export const PACING_LOG_FILE = path.join(DATA_DIR, 'pacing-log.jsonl')

const memo = new Map<string, PacingEntry[]>()
let queue: Promise<unknown> = Promise.resolve()

async function load(file: string): Promise<PacingEntry[]> {
  const known = memo.get(file)
  if (known) return known
  let text = ''
  try { text = await fs.readFile(file, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const entries = text.split('\n').flatMap(l => (l ? [parseEntry(l)].filter((e): e is PacingEntry => e !== null) : []))
  memo.set(file, entries)
  return entries
}

const lines = (entries: PacingEntry[]) => entries.map(e => JSON.stringify(e) + '\n').join('')

async function rewrite(file: string, entries: PacingEntry[]) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, lines(entries), { mode: 0o600 })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// Adds the readings that changed; purges past 8 days (a rewrite, at most once
// an hour: the oldest line must be an hour past the limit). Returns the
// lines written.
export function recordReadings(next: PacingEntry[], now = Date.now(), file = PACING_LOG_FILE): Promise<PacingEntry[]> {
  const run = queue.then(async () => {
    const entries = await load(file)
    const last = lastByAccount(entries)
    const added: PacingEntry[] = []
    for (const e of next) {
      if (!changed(last.get(e.account), e)) continue
      added.push(e)
      last.set(e.account, e)
    }
    const stale = entries.length > 0 && entries[0]!.at <= now - LOG_KEEP_MS - 3600000
    if (!added.length && !stale) return added
    await fs.mkdir(path.dirname(file), { recursive: true })
    const all = [...entries, ...added]
    if (stale) {
      const kept = keepRecent(all, now)
      await rewrite(file, kept)
      memo.set(file, kept)
    } else {
      await fs.appendFile(file, lines(added), { mode: 0o600 })
      entries.push(...added)
    }
    return added
  })
  queue = run.catch(() => {})
  return run
}

export async function readPacingLog(file = PACING_LOG_FILE): Promise<PacingEntry[]> {
  await queue
  return keepRecent(await load(file), Date.now())
}

// Weekly % an account used today (null: no reading).
export async function accountUsedToday(key: string, now = Date.now(), file = PACING_LOG_FILE): Promise<number | null> {
  return usedToday(await readPacingLog(file), key, now)
}

// Tests: forget what was loaded.
export function forgetPacingLog() { memo.clear() }
