import { describe, expect, it } from 'vitest'
import { foldableReply } from '../app/utils/wakeReply'

describe('foldableReply', () => {
  it('folds a routine one-liner', () => {
    expect(foldableReply('Nothing new, the board is moving.')).toBe(true)
    expect(foldableReply('**WHR-12 merged.**')).toBe(true)
  })

  it('never folds a reply that asks or reports more', () => {
    expect(foldableReply('Study done.\n\n```wherdr\nchoices "Go" | "Wait"\n```')).toBe(false)
    expect(foldableReply('Ready.\n```wherdr\nui action "Open" #/board?task=WHR-3\n```')).toBe(false)
    expect(foldableReply('```wherdr\ntask WHR-12\n```')).toBe(false)
    expect(foldableReply('WHR-12 merged.\nThe board is clear.')).toBe(false)
    expect(foldableReply('See the draft: https://example.com/pr/1')).toBe(false)
    expect(foldableReply('Shall I retry it?')).toBe(false)
    expect(foldableReply('x'.repeat(200))).toBe(false)
  })
})
