import { cleanDoc, type CoreDocs } from '../../shared/coreLayout'
import type { CoreMachine } from '../../shared/coreState'

// The "herdr-app" document of this core and of each connected machine, read only.
// Cached for a few seconds (a remote read goes over ssh); a missing, unreadable or
// too old document counts as none, and the home falls back to the folder grouping.
const TTL = 5000
type Call = <T>(method: string, params: object) => Promise<T>
export function createCoreDocsReader() {
  const cache = new Map<string, { at: number; doc: CoreDocs[string] }>()
  return {
    async read(call: Call, machines: CoreMachine[], now = Date.now()): Promise<CoreDocs> {
      const names = ['', ...machines.filter(m => m.state === 'connected').map(m => m.name)]
      for (const known of cache.keys()) if (!names.includes(known)) cache.delete(known)
      const docs: CoreDocs = {}
      await Promise.all(names.map(async (name) => {
        const old = cache.get(name)
        if (old && now - old.at < TTL) { docs[name] = old.doc; return }
        let doc: CoreDocs[string] = null
        try {
          doc = cleanDoc((await call<{ value?: unknown }>('doc.get', { name: 'herdr-app', ...(name ? { on: name } : {}) }))?.value)
        } catch { doc = old?.doc ?? null }
        cache.set(name, { at: now, doc })
        docs[name] = doc
      }))
      return docs
    },
    clear() { cache.clear() },
  }
}

const defaultReader = createCoreDocsReader()

export async function readCoreDocs(call: Call, machines: CoreMachine[], now = Date.now()): Promise<CoreDocs> {
  return defaultReader.read(call, machines, now)
}

export const clearCoreDocs = () => defaultReader.clear()
