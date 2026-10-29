import { describe, expect, it } from 'vitest'
import { createTranscriptCache } from '../app/utils/transcriptCache'

// A transcript of distinct rows; screen(base) is the viewport window into it.
const screen = (base: number, rows = 10) => Array.from({ length: rows }, (_, i) => `row ${base + i}`)

describe('transcriptCache', () => {
  it('realigns the window across scroll repaints and reports cached edges', () => {
    const c = createTranscriptCache()
    c.frame(screen(40))
    // Scroll up 5: rows 45-49 leave the bottom, 35-39 enter the top.
    c.frame(screen(35))
    expect(c.available(-1)).toBe(5) // the rows that just scrolled off
    expect(c.available(1)).toBe(0)  // never-seen history stays unreachable
    expect(c.slice(-1, 3).map(r => r?.text)).toEqual(['row 45', 'row 46', 'row 47'])
    // Back down 3: rows 38-40 return to the top edge.
    c.frame(screen(38))
    expect(c.available(1)).toBe(3)
    expect(c.slice(1, 3).map(r => r?.text)).toEqual(['row 35', 'row 36', 'row 37'])
  })

  it('does not drift on an unrelated full repaint', () => {
    const c = createTranscriptCache()
    c.frame(screen(40))
    c.frame(Array.from({ length: 10 }, (_, i) => `other ${i}`))
    expect(c.available(1)).toBe(0)
    expect(c.slice(-1, 2)).toEqual([null, null])
  })

  it('tracks repeated blank rows without inventing a shift', () => {
    const c = createTranscriptCache()
    const blank = Array.from({ length: 10 }, () => '')
    c.frame(blank)
    c.frame(screen(5)) // unrelated: no stored row matches
    expect(c.available(-1)).toBe(0)
  })

  it('grows the upward lead as history gets painted', () => {
    const c = createTranscriptCache()
    c.frame(screen(40))
    c.frame(screen(35))
    c.frame(screen(30))
    c.frame(screen(25))
    // Scroll back down through the seen region: below-edge rows are known.
    c.frame(screen(30))
    expect(c.available(-1)).toBe(10)
    // And revisiting upward still has the region cached.
    expect(c.available(1)).toBe(5)
    expect(c.slice(1, 4).map(r => r?.text)).toEqual(['row 26', 'row 27', 'row 28', 'row 29'])
  })

  it('treats a jump with no overlapping rows as an in-place repaint', () => {
    const c = createTranscriptCache()
    c.frame(screen(40))
    c.frame(screen(20)) // one full viewport away: nothing to match against
    expect(c.available(1)).toBe(0)
    expect(c.available(-1)).toBe(0)
  })

  it('reset clears everything', () => {
    const c = createTranscriptCache()
    c.frame(screen(40))
    c.frame(screen(35))
    c.reset()
    expect(c.available(-1)).toBe(0)
    expect(c.slice(-1, 2)).toEqual([null, null])
  })
})
