// What a herdr-core accepts, read from its own `hello` and `rpc.discover`, never
// guessed from its version number.

interface Param { name?: unknown, description?: unknown }
interface Discover { methods?: { name?: unknown, params?: Param[] }[] }

export interface CoreCapabilities {
  // `hc machine add user@host:2222` (core 0.1.17+).
  hostPort: boolean
}

// An SSH target that ends with a port: `user@host:2222`, `[::1]:22`.
export const hasPort = (target: string) => /:\d{1,5}$/.test(target.trim())

// hc has no hello feature for ports: the contract is machine.add's `target`, whose
// description lists a `user@host:port` example from the version that accepts one.
function documentsPort(discover: Discover | null | undefined) {
  const add = discover?.methods?.find(m => m?.name === 'machine.add')
  const target = add?.params?.find(p => p?.name === 'target')
  return typeof target?.description === 'string' && /`[^`\s]*@[^`\s]+:\d{1,5}`/.test(target.description)
}

export function coreCapabilities(discover: Discover | null | undefined): CoreCapabilities {
  return { hostPort: documentsPort(discover) }
}
