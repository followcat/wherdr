// The machine bar at the top of the home list: "All", then each machine, a tap
// shows that machine only. Settings › Appearance › Machine bar orders its items
// and takes some off it; a machine taken off the bar still shows under "All".
// Items are base machine keys (local is ''), reserved group IDs, and BAR_ALL.

// "All machines": a value no machine key can have.
export const BAR_ALL = '*'

// Every item the bar can show, in the saved order: the saved ones still known,
// then the others. "All" missing from the saved order goes first, a machine it
// does not know (new) goes last, in the home list's order.
export function barItems(order: readonly string[], machines: readonly string[]): string[] {
  const known = new Set([BAR_ALL, ...machines])
  const kept = order.filter((id, i) => known.has(id) && order.indexOf(id) === i)
  const missing = [BAR_ALL, ...machines].filter(id => !kept.includes(id))
  return missing.includes(BAR_ALL)
    ? [BAR_ALL, ...kept, ...missing.filter(id => id !== BAR_ALL)]
    : [...kept, ...missing]
}

// The item chosen now: the saved one while the bar shows it, else "All" when
// the bar shows it, else its first item. null: nothing to choose (an empty bar).
export function barPick(saved: string | null | undefined, shown: readonly string[]): string | null {
  if (saved != null && shown.includes(saved)) return saved
  return shown.includes(BAR_ALL) ? BAR_ALL : shown[0] ?? null
}

// `id` moved to position `to` of `items` (indexes of the list before the move).
export function moveBarItem(items: readonly string[], id: string, to: number): string[] {
  const from = items.indexOf(id)
  if (from < 0) return [...items]
  const next = items.filter(x => x !== id)
  next.splice(Math.max(0, Math.min(to > from ? to - 1 : to, next.length)), 0, id)
  return next
}

// The hidden items once `id` is shown (or hidden).
export function setBarItemShown(hidden: readonly string[], id: string, shown: boolean): string[] {
  const rest = hidden.filter(x => x !== id)
  return shown ? rest : [...rest, id]
}

// A saved list (JSON): strings only, no duplicates.
export function readBarList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((x, i): x is string => typeof x === 'string' && v.indexOf(x) === i) : []
  }
  catch { return [] }
}

// The saved choice (JSON, the local machine being ''): null when there is none.
export function readBarPick(raw: string | null | undefined): string | null {
  try {
    const v = JSON.parse(raw ?? 'null')
    return typeof v === 'string' ? v : null
  }
  catch { return null }
}

// Group IDs use the same reserved namespace as All, never a machine key.
export interface MachineGroup { id: string, name: string, machines: string[] }
export function readMachineGroups(raw: string | null): MachineGroup[] {
  try {
    const value = JSON.parse(raw || '[]')
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    return value.filter((g): g is MachineGroup => {
      if (!g || typeof g.id !== 'string' || !g.id.startsWith('*group:') || seen.has(g.id)
        || typeof g.name !== 'string' || !g.name.trim() || !Array.isArray(g.machines)) return false
      seen.add(g.id)
      return true
    }).map(g => ({ id: g.id, name: g.name.trim(), machines: [...new Set(g.machines.filter((m): m is string => typeof m === 'string' && !m.startsWith('*')))] }))
  }
  catch { return [] }
}

// New groups go after All, before machines, while explicit positions survive.
export function groupedBarItems(order: readonly string[], machines: readonly string[], groups: readonly MachineGroup[]): string[] {
  const defaults = [BAR_ALL, ...groups.map(g => g.id), ...machines]
  const result = barItems(order, defaults.slice(1))
  const added = groups.map(g => g.id).filter(id => !order.includes(id))
  const placed = result.filter(id => !added.includes(id))
  placed.splice(placed.indexOf(BAR_ALL) + 1, 0, ...added)
  return placed
}

export function barMachineSelection(pick: string | null, groups: readonly MachineGroup[]): string[] | null {
  if (pick === null || pick === BAR_ALL) return null
  return groups.find(g => g.id === pick)?.machines ?? [pick]
}

// The machine "New" preselects: the tab's first online machine, else the host
// (''). `only` is the tab's machines in order, null for the all-machines view.
export const tabMachine = (only: readonly string[] | null, online: (key: string) => boolean) => only?.find(online) ?? ''
