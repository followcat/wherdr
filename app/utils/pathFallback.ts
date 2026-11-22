// A bare file name in a reply (`report.md`) written after a folder in the same
// message (`~/project/tasks/ABC-24/`): where else to look for it, the nearest
// folder before it first. chips: the message's inline paths, in order.
export function folderGuesses(chips: string[], i: number): string[] {
  const name = chips[i]
  if (!name || name.includes('/')) return []
  return chips.slice(0, i).filter(c => c.endsWith('/')).reverse().map(dir => dir + name)
}
