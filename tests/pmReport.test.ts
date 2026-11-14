import { describe, expect, it } from 'vitest'
import { reportMessage, reviewLine } from '../shared/pm/report'
import { parseCommand } from '../shared/pm/coordinator'

describe('reportMessage', () => {
  const base = { id: 'WHR-7', title: 'Dark mode', step: 'merge', text: 'The toggle is missing\non the phone', shots: ['~/data/shots/WHR-7/a.png'], pr: 'https://github.com/o/r/pull/7', verdict: 'Review passed, 1 send-back', block: true }

  it('gives the coordinator the whole context and what to do with it', () => {
    const m = reportMessage(base)
    expect(m.split('\n')[0]).toBe('The user reports a problem on task WHR-7 (Dark mode), at step merge:')
    for (const part of ['> The toggle is missing', '> on the phone', '- ~/data/shots/WHR-7/a.png', 'PR: https://github.com/o/r/pull/7', 'Review: Review passed, 1 send-back', 'The merge is blocked', 'wherdr pm report back WHR-7', 'wherdr pm report close WHR-7', 'Never ask the user to relay'])
      expect(m).toContain(part)
  })

  it('says what is missing rather than leaving it out', () => {
    const m = reportMessage({ ...base, shots: [], pr: undefined, verdict: undefined, block: false })
    expect(m).not.toContain('Screenshots concerned')
    expect(m).toContain('PR: none')
    expect(m).toContain('Review: none')
    expect(m).toContain('The merge is not blocked.')
  })
})

it('reviewLine reads the last review before the current step', () => {
  const plan = [{ id: 'work' }, { id: 'review', ends: 'verdict' }, { id: 'merge' }]
  expect(reviewLine(plan, 2, { review: 2 })).toBe('Review passed, 2 send-backs')
  expect(reviewLine(plan, 2, {})).toBe('Review passed')
  expect(reviewLine(plan, 1, {})).toBeUndefined()
})

it('parses the coordinator\'s report commands', () => {
  expect(parseCommand(['report', 'back', 'WHR-7', 'Add', 'the toggle'])).toEqual({ name: 'report back', task: 'WHR-7', text: 'Add the toggle' })
  expect(parseCommand(['report', 'close', 'WHR-7', 'Told the agent'])).toEqual({ name: 'report close', task: 'WHR-7', text: 'Told the agent' })
  expect(parseCommand(['report', 'close', 'WHR-7'])).toHaveProperty('error')
})
