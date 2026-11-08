// Named proxies kept on the server (DATA_DIR/proxies.json) so every device
// shares them. Offered in the "New" sheet of each machine an entry names
// (`machines`, machine keys — '' is this one; absent = all machines).
// A proxy is machine-relative: 127.0.0.1 means that machine's own proxy.

export interface ProxyEntry {
  id: string
  name: string
  // http://, https:// or socks5://, optionally user:pass@host:port.
  url: string
  // Comma-separated hosts that skip the proxy (NO_PROXY), optional.
  noProxy?: string
  // Machine keys it is offered on; absent or empty = every machine.
  machines?: string[]
}

// The file on the server. `last`: the proxy id last chosen on each machine
// ('' = "None"), preselected the next time.
export interface ProxyStore { proxies: ProxyEntry[], last: Record<string, string> }

export const PROXY_SCHEMES = ['http:', 'https:', 'socks5:']
// Password shown to clients and typed back unchanged on edit: never a real
// password (server/utils/proxies.ts keeps the stored one then).
export const PROXY_MASK = '•••'

// The URL with its password masked, for lists and the edit form. The mask
// stays in the password's place, so a form posted back unchanged is known to
// keep the stored password.
export function maskedProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (!u.password) return url
    const user = u.username ? `${u.username}:` : ''
    return `${u.protocol}//${user}${PROXY_MASK}@${u.host}`
  } catch { return url }
}

// What a stored URL's password is (URL-decoded), '' when there is none.
function urlPassword(u: URL): string {
  try { return decodeURIComponent(u.password) } catch { return u.password }
}

// A proxy entry read from the file or sent by a client, or null when invalid.
// `id` may be missing on a new entry (the server assigns it).
export function cleanProxyEntry(raw: unknown): Omit<ProxyEntry, 'id'> & { id?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name || name.length > 60) return null
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  let u: URL
  try { u = new URL(url) } catch { return null }
  // A non-special scheme (socks5) leaves pathname empty; http(s) gives '/'.
  if (!PROXY_SCHEMES.includes(u.protocol) || !u.hostname || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
  const out: Omit<ProxyEntry, 'id'> & { id?: string } = { name, url }
  if (typeof o.id === 'string' && /^[a-z0-9]{6,32}$/.test(o.id)) out.id = o.id
  // The masked password is not a value to store: it is resolved later, against
  // the entry this id names (a new entry has none to keep).
  if (urlPassword(u) === PROXY_MASK && !out.id) return null
  if (typeof o.noProxy === 'string' && o.noProxy.trim()) out.noProxy = o.noProxy.trim().slice(0, 1024)
  if (Array.isArray(o.machines)) {
    const machines = [...new Set(o.machines.filter((m): m is string => typeof m === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(m)))]
    if (machines.length) out.machines = machines
  }
  return out
}

// The entries offered on a machine (machine key, '' = this one).
export function proxyOfferedOn(entry: ProxyEntry, machineKey: string): boolean {
  return !entry.machines?.length || entry.machines.includes(machineKey)
}

// The environment of a launch through this proxy, for terminal.run's `env`
// (never in the command line: it stays out of titles and argv).
export function proxyEnv(entry: ProxyEntry): Record<string, string> {
  const env: Record<string, string> = {
    HTTPS_PROXY: entry.url, HTTP_PROXY: entry.url,
    https_proxy: entry.url, http_proxy: entry.url,
  }
  if (entry.url.startsWith('socks5:')) Object.assign(env, { ALL_PROXY: entry.url, all_proxy: entry.url })
  if (entry.noProxy) Object.assign(env, { NO_PROXY: entry.noProxy, no_proxy: entry.noProxy })
  return env
}
