// Settings › Agents › Offered agents is the one list every agent picker uses:
// the installed programs in the user's order, minus those they unchecked.
// Hidden agents are remembered rather than an allow list: a newly installed
// agent stays checked by default on each device, and comes after the ordered ones.
export function readHiddenAgents(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    return Array.isArray(value) ? [...new Set(value.filter((kind): kind is string => typeof kind === 'string' && kind !== 'shell'))] : []
  } catch { return [] }
}
// The order is read like the hidden list: a JSON list of program names.
export const readAgentOrder = readHiddenAgents

// The installed programs (Terminal aside), those the user ordered first.
export function orderAgents(installed: readonly string[], order: readonly string[]): string[] {
  const list = [...new Set(installed.filter(kind => kind !== 'shell'))]
  const rank = (kind: string) => (order.includes(kind) ? order.indexOf(kind) : order.length + list.indexOf(kind))
  return list.sort((a, b) => rank(a) - rank(b))
}

// The programs offered: ordered, unchecked ones left out. The first is the default.
export function offeredAgents(installed: readonly string[], hidden: readonly string[], order: readonly string[] = []): string[] {
  return orderAgents(installed, order).filter(kind => !hidden.includes(kind))
}

// The New sheet's types: the offered programs, then Terminal (always there).
export function visibleAgentKinds(installed: readonly string[], hidden: readonly string[], order: readonly string[] = []): string[] {
  return [...offeredAgents(installed, hidden, order), 'shell']
}

// The current choice while it is still offered, else the first (the default).
export function selectedAgentKind(current: string, available: readonly string[]): string {
  return available.includes(current) ? current : available[0] || 'shell'
}

// The order after moving list[from] to `to` (list: what Settings shows). The
// programs of machines offline now keep their place after it.
export function moveAgent(list: readonly string[], order: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...order]
  const next = [...list]
  next.splice(to, 0, next.splice(from, 1)[0]!)
  return [...next, ...order.filter(kind => !next.includes(kind))]
}
