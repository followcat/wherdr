// Where a coordinator's workflow change card goes in its conversation: under
// the last reply of the turn that proposed it (the turn that ran `template
// edit`), never a later one. A turn starts at a message from the user or a
// wake (`opens`) and runs to the next one. `at`: when it was proposed.
// Returns that reply's key; '' for the conversation's end (its turn has no
// reply yet and is the last); null when its turn is not in view.
export interface PlacedBlock { k: string, key: string, ms?: number }

// timeOf: when a block was written, if known; one without takes the last time before it.
export function proposalSpot(blocks: PlacedBlock[], at: number, opens: (b: PlacedBlock) => boolean, timeOf = (b: PlacedBlock) => b.ms): string | null {
  let last = 0
  const times = blocks.map(b => (last = timeOf(b) ?? last))
  const start = blocks.findLastIndex((b, i) => opens(b) && times[i]! <= at)
  // Its turn is older than the first one loaded.
  if (start < 0 && blocks.some(opens)) return null
  const next = blocks.findIndex((b, i) => i > start && opens(b))
  const end = next < 0 ? blocks.length : next
  const reply = blocks.slice(start + 1, end).findLast(b => b.k === 'assistant')
  if (reply) return reply.key
  return end === blocks.length ? '' : null
}
