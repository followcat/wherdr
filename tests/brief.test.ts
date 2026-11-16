// WHR-387: Alfred's brief, the facts of a made-up board: merged since the last
// brief, waiting for the user and for what, stuck; quotas near their limit.
import { describe, expect, it } from 'vitest'
import { projectFacts, quotaNear } from '../shared/pm/brief'
import type { Task } from '../shared/pm/run'

const now = Date.parse('2026-11-15T09:00:00Z'), hour = 3_600_000
const task = (id: string, more: Partial<Task>): Task => ({ id, project: 'WEB', title: `Task ${id}`, description: '', type: 'feature', state: 'working', ...more })

describe('projectFacts', () => {
  it('lists merged, waiting (with what) and stuck tasks since a time', () => {
    const tasks = [
      task('WEB-1', { step: { at: 3, done: true } as never, marks: [{ at: now - 2 * hour, step: 3, done: true }] }),
      task('WEB-2', { step: { at: 3, done: true } as never, marks: [{ at: now - 30 * hour, step: 3, done: true }] }), // before the last brief
      task('WEB-3', { step: { at: 3, done: true, abandoned: true } as never, marks: [{ at: now - hour, step: 3, done: true }] }),
      task('WEB-4', { step: { at: 2, yourTurn: { reason: 'action', badge: 'Merge' } } as never }),
      task('WEB-5', { state: 'waiting', waitKind: 'question', waiting: 'Which colour?\nmore' }),
      task('WEB-6', { stopped: { by: 'user', why: 'CI broken', at: now } }),
      task('WEB-7', { stall: { cause: 'idle', reason: 'No report for 2 h', since: now - 2 * hour } }),
      task('WEB-8', { stall: { cause: 'idle', reason: 'just now', since: now - 60_000 } }),
      task('WEB-9', { state: 'todo' }),
    ]
    expect(projectFacts(tasks, now - 24 * hour, now)).toEqual({
      merged: [{ id: 'WEB-1', title: 'Task WEB-1' }],
      waiting: [{ id: 'WEB-4', title: 'Task WEB-4', what: 'Merge' }, { id: 'WEB-5', title: 'Task WEB-5', what: 'question: Which colour?' }, { id: 'WEB-6', title: 'Task WEB-6', what: 'block: CI broken' }],
      stuck: [{ id: 'WEB-7', title: 'Task WEB-7', why: 'No report for 2 h', hours: 2 }],
    })
  })
})

describe('quotaNear', () => {
  it('names the windows at 80 % or more, or a limit hit; a window past its reset is empty', () => {
    const w = (used: number, resetsAt: number | null) => ({ used, resetsAt, minutes: 300 })
    expect(quotaNear({ five: w(85, now + hour), week: w(40, now + 48 * hour), at: now }, now)).toEqual(['5h 85% used'])
    expect(quotaNear({ five: w(95, now - hour), week: w(90, null), at: now }, now)).toEqual(['week 90% used'])
    expect(quotaNear({ five: null, week: null, at: now, limited: { resetsAt: now + hour } }, now)).toEqual(['limited'])
    expect(quotaNear(null, now)).toEqual([])
  })
})
