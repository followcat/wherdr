// Order of the phone key bar (components/PhoneKeybar.vue), chosen in
// Settings › Terminal and kept on this device. Every key has a stable id; the
// saved order lists ids. Merging never loses a key: unknown or repeated ids are
// dropped, keys missing from the saved list (added in a later version) go last.

export const PHONE_KEY_IDS = [
  'keyboard', 'ctrl', 'esc', 'tab', 'left', 'up', 'down', 'right', 'enter', 'ctrl-c', 'backspace',
  'home', 'end', 'pageup', 'pagedown', 'delete', 'insert', 'alt', 'shift', 'y', 'n',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
] as const

export type PhoneKeyId = typeof PHONE_KEY_IDS[number]

export const PHONE_KEY_ORDER_KEY = 'phoneKeyOrder'

const known = new Set<string>(PHONE_KEY_IDS)
export const isPhoneKeyId = (id: unknown): id is PhoneKeyId => typeof id === 'string' && known.has(id)

// The saved ids that still exist, in their order, then every key they miss
// in the default order.
export function mergeKeyOrder(saved: readonly unknown[] | null | undefined, defaults: readonly PhoneKeyId[] = PHONE_KEY_IDS): PhoneKeyId[] {
  const out: PhoneKeyId[] = []
  const seen = new Set<string>()
  for (const id of saved || []) {
    if (!isPhoneKeyId(id) || !defaults.includes(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of defaults) if (!seen.has(id)) out.push(id)
  return out
}

// The stored text (a JSON list of ids) as a full order; anything else is the default.
export function readKeyOrder(raw: string | null | undefined): PhoneKeyId[] {
  if (!raw) return [...PHONE_KEY_IDS]
  try {
    const value: unknown = JSON.parse(raw)
    return mergeKeyOrder(Array.isArray(value) ? value : null)
  } catch { return [...PHONE_KEY_IDS] }
}

export const isDefaultKeyOrder = (order: readonly string[]) =>
  order.length === PHONE_KEY_IDS.length && order.every((id, i) => id === PHONE_KEY_IDS[i])

// The text to store, or null for the default order (nothing stored).
export function writeKeyOrder(order: readonly string[]): string | null {
  const merged = mergeKeyOrder(order)
  return isDefaultKeyOrder(merged) ? null : JSON.stringify(merged)
}

// `id` moved to index `to` (clamped) of the resulting order.
export function moveKey(order: readonly PhoneKeyId[], id: PhoneKeyId, to: number): PhoneKeyId[] {
  if (!order.includes(id)) return [...order]
  const next = order.filter(x => x !== id)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id)
  return next
}
