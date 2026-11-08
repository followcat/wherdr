// The named proxies (Settings › Agents › Proxies) the New sheet offers: the
// server keeps them (DATA_DIR/proxies.json) and never sends a stored password
// back — every url the app sees is masked (user:•••@host:port). `last`: the
// proxy last launched on each machine, the picker's preselection.
import { proxyOfferedOn, type ProxyEntry } from '#shared/proxies'

export const proxies = ref<ProxyEntry[]>([])
export const proxyLast = ref<Record<string, string>>({})

export async function loadProxies() {
  try {
    const r = await api<{ proxies?: ProxyEntry[], last?: Record<string, string> }>('/api/proxies')
    proxies.value = r.proxies || []
    proxyLast.value = r.last || {}
  } catch { /* keep what we have */ }
}

// The entries the New sheet offers on a machine ('' = this one).
export const proxiesOn = (machineKey: string) => proxies.value.filter(p => proxyOfferedOn(p, machineKey))

// The picker's first value on a machine: its remembered choice when still
// offered there, else None.
export function rememberedProxy(machineKey: string) {
  const id = proxyLast.value[machineKey] || ''
  return id && proxiesOn(machineKey).some(p => p.id === id) ? id : ''
}

// The whole list at once (add, edit, delete, reorder all come as the new
// list); the server answers with the masked list it kept.
export async function saveProxies(list: ProxyEntry[]) {
  const r = await api<{ proxies?: ProxyEntry[], last?: Record<string, string> }>('/api/proxies', { proxies: list })
  proxies.value = r.proxies || []
  proxyLast.value = r.last || {}
}
