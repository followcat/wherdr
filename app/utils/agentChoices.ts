// Hidden agents are remembered rather than an allow list: a newly
// installed agent stays checked by default on each device.
export function readHiddenAgents(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    return Array.isArray(value) ? [...new Set(value.filter((kind): kind is string => typeof kind === 'string' && kind !== 'shell'))] : []
  } catch { return [] }
}

export function visibleAgentKinds(installed: readonly string[], hidden: readonly string[]): string[] {
  const excluded = new Set(hidden)
  return [...new Set(installed.filter(kind => kind !== 'shell' && !excluded.has(kind))), 'shell']
}

export function selectedAgentKind(current: string, available: readonly string[], last = ''): string {
  if (available.includes(current)) return current
  if (!current && available.includes(last)) return last
  return available[0] || 'shell'
}
