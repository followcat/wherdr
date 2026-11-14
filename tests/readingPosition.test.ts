import { describe, expect, it } from 'vitest'
import { restoredScrollTop, saveReadingPosition } from '../app/utils/readingPosition'

const box = (scrollTop: number, scrollHeight = 5000, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight })

describe('position de lecture', () => {
  it('reopens the conversation at the same place, measured from the bottom', () => {
    saveReadingPosition('p1', 'a.jsonl', box(3000))
    expect(restoredScrollTop('p1', 'a.jsonl', 5000)).toBe(3000)
    // Older slices not reloaded yet: the same end stays on screen.
    saveReadingPosition('p1', 'a.jsonl', box(7000, 9000))
    expect(restoredScrollTop('p1', 'a.jsonl', 5000)).toBe(3000)
    // Position in a missing slice: at the top (the rest reloads when scrolling up).
    saveReadingPosition('p1', 'a.jsonl', box(1000, 9000))
    expect(restoredScrollTop('p1', 'a.jsonl', 5000)).toBe(0)
  })
  it('stays at the bottom when we were there', () => {
    saveReadingPosition('p2', 'a.jsonl', box(4150))
    expect(restoredScrollTop('p2', 'a.jsonl', 5000)).toBeNull()
  })
  it('ignores another session of the agent (/clear) and an unknown pane', () => {
    saveReadingPosition('p3', 'a.jsonl', box(1000))
    expect(restoredScrollTop('p3', 'b.jsonl', 5000)).toBeNull()
    expect(restoredScrollTop('inconnu', 'a.jsonl', 5000)).toBeNull()
  })
  it('matches a copy kept before the transcript was recorded on the pane alone', () => {
    saveReadingPosition('p4', 'a.jsonl', box(1000))
    // file undefined: the copy kept on this device does not say which
    // transcript it is — the pane is enough.
    expect(restoredScrollTop('p4', undefined, 5000)).toBe(1000)
    expect(restoredScrollTop('p4', 'b.jsonl', 5000)).toBeNull()
  })
})
