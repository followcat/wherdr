// Push one notification for each new backlot item waiting for the user: a
// role's attention_seq, or a Hollywood card. The keys already notified live in
// DATA_DIR/backlot-push.json, so a restart never sends them again. The first
// scan only primes that file: what was already waiting before wherdr watched it
// is not pushed.
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BacklotMachineView } from '../../shared/backlot'
import { studioLink } from '../../shared/appLinks'
import { fmt } from '../../shared/message'
import { DATA_DIR } from './env'
import { readJsonOrMissing, writeJsonAtomic } from './atomicWrite'
import { readPoolBacklotDocs, type BacklotPoolEntry } from './backlotDocs'
import { pushSend, type PushPayload } from './push'

const STORE_FILE = path.join(DATA_DIR, 'backlot-push.json')
const SCAN_MS = 4000
const BODY_MAX = 200

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

interface Store { fresh: boolean, keys: Set<string> }

async function readStore(file: string): Promise<Store> {
  const raw = await readJsonOrMissing(file)
  if (raw === undefined) return { fresh: true, keys: new Set() }
  const data = raw as { version?: unknown, keys?: unknown }
  if (data?.version !== 1 || !Array.isArray(data.keys) || data.keys.some(k => typeof k !== 'string')) {
    throw new Error(`invalid backlot push store: ${file}`)
  }
  return { fresh: false, keys: new Set(data.keys as string[]) }
}

const writeStore = (file: string, keys: Set<string>) => writeJsonAtomic(file, { version: 1, keys: [...keys].sort() })

export interface BacklotPushWatcherOptions {
  file?: string
  send?: (payload: PushPayload) => Promise<number>
  viewed?: (item: BacklotPushItem) => boolean
}

export function createBacklotPushWatcher({ file = STORE_FILE, send = pushSend, viewed = () => false }: BacklotPushWatcherOptions = {}) {
  // Scans can be triggered by several core entries at once. Serialize them so
  // the read-modify-write of the dedup file cannot interleave.
  let queue: Promise<unknown> = Promise.resolve()

  async function scanNow(views: BacklotMachineView[]) {
    const open = collectBacklotPushItems(views)
    const store = await readStore(file)
    const fresh = open.filter(item => !store.keys.has(item.key))
    if (!fresh.length && !store.fresh) return 0

    const keys = new Set(store.keys)
    for (const item of fresh) keys.add(item.key)
    await writeStore(file, keys)
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
