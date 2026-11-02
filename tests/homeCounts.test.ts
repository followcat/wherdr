import { describe, expect, it } from 'vitest'
import { countedPanes, type LinkedTask, type MachineLinks } from '../shared/boardLinks'
import { homeCounts, taskStat, withBoardGroups } from '../shared/homeCounts'
import { type MachineTasks, type TasksBoard, parseTaskRow } from '../shared/projectsTasks'

type P = { id: string, agent: string | null, status: string, workspace: string, machine?: string }
const pane = (id: string, status: string, agent: string | null = 'claude'): P => ({ id, agent, status, workspace: id.split(':')[0]! })
const task = (n: number, panes: LinkedTask['panes'], stage = 'working', group: LinkedTask['group'] = 'working'): LinkedTask => ({
  id: `app/${n}`, repo: 'app', n, key: `APP-${n}`, title: `Task ${n}`, panes, workspace: `w${n}`, stage, group, progress: null, msg: '', since: null,
})
const links = (tasks: LinkedTask[], machine = ''): MachineLinks => ({ machine, tasks, coordinators: [] })
// A row as `list --json` gives it.
const row = (n: number, state: string, stage: string, extra: Record<string, unknown> = {}) => parseTaskRow({ id: `app/${n}`, state, stage, title: `Task ${n}`, ...extra })!
const machine = (rows: ReturnType<typeof row>[], key = '', more: Partial<MachineTasks> = {}): MachineTasks => ({ machine: key, status: 'ready', version: '1.2.16', tasks: rows, ...more })
const cli = (...machines: MachineTasks[]): TasksBoard => ({ version: 'v', machines })

describe('home counters', () => {
  // WHR-181 ready to approve and WHR-178 stopped at its limit: both idle in
  // their terminal, both the user's turn.
  const readyToApprove = row(181, 'blocked', 'approval', { kind: 'permission' })
  const needsYou = row(178, 'blocked', 'stopped')
  const exited = row(9, 'error', 'working', { msg: 'The agent has exited' })
  const working = row(5, 'working', 'working')
  const done = row(4, 'done', 'done')

  it('reads the groups as the Board does', () => {
    expect([readyToApprove, needsYou, exited, working, done].map(r => r.group)).toEqual(['ready', 'needs', 'needs', 'working', 'done'])
    expect(['needs', 'ready', 'working', 'todo', 'done'].map(g => taskStat(g as never))).toEqual(['blocked', 'blocked', 'working', 'ready', 'ready'])
  })

  it('without herdr-projects (Herdr alone): each agent by its own state', () => {
    const panes = [pane('w1:p1', 'blocked'), pane('w2:p1', 'working'), pane('w3:p1', 'idle'), pane('w4:p1', 'done'), pane('w5:p1', 'unknown')]
    expect(homeCounts(panes, [], null)).toEqual({ blocked: 1, working: 1, ready: 2 })
    // A board that is not there says nothing either.
    expect(homeCounts(panes, [], cli({ machine: '', status: 'missing', version: '', tasks: [] }))).toEqual({ blocked: 1, working: 1, ready: 2 })
  })

  it('a board task counts by its state on the Board, not its terminal', () => {
    const l = [links([task(181, [{ id: 'w181:p1', role: 'worker' }], 'approval', 'ready'), task(178, [{ id: 'w178:p1', role: 'worker' }], 'stopped', 'needs'),
      task(9, [{ id: 'w9:p1', role: 'worker' }]), task(5, [{ id: 'w5:p1', role: 'worker' }]), task(4, [{ id: 'w4:p1', role: 'worker' }], 'done', 'done')])]
    const panes = [pane('w181:p1', 'idle'), pane('w178:p1', 'idle'), pane('w9:p1', 'working'), pane('w5:p1', 'working'), pane('w4:p1', 'idle'), pane('w99:p1', 'working')]
    // Without a CLI reply, the task files still provide their groups.
    expect(homeCounts(panes, l, null)).toEqual({ blocked: 2, working: 3, ready: 1 })
    expect(homeCounts(panes, l, cli(machine([readyToApprove, needsYou, exited, working, done])))).toEqual({ blocked: 3, working: 2, ready: 1 })
  })

  it('a task to do or done is ready, whatever its terminal says; a lone agent keeps its own state', () => {
    const l = [links([task(3, [{ id: 'w3:p1', role: 'worker' }], 'todo', 'todo'), task(4, [{ id: 'w4:p1', role: 'worker' }], 'done', 'done')])]
    const panes = [pane('w3:p1', 'working'), pane('w4:p1', 'blocked'), pane('w99:p1', 'blocked', 'codex')]
    expect(homeCounts(panes, l, null)).toEqual({ blocked: 1, working: 0, ready: 2 })
    expect(homeCounts(panes, l, cli(machine([row(3, 'idle', 'todo'), row(4, 'done', 'done')])))).toEqual({ blocked: 1, working: 0, ready: 2 })
  })

  it('a task with a reviewer (and attempts) counts once', () => {
    const l = [links([task(7, [{ id: 'w7:p1', role: 'worker' }, { id: 'w7:p2', role: 'reviewer', kind: 'codex' }, { id: 'w8:p1', role: 'attempt', letter: 'A' }])])]
    const panes = [pane('w7:p1', 'idle'), pane('w7:p2', 'working', 'codex'), pane('w8:p1', 'idle')]
    // Task files also keep helpers in separate spaces from counting twice.
    expect(homeCounts(panes, l, null)).toEqual({ blocked: 0, working: 1, ready: 0 })
    expect(homeCounts(panes, l, cli(machine([row(7, 'working', 'reviewing')])))).toEqual({ blocked: 0, working: 1, ready: 0 })
  })

  it('a working task counts as working whatever its panes say, in either order', () => {
    // The worker in one space, its reviewer (asking something) in another.
    const l = [links([task(7, [{ id: 'w7:p1', role: 'worker' }, { id: 'w8:p1', role: 'reviewer', kind: 'codex' }])])]
    const worker = pane('w7:p1', 'working')
    const reviewer = pane('w8:p1', 'blocked', 'codex')
    const board = cli(machine([row(7, 'working', 'reviewing')]))
    expect(homeCounts([worker, reviewer], l, board)).toEqual({ blocked: 0, working: 1, ready: 0 })
    expect(homeCounts([reviewer, worker], l, board)).toEqual({ blocked: 0, working: 1, ready: 0 })
    // One pane, asking: the Board's state still decides.
    expect(homeCounts([pane('w7:p1', 'blocked')], l, board)).toEqual({ blocked: 0, working: 1, ready: 0 })
    // Without a CLI reply, the linked task still counts once.
    expect(homeCounts([reviewer, worker], l, null)).toEqual({ blocked: 0, working: 1, ready: 0 })
  })

  it('matches replacement panes by task workspace on the selected machine', () => {
    const remote = links([task(3, [], 'todo', 'todo'), task(4, [], 'done', 'done'), task(7, [], 'reviewing')], 'abcd1234')
    remote.tasks.forEach(t => { t.workspace = `abcd1234~${t.workspace}` })
    const panes = [pane('abcd1234~w3:p9', 'working'), pane('abcd1234~w4:p9', 'working'), pane('abcd1234~w7:p9', 'working'), pane('w3:p9', 'working')]
    const board = cli(machine([row(3, 'idle', 'todo'), done, row(7, 'working', 'reviewing')], 'abcd1234'))
    expect(homeCounts(panes, [remote], board, p => p.id.startsWith('abcd1234~'), m => m === 'abcd1234')).toEqual({ blocked: 0, working: 1, ready: 2 })
  })

  it('counts the same task id independently on two machines and filters before choosing a helper', () => {
    const worker = pane('abcd1234~w7:p1', 'working')
    const reviewer = pane('abcd1234~w8:p1', 'working')
    const l = [links([task(7, [{ id: 'w7:p1', role: 'worker' }])]),
      links([task(7, [{ id: worker.id, role: 'worker' }, { id: reviewer.id, role: 'reviewer' }])], 'abcd1234')]
    const board = cli(machine([row(7, 'done', 'done')]), machine([row(7, 'working', 'reviewing')], 'abcd1234'))
    const panes = [pane('w7:p1', 'working'), worker, reviewer]
    expect(homeCounts(panes, l, board)).toEqual({ blocked: 0, working: 1, ready: 1 })
    expect(homeCounts(panes, l, board, p => p.id === worker.id, m => m === 'abcd1234')).toEqual({ blocked: 0, working: 1, ready: 0 })
  })

  it.each(['', 'abcd1234'])('keeps an unlinked working agent independent in a shared workspace (%s)', (key) => {
    const prefix = key ? `${key}~` : ''
    const panes = [pane(`${prefix}w1:p1`, 'working'), pane(`${prefix}w1:p2`, 'working'), pane(`${prefix}w1:p3`, 'working')]
    const tasks: LinkedTask[] = [1, 2].map(n => ({ ...task(n, [{ id: `${prefix}w1:p${n}`, role: 'worker' }], 'done', 'done'), workspace: `${prefix}w1` }))
    const l = [links(tasks, key)]
    const board = cli(machine([row(1, 'done', 'done'), row(2, 'done', 'done')], key))
    expect(countedPanes(panes, l).map(p => p.id).sort()).toEqual(panes.map(p => p.id))
    expect(homeCounts(panes, l, board)).toEqual({ blocked: 0, working: 1, ready: 2 })
    // Explicit pane ownership can identify shared tasks even without workspace links.
    tasks.forEach(t => { t.workspace = null })
    expect(homeCounts(panes, l, board)).toEqual({ blocked: 0, working: 1, ready: 2 })
  })

  it('a task that waits for you counts with no agent pane left', () => {
    const board = cli(machine([needsYou, exited, readyToApprove, working, done, row(3, 'idle', 'todo'), row(2, 'blocked', 'asks', { archivedAt: 1 })]))
    expect(homeCounts([], [], board)).toEqual({ blocked: 3, working: 0, ready: 0 })
    // Its panes were filtered out as stale: still once.
    const l = [links([task(178, [{ id: 'w178:p1', role: 'worker' }], 'stopped', 'needs')])]
    expect(homeCounts([pane('w178:p1', 'idle')], l, board, () => false)).toEqual({ blocked: 3, working: 0, ready: 0 })
    expect(homeCounts([pane('w178:p1', 'idle')], l, board)).toEqual({ blocked: 3, working: 0, ready: 0 })
  })

  it('follows the machine bar; a board whose CLI did not answer keeps the linked groups', () => {
    const l = [links([task(9, [{ id: 'w9:p1', role: 'worker' }])], 'pi')]
    const panes = [{ ...pane('w9:p1', 'working'), machine: 'pi' }, pane('w1:p1', 'working')]
    const board = cli(machine([exited, needsYou], 'pi'))
    const onlyHere = (p: P) => (p.machine || '') === ''
    expect(homeCounts(panes, l, board, onlyHere, m => m === '')).toEqual({ blocked: 0, working: 1, ready: 0 })
    expect(homeCounts(panes, l, board, p => p.machine === 'pi', m => m === 'pi')).toEqual({ blocked: 2, working: 0, ready: 0 })
    expect(homeCounts(panes, l, cli(machine([exited], 'pi', { error: 'pi is unreachable', stale: true })))).toEqual({ blocked: 0, working: 2, ready: 0 })
  })
})

describe('task groups on the home cards', () => {
  it('take the CLI\'s state over the stage in the file', () => {
    const l = [links([task(9, [{ id: 'w9:p1', role: 'worker' }]), task(5, [{ id: 'w5:p1', role: 'worker' }])], 'pi')]
    const out = withBoardGroups(l, cli(machine([row(9, 'error', 'working', { msg: 'The agent has exited' }), row(5, 'working', 'working')], 'pi')))
    expect(out[0]!.tasks.map(t => [t.id, t.stage, t.group])).toEqual([['app/9', 'working', 'needs'], ['app/5', 'working', 'working']])
    // Another board's rows, or none: the files' groups stay.
    expect(withBoardGroups(l, cli(machine([row(9, 'error', 'working')], 'other')))).toBe(l)
    expect(withBoardGroups(l, null)).toBe(l)
  })
})
