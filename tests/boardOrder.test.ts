import { describe, expect, it } from 'vitest'
import { boardOrder, orderTasks } from '../shared/pm/boardOrder'
import { busyQueue } from '../shared/pm/autopilot'
import { parseCommand } from '../shared/pm/coordinator'
import type { Task } from '../shared/pm/run'

const task = (n: number, more: Partial<Task> = {}): Task => ({ id: `CO-${n}`, project: 'CO', title: '', description: '', type: 'feature', state: 'todo', createdAt: n, ...more })
const ids = (ts: Task[]) => ts.map(t => t.id)
const apply = (ts: Task[], order: Record<string, number>) => ts.map(t => (t.id in order ? { ...t, order: order[t.id] } : t))

describe('board order', () => {
  it('puts the named tasks first, in that order; the others keep their order after them', () => {
    let ts = [1, 2, 3, 4, 5].map(n => task(n))
    expect(ids(boardOrder(ts))).toEqual(['CO-1', 'CO-2', 'CO-3', 'CO-4', 'CO-5'])
    const r1 = orderTasks(ts, ['CO-4', 'CO-2'])
    ts = apply(ts, 'order' in r1 ? r1.order : {})
    expect(ids(boardOrder(ts))).toEqual(['CO-4', 'CO-2', 'CO-1', 'CO-3', 'CO-5'])
    // A second order goes before the first, which keeps its own order.
    const r2 = orderTasks(ts, ['CO-5'])
    ts = apply(ts, 'order' in r2 ? r2.order : {})
    expect(ids(boardOrder(ts))).toEqual(['CO-5', 'CO-4', 'CO-2', 'CO-1', 'CO-3'])
    // Keep the board busy starts to-do tasks in board order.
    expect(ids(busyQueue(ts))).toEqual(['CO-5', 'CO-4', 'CO-2', 'CO-1', 'CO-3'])
  })

  it('refuses an unknown or done task, and a task named twice', () => {
    const ts = [task(1), task(2, { step: { at: 2, started: true, done: true, proofs: {}, rounds: {} } })]
    expect(orderTasks(ts, ['CO-9'])).toEqual({ refused: 'Unknown task: CO-9 (tasks of one project, on its board)' })
    expect(orderTasks(ts, ['CO-2'])).toEqual({ refused: 'CO-2 is done: only tasks still on the board are ordered' })
    expect(orderTasks(ts, ['CO-1', 'CO-1'])).toEqual({ refused: 'Name each task once' })
  })

  it('parses task order', () => {
    expect(parseCommand(['task', 'order', 'CO-3', 'CO-1'])).toEqual({ name: 'task order', task: 'CO-3', tasks: ['CO-3', 'CO-1'] })
    expect(parseCommand(['task', 'order'])).toHaveProperty('error')
    expect(parseCommand(['task', 'order', 'nope'])).toHaveProperty('error')
  })
})
