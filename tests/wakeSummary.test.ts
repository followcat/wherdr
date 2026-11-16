import { describe, expect, it } from 'vitest'
import { firstSentence, quietStreaks, runSum, wakeSum } from '../app/utils/wakeSummary'

const ACK = 'When you have handled this, run: wherdr pm ack a1'
const SCHEDULED = `Autopilot: scheduled wake a1\n\nScheduled wake (every 1h). Your goal: Keep tasks running.\n\n${ACK}`
const event = (id: string, ev: string) => `Autopilot: wake a1\n\n${id} (Fix the (old) header: v2): ${ev}\n\n${ACK}`

describe('wakeSum', () => {
  it('reads the kind from the first line and the task lines, never the reply', () => {
    expect(wakeSum(event('WHR-352', 'done'))).toMatchObject({ tone: 'done', tasks: ['WHR-352'], label: 'merged', quiet: false })
    expect(wakeSum(event('ACME-API-12', 'done')).tasks).toEqual(['ACME-API-12'])
    expect(wakeSum(event('WHR-9', 'stuck: the agent waits'))).toMatchObject({ tone: 'stuck', tasks: ['WHR-9'], label: 'stuck' })
    expect(wakeSum(event('WHR-4', 'decide: 3 send-backs'))).toMatchObject({ tone: 'ready', label: 'ready for you' })
    expect(wakeSum(SCHEDULED)).toMatchObject({ tone: 'scheduled', tasks: [], label: 'Scheduled', quiet: true })
    expect(wakeSum(`Health check: wake h1\n\nAll tasks moving.\n\n${ACK}`)).toMatchObject({ tone: 'health', label: 'Health check', quiet: true })
    expect(wakeSum(`Step check: WHR-3 (deploy), wake s1\n\nThe deploy runs.\n\n${ACK}`)).toMatchObject({ tone: 'step', tasks: ['WHR-3'], label: 'Step check', quiet: false })
    expect(wakeSum(`Autopilot: wake n1\n\nThe user asked you to run now.\n\n${ACK}`)).toMatchObject({ tone: 'run', label: 'Run now' })
    // Several tasks: the most pressing one leads.
    expect(wakeSum(`Autopilot: wake a1\n\nWHR-1 (a): done\n\nWHR-2 (b): question: which db?\n\n${ACK}`)).toMatchObject({ tone: 'question', tasks: ['WHR-1', 'WHR-2'] })
  })
})

describe('runSum', () => {
  it('counts a mixed run by kind, with its task chips, and stands out when one waits for the user', () => {
    const sums = [event('WHR-352', 'done'), SCHEDULED, event('WHR-354', 'done'), event('WHR-360', 'ready'), event('WHR-355', 'done')].map(wakeSum)
    const r = runSum(sums)
    expect(r.n).toBe(5)
    expect(r.forUser).toBe(true)
    expect(r.parts.map(p => p.text)).toEqual(['1 waits for you', '3 merged', '1 quiet'])
    expect(r.parts[1]!.chips).toEqual([{ id: 'WHR-352', text: 'WHR-352' }, { id: 'WHR-354', text: '354' }, { id: 'WHR-355', text: '355' }])
    // A tick batching several events counts each task under its own kind.
    const batch = wakeSum(`Autopilot: wake a1\n\nWHR-1 (a): done\n\nWHR-2 (b): done\n\nWHR-3 (c): ready\n\n${ACK}`)
    expect(runSum([batch, wakeSum(SCHEDULED)]).parts.map(p => [p.text, p.chips.map(c => c.id)])).toEqual([['1 waits for you', ['WHR-3']], ['2 merged', ['WHR-1', 'WHR-2']], ['1 quiet', []]])
    expect(runSum([SCHEDULED, SCHEDULED].map(wakeSum))).toMatchObject({ forUser: false, parts: [{ text: '2 quiet', chips: [] }] })
  })
})

describe('quietStreaks', () => {
  it('groups two or more consecutive quiet wakes', () => {
    const q = wakeSum(SCHEDULED), d = wakeSum(event('WHR-1', 'done'))
    expect(quietStreaks([q, q, d, q, d, q, q, q])).toEqual([[0, 1], [5, 7]])
  })
})

it('firstSentence keeps the reply\'s first sentence', () => {
  expect(firstSentence('**Nothing new**, the board is empty. Two questions wait.')).toBe('Nothing new, the board is empty.')
  expect(firstSentence('v2.1 merged')).toBe('v2.1 merged')
})
