import { describe, expect, it } from 'vitest'
import { reviewCap, reviewTurn, reviewerOut, runningReviews } from '../shared/pm/reviewQueue'
import { reviewText } from '../shared/pm/verdict'
import { DEFAULT_PACE } from '../shared/pm/pacing'
import type { Quotas } from '../shared/types'
import type { Run, Task } from '../shared/pm/run'

const now = 1_000_000_000
const codex = (used: number): Quotas => ({ claude: null, codex: { at: now, five: { used, resetsAt: now + 3_600_000, minutes: 300 }, week: null } } as Quotas)
// A task whose review step is due since `since` (not told yet), or told (its reviewer at work).
const task = (id: string, since: number, more: Partial<Task> = {}) =>
  ({ id, state: 'working', step: { at: 1, started: true, since, told: more.run ? since : 0, proofs: {}, rounds: {} }, ...more }) as Task
const reviewer = (id: string, t: string): Run => ({ id, task: t, role: 'reviewer', program: 'codex', model: 'm', machine: '', state: 'running' } as Run)

describe('the review queue of one account', () => {
  it('runs up to its cap, the others wait oldest first', () => {
    const tasks = [task('A-1', 1, { run: 'r1' }), task('A-2', 2, { run: 'r2' }), task('A-3', 5, { reviewWait: 'codex' }), task('A-4', 3, { reviewWait: 'codex' }), task('A-5', 9)]
    // An idle reviewer (its task on another step) does not count.
    const runs = [reviewer('r1', 'A-1'), reviewer('r2', 'A-2'), reviewer('r9', 'A-3')]
    const running = runningReviews(tasks, runs, r => r.program).get('codex')!
    expect(running).toBe(2)
    expect(reviewCap(codex(80).codex, now)).toBe(2)
    expect(reviewCap(codex(10).codex, now)).toBe(3)
    expect(reviewTurn(tasks[3]!, 'codex', tasks, running, 2)).toEqual({ ahead: 2 })
    expect(reviewTurn(tasks[2]!, 'codex', tasks, running, 2)).toEqual({ ahead: 3 })
    expect(reviewTurn(tasks[4]!, 'codex', tasks, running, 2)).toEqual({ ahead: 4 })
    // One running review ends: the oldest waiting one goes, the next still waits.
    expect(reviewTurn(tasks[3]!, 'codex', tasks, 1, 2)).toEqual({ go: true })
    expect(reviewTurn(tasks[2]!, 'codex', tasks, 1, 2)).toEqual({ ahead: 2 })
  })
})

describe('the reviewer account near its limit', () => {
  it('hands a new review to the fallback from 90 % of the 5-hour window, or when its pace holds it', () => {
    expect(reviewerOut(codex(89), 'codex', '', () => DEFAULT_PACE, now)).toBeUndefined()
    expect(reviewerOut(codex(92), 'codex', '', () => DEFAULT_PACE, now)).toBe('Codex 5h at 92 %')
    const paced = { ...DEFAULT_PACE, mode: 'everyday' as const, reserve5h: 30 }
    expect(reviewerOut(codex(75), 'codex', '', () => paced, now)).toMatch(/^Codex paced: the 5-hour reserve is reached/)
  })
})

describe('a re-review after a send-back', () => {
  it('reviews only what came after the commit of the last round, with its findings', () => {
    const text = reviewText('Review it.', { head: 'abcdef1234', findings: [{ id: 'no-test', severity: 'major', title: 'No test', proof: 'p' }] })
    expect(text).toContain('`git log --oneline abcdef1234..HEAD`')
    expect(text).toContain('no-test [major] No test')
    expect(text).toContain('What the base branch brought is not reviewed again.')
  })
})
