import { describe, expect, it } from 'vitest'
import type { Pane } from '../shared/types'
import type { Member } from '../shared/boardLinks'
import type { TaskGroup } from '../shared/projectsTasks'
import { memberGroup, summaryParts, taskSummary } from '../app/utils/projectSummary'

const pane = (id: string, p: Partial<Pane> = {}): Pane => ({ id, workspace: id.split(':')[0]!, tab: `${id}:t`, tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null, ...p })
const member = (p: Pane): Member => ({ row: { kind: 'pane', key: p.id, pane: p, lead: p }, task: null, role: 'worker' })
const onBoard = (p: Pane, group: TaskGroup): Member => ({
  ...member(p),
  task: { id: `t-${p.id}`, repo: 'demo', n: 1, key: 'DEMO-1', title: 'Demo', panes: [], workspace: null, stage: '', group, progress: null, msg: '', since: null },
})
const en = (e: string) => e
const fr = (_: string, f: string) => f

describe('the summary of a repo group', () => {
  it('counts the tasks, those waiting for you, working and at a provider quota', () => {
    const s = taskSummary([
      member(pane('a:1', { status: 'blocked' })),
      member(pane('b:1', { status: 'working' })),
      member(pane('c:1', { status: 'idle', usageLimit: {} as Pane['usageLimit'] })),
      member(pane('d:1', { status: 'done' })),
    ])
    expect(s).toEqual({ tasks: 4, blocked: 1, working: 1, limit: 1 })
    expect(summaryParts(s, en).map(p => p.text)).toEqual(['4 tasks', '1 your turn', '1 working', '1 quota'])
    expect(summaryParts(s, fr).map(p => p.text)).toEqual(['4 tâches', '1 à toi', '1 en cours', '1 quota'])
  })

  it('counts a task once across worker and reviewer spaces, using its Board group', () => {
    const worker = onBoard(pane('w1:p1', { status: 'working' }), 'working')
    const reviewer = { ...onBoard(pane('w2:p1', { status: 'working' }), 'working'), task: worker.task }
    expect(taskSummary([worker, reviewer, onBoard(pane('w3:p1', { status: 'working' }), 'done'), onBoard(pane('w4:p1', { status: 'working' }), 'todo'), onBoard(pane('w5:p1', { status: 'working' }), 'ready')])).toEqual({ tasks: 4, blocked: 1, working: 1, limit: 0 })
  })

  it('leaves out the counts at zero, says when there is no task, and the singular', () => {
    expect(summaryParts(taskSummary([]), en).map(p => p.text)).toEqual(['No tasks'])
    expect(summaryParts(taskSummary([]), fr).map(p => p.text)).toEqual(['Aucune tâche'])
    expect(summaryParts(taskSummary([member(pane('a:1'))]), fr).map(p => p.text)).toEqual(['1 tâche'])
    expect(summaryParts({ tasks: 3, blocked: 0, working: 0, limit: 2 }, en).map(p => p.key)).toEqual(['tasks', 'limit'])
    expect(summaryParts({ tasks: 3, blocked: 0, working: 0, limit: 2 }, fr)[1]!.text).toBe('2 quotas')
  })

  it('counts the tasks of the Board as their rows say them', () => {
    const ms = [
      onBoard(pane('a:1', { status: 'idle' }), 'needs'),
      onBoard(pane('b:1', { status: 'blocked' }), 'working'),
      onBoard(pane('c:1', { status: 'working' }), 'working'),
      onBoard(pane('d:1', { status: 'blocked' }), 'ready'),
      onBoard(pane('e:1', { status: 'working' }), 'todo'),
    ]
    expect(ms.map(memberGroup)).toEqual(['needs', 'working', 'working', 'ready', 'todo'])
    expect(taskSummary(ms)).toEqual({ tasks: 5, blocked: 2, working: 2, limit: 0 })
    expect(memberGroup(member(pane('f:1')))).toBeNull()
  })
})
