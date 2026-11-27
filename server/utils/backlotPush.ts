// Push one notification for each new backlot item waiting for the user: a
// role's attention_seq, or a Hollywood card. The keys already notified live in
// DATA_DIR/backlot-push.json with their first-seen time, so a restart never
// sends them again and closed keys age out. The first scan only primes that
// file: what was already waiting before wherdr watched it is not pushed.
import path from 'node:path'
import { rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { BacklotMachineView } from '../../shared/backlot'
import { studioLink } from '../../shared/appLinks'
import { fmt } from '../../shared/message'
import { DATA_DIR, log } from './env'
import { readJsonOrMissing, writeJsonAtomic } from './atomicWrite'
import { readPoolBacklotDocs, type BacklotPoolEntry } from './backlotDocs'
import { pushSend, type PushPayload } from './push'

const STORE_FILE = path.join(DATA_DIR, 'backlot-push.json')
const SCAN_MS = 4000
const BODY_MAX = 200
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface BacklotPushItem {
  kind: 'ask' | 'card'
  key: string
  session: string
  machine: string
  studio: string
  studioTitle: string
  body: string
}

const firstLine = (text: string | null | undefined) => (text || '').split('\n').map(l => l.trim()).find(Boolean) || ''
const pushLine = (text: string | null | undefined) => firstLine(text).slice(0, BODY_MAX)
const keyOf = (parts: unknown[]) => JSON.stringify(parts)

// Everything open right now. The identity key is machine+session+studio+seq
// (or card id): the session is part of a machine's pool identity, because two
// sessions can hold same-named studios.
export function collectBacklotPushItems(views: BacklotMachineView[]): BacklotPushItem[] {
  const items: BacklotPushItem[] = []
  for (const view of views) {
    const session = view.session || ''
    for (const studio of view.summary.studios) {
      for (const role of studio.roles || []) {
        if (!role.attention_user || role.attention_seq == null) continue
        items.push({
          kind: 'ask',
          key: keyOf(['ask', view.machine, session, studio.id, role.attention_seq]),
          session,
          machine: view.machine,
          studio: studio.id,
          studioTitle: studio.title,
          body: pushLine(role.attention_detail || role.asks || role.attention),
        })
      }
    }
    for (const card of view.summary.hollywood?.cards || []) {
      const owner = view.summary.studios.find(s => s.id === card.studio || s.title === card.studio)
      const studio = owner?.id || card.studio
      if (!studio) continue
      items.push({
        kind: 'card',
        key: keyOf(['card', view.machine, session, studio, card.id]),
        session,
        machine: view.machine,
        studio,
        studioTitle: owner?.title || card.studio,
        body: pushLine(card.why || card.action),
      })
    }
  }
  return items
}

export function backlotPushPayload(item: BacklotPushItem): PushPayload {
  const tagHash = createHash('sha256').update(item.key).digest('hex').slice(0, 16)
  return {
    title: fmt(item.kind === 'ask' ? '{studio} asks' : '{studio} · card', { studio: item.studioTitle }),
    body: item.body,
    tag: `backlot-${item.kind}-${tagHash}`,
    url: `/${studioLink({ studio: item.studio, machine: item.machine, session: item.session })}`,
  }
}

interface Store { fresh: boolean, keys: Map<string, number>, dirty: boolean }

async function recoverStore(file: string, now: number, noteCorrupt: () => void): Promise<Store> {
  noteCorrupt()
  await rename(file, `${file}.corrupt-${now}`)
  return { fresh: true, keys: new Map(), dirty: true }
}

async function readStore(file: string, now: number, noteCorrupt: () => void): Promise<Store> {
  let raw: unknown
  try { raw = await readJsonOrMissing(file) } catch { return recoverStore(file, now, noteCorrupt) }
  if (raw === undefined) return { fresh: true, keys: new Map(), dirty: true }
  const data = raw as { version?: unknown, keys?: unknown }
  if (data?.version === 1 && Array.isArray(data.keys) && data.keys.every(k => typeof k === 'string')) {
    return { fresh: false, keys: new Map((data.keys as string[]).map(k => [k, now])), dirty: true }
  }
  if (data?.version === 2 && data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys)
      && Object.values(data.keys).every(t => typeof t === 'number' && Number.isFinite(t))) {
    return { fresh: false, keys: new Map(Object.entries(data.keys as Record<string, number>)), dirty: false }
  }
  return recoverStore(file, now, noteCorrupt)
}

const writeStore = (file: string, keys: Map<string, number>) => writeJsonAtomic(file, {
  version: 2,
  keys: Object.fromEntries([...keys.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
})

export interface BacklotPushWatcherOptions {
  file?: string
  send?: (payload: PushPayload) => Promise<number>
  viewed?: (item: BacklotPushItem) => boolean
}

export function createBacklotPushWatcher({ file = STORE_FILE, send = pushSend, viewed = () => false }: BacklotPushWatcherOptions = {}) {
  // Scans can be triggered by several core entries at once. Serialize them so
  // the read-modify-write of the dedup file cannot interleave.
  let queue: Promise<unknown> = Promise.resolve()
  let corruptLogged = false
  const noteCorrupt = () => {
    if (corruptLogged) return
    corruptLogged = true
    log('backlot notification: store unreadable, starting over')
  }

  async function scanNow(views: BacklotMachineView[]) {
    const now = Date.now()
    const open = collectBacklotPushItems(views)
    const openKeys = new Set(open.map(item => item.key))
    const store = await readStore(file, now, noteCorrupt)
    const fresh = open.filter(item => !store.keys.has(item.key))
    let pruned = false
    for (const [key, firstSeen] of store.keys) {
      if (now - firstSeen > KEEP_MS && !openKeys.has(key)) {
        store.keys.delete(key)
        pruned = true
      }
    }
    if (!fresh.length && !store.dirty && !pruned) return 0

    for (const item of fresh) store.keys.set(item.key, now)
    await writeStore(file, store.keys)
    if (store.fresh) return 0

    let sent = 0
    for (const item of fresh) {
      if (viewed(item)) continue
      sent += await send(backlotPushPayload(item))
    }
    return sent
  }

  return {
    scan(views: BacklotMachineView[]) {
      const run = queue.then(() => scanNow(views))
      queue = run.catch(() => {})
      return run
    },
  }
}

const watcher = createBacklotPushWatcher()
let scanStarted = -Infinity
let scanning: Promise<number> | null = null

// A scan of the pool, throttled to the existing core poll rhythm (about the
// same interval as the backlot document cache, so events still make it fresh).
export function scanBacklotPush(entries: BacklotPoolEntry[], now = Date.now(), force = false): Promise<number> {
  if (!force && now - scanStarted < SCAN_MS) return Promise.resolve(0)
  if (scanning) return scanning
  scanStarted = now
  scanning = (async () => {
    const docs = await readPoolBacklotDocs(entries, now)
    if (!docs.ok) return 0
    return watcher.scan(docs.views)
  })().finally(() => { scanning = null })
  return scanning
}
