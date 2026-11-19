// Where the card of a "!" command still running goes in its conversation: at
// its place in time, before the first block written after it started (a
// message the user sent meanwhile, the agent's reply), with the agent-name or
// day line that leads that block. Returns that block's key; null when nothing
// came after it (the card stays last, under the conversation).
export interface TimedBlock { k: string, key: string }

// timeOf: when a block was written, if known.
export function liveRunSpot<B extends TimedBlock>(blocks: readonly B[], since: number, timeOf: (b: B) => number | undefined): string | null {
  let i = blocks.findIndex((b) => {
    const t = timeOf(b)
    return t !== undefined && t > since
  })
  if (i < 0) return null
  while (i > 0 && (blocks[i - 1]!.k === 'who' || blocks[i - 1]!.k === 'day')) i--
  return blocks[i]!.key
}
