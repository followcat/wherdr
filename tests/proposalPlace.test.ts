import { expect, it } from 'vitest'
import { proposalSpot, type PlacedBlock } from '../app/utils/proposalPlace'

const opens = (b: PlacedBlock) => b.k === 'user' || b.k === 'wake'
// The user asks for a change; the coordinator answers, runs `template edit` at
// 25, says it proposed it; later the user asks something else and gets a list of ideas.
const chat: PlacedBlock[] = [
  { k: 'user', key: 'u1', ms: 10 },
  { k: 'assistant', key: 'a1', ms: 20 },
  { k: 'tools', key: 't1' },
  { k: 'assistant', key: 'a2', ms: 30 },
  { k: 'user', key: 'u2', ms: 40 },
  { k: 'assistant', key: 'ideas', ms: 50 },
]

it('goes under the last reply of the turn that proposed it, never a later turn', () => {
  expect(proposalSpot(chat, 25, opens)).toBe('a2')
  // Its turn's text all came before the command: still that turn.
  expect(proposalSpot(chat.filter(b => b.key !== 'a2'), 25, opens)).toBe('a1')
  // A turn with no reply: the conversation's end while it is the last, else nowhere.
  expect(proposalSpot(chat.slice(0, 3).filter(b => b.k !== 'assistant'), 25, opens)).toBe('')
  expect(proposalSpot([{ k: 'user', key: 'u1', ms: 10 }, { k: 'tools', key: 't1' }, ...chat.slice(4)], 25, opens)).toBeNull()
  // A later "!" or "/" command does not move it, even when its turn's replies all came before.
  const early = chat.slice(0, 3)
  expect(proposalSpot([...early, { k: 'shell', key: 's1', ms: 40 }, { k: 'assistant', key: 'later', ms: 50 }], 25, b => opens(b) || b.k === 'shell')).toBe('a1')
  expect(proposalSpot([...early, { k: 'system', key: 'cmd', ms: 40 }], 25, b => opens(b) || b.k === 'system')).toBe('a1')
  // A thought's duration is not a time.
  expect(proposalSpot([...chat.slice(0, 4), { k: 'thinking', key: 'th', ms: 5 }, { k: 'user', key: 'u2' }], 25, opens, b => (b.k === 'thinking' ? undefined : b.ms))).toBe('a2')
  // Its turn not loaded yet.
  expect(proposalSpot(chat.slice(4), 25, opens)).toBeNull()
})
