// Upstream's terminal-modifier helpers now live in virtualKeys.ts (same
// semantics plus navigation bytes, 'super', and paste/blocked distinction).
// Re-exported under the upstream module path so upstream's tests and any
// future upstream code keep resolving against the shared implementation.
export { VIRTUAL_MODIFIERS, type VirtualModifier, toggleVirtualModifier, virtualChord, createCompositionTracker } from './virtualKeys'
import { virtualInputAction } from './virtualKeys'

// Upstream contract: the logical key a data event carries, or null when the
// data is text/paste to send verbatim. 'blocked' data (prototype keys,
// multi-char strings) is also null — the caller drops it or sends as text.
export function virtualInputKey(data: string): string | null {
  const action = virtualInputAction(data)
  return action.kind === 'key' ? action.key : null
}
