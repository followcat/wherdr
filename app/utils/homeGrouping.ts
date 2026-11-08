interface MachineLike { key: string, baseKey?: string, status: 'online' | 'connecting' | 'offline' }

// Machines of State mode, filtered by the machine bar (its keys are base keys,
// so a named session follows its machine) and in the bar's selected order.
// Online machines feed the merged groups and the machine row at the top;
// offline or reconnecting ones only get the compact line at the bottom.
export function stateMachines<M extends MachineLike>(list: readonly M[], selected: readonly string[] | null) {
  const base = (m: M) => m.baseKey ?? m.key
  const shown = list.filter(m => selected === null || selected.includes(base(m)))
  if (selected) shown.sort((a, b) => selected.indexOf(base(a)) - selected.indexOf(base(b)))
  return { online: shown.filter(m => m.status === 'online'), away: shown.filter(m => m.status !== 'online') }
}
