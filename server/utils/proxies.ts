// The named proxies, kept on the server (DATA_DIR/proxies.json) so every
// device shares them: one file, written atomically, one write at a time.
// A stored password never leaves the server: GET answers the entries with
// user:•••@host:port, and a URL posted back with the mask keeps the stored
// password. Nothing here logs a proxy URL.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cleanProxyEntry, maskedProxyUrl, proxyEnv, proxyOfferedOn, PROXY_MASK, type ProxyEntry, type ProxyStore } from '../../shared/proxies'
import { DATA_DIR } from './env'
import { HerdrError } from './herdr'

export const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json')

const EMPTY: ProxyStore = { proxies: [], last: {} }

function cleanStore(raw: unknown): ProxyStore {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const proxies = (Array.isArray(o.proxies) ? o.proxies : [])
    .map(e => cleanProxyEntry(e))
    .filter((e): e is NonNullable<typeof e> & { id: string } => Boolean(e?.id))
    .map(e => ({ ...e, id: e.id }))
  const last: Record<string, string> = {}
  if (o.last && typeof o.last === 'object' && !Array.isArray(o.last))
    for (const [k, v] of Object.entries(o.last as Record<string, unknown>))
      if (typeof v === 'string') last[k] = v
  return { proxies, last }
}

export async function readProxies(file = PROXIES_FILE): Promise<ProxyStore> {
  try { return cleanStore(JSON.parse(await fs.readFile(file, 'utf8'))) } catch { return { ...EMPTY } }
}

async function writeStore(store: ProxyStore, file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify({ v: 1, ...store }) + '\n', { mode: 0o600 })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// Writes one after another (same rule as settings.json).
let queue: Promise<unknown> = Promise.resolve()
function queued<T>(run: () => Promise<T>): Promise<T> {
  const p = queue.then(run)
  queue = p.catch(() => {})
  return p
}

// An entry as a client sees it: the password masked, never sent back.
export const maskedProxy = (e: ProxyEntry): ProxyEntry => ({ ...e, url: maskedProxyUrl(e.url) })

export async function proxiesView(file = PROXIES_FILE) {
  const store = await readProxies(file)
  return { proxies: store.proxies.map(maskedProxy), last: store.last }
}

// The whole list at once (add, edit, delete and reorder all come as the new
// list). Entries carry their id; an entry without one is new. A url with the
// ••• mask keeps the stored password of the entry of the same id.
export async function saveProxies(raw: unknown, file = PROXIES_FILE): Promise<ProxyEntry[]> {
  return queued(async () => {
    if (!Array.isArray(raw)) throw new HerdrError('bad_proxy', 'Invalid proxies')
    const store = await readProxies(file)
    const kept = new Map(store.proxies.map(e => [e.id, e]))
    const proxies: ProxyEntry[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const e = cleanProxyEntry(item)
      if (!e) throw new HerdrError('bad_proxy', 'Invalid proxy')
      if (e.id && seen.has(e.id)) throw new HerdrError('bad_proxy', 'Invalid proxy')
      const id = e.id || crypto.randomBytes(6).toString('hex')
      seen.add(id)
      let url = e.url
      const u = new URL(url)
      let password = ''
      try { password = decodeURIComponent(u.password) } catch { password = u.password }
      if (password === PROXY_MASK) {
        const before = e.id ? kept.get(e.id) : undefined
        let old = ''
        if (before) try { old = decodeURIComponent(new URL(before.url).password) } catch { old = '' }
        if (!old) throw new HerdrError('bad_proxy', 'Invalid proxy')
        // Rebuilt from parts: the stored password in the mask's place, the
        // url otherwise as it came (a toString() would add a trailing '/').
        url = `${u.protocol}//${u.username ? `${u.username}:` : ''}${encodeURIComponent(old)}@${u.host}`
      }
      proxies.push({ ...e, id, url })
    }
    // A remembered choice that names a forgotten entry is dropped.
    const last = Object.fromEntries(Object.entries(store.last).filter(([, id]) => !id || seen.has(id)))
    await writeStore({ proxies, last }, file)
    return proxies.map(maskedProxy)
  })
}

// The last choice on a machine ('' = None), saved on launch. A choice that
// names no entry is not kept.
export async function rememberProxyChoice(machineKey: string, proxyId: string, file = PROXIES_FILE) {
  return queued(async () => {
    const store = await readProxies(file)
    if (proxyId && !store.proxies.some(e => e.id === proxyId)) return
    if ((store.last[machineKey] ?? '') === proxyId) return
    await writeStore({ ...store, last: { ...store.last, [machineKey]: proxyId } }, file)
  })
}

// The proxy env for a launch on a machine: `proxy` is the chosen id ('' =
// none); when it is undefined (a path without a picker), the remembered
// choice of the machine applies. Never logs the URL.
export function proxyEnvFor(store: ProxyStore, machineKey: string, proxy: unknown): Record<string, string> {
  const id = proxy === undefined ? store.last[machineKey] || '' : String(proxy || '')
  const entry = id ? store.proxies.find(e => e.id === id) : undefined
  return entry && proxyOfferedOn(entry, machineKey) ? proxyEnv(entry) : {}
}
