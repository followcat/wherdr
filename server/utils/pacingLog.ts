// DATA_DIR/pacing-log.jsonl (see shared/pacingLog.ts): appended when a reading
// changes, rewritten without its lines older than 8 days. Only this process
// writes it: the lines stay in memory after the first read, and the writes
// run one after another.
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomicWrite'
import { type PacingEntry, LOG_KEEP_MS, changed, keepRecent, lastByAccount, parseEntry, usedToday } from '../../shared/pacingLog'
import { DATA_DIR } from './env'

export const PACING_LOG_FILE = path.join(DATA_DIR, 'pacing-log.jsonl')

const memo = new Map<string, PacingEntry[]>()
// Files whose last line was cut (no newline at the end, or an append that
// failed midway): the next append starts on a line of its own, never glued to it.
const cut = new Set<string>()
let queue: Promise<unknown> = Promise.resolve()

async function load(file: string): Promise<PacingEntry[]> {
  const known = memo.get(file)
  if (known) return known
  let text = ''
  try { text = await fs.readFile(file, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  if (text && !text.endsWith('\n')) cut.add(file)
  const entries = text.split('\n').flatMap(l => (l ? [parseEntry(l)].filter((e): e is PacingEntry => e !== null) : []))
  memo.set(file, entries)
  return entries
}

const lines = (entries: PacingEntry[]) => entries.map(e => JSON.stringify(e) + '\n').join('')

const rewrite = (file: string, entries: PacingEntry[]) => writeFileAtomic(file, lines(entries))

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
      cut.delete(file)
      memo.set(file, kept)
    } else {
      const start = cut.has(file) ? '\n' : ''
      cut.add(file)
      await fs.appendFile(file, start + lines(added), { mode: 0o600 })
      cut.delete(file)
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
export function forgetPacingLog() { memo.clear(); cut.clear() }
