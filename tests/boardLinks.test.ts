import { describe, expect, it } from 'vitest'
import { reduceSnapshot } from '../server/utils/snapshot'
import { spaceRows } from '../shared/spaces'
import {
  type MachineLinks, boardSections, coordinatorFromFile, countedPanes, socketSession, elapsedLabel, linksFromTaskFile, memberStage, memberTag,
  parseRepoGit, resolveCoordinators, shownPane, tasksFromFiles, tasksIn,
} from '../shared/boardLinks'
import { taskActivity } from '../shared/taskActivity'
import { rowFromTaskFile } from '../shared/projectsTasks'

// A Herdr session as herdr-projects 1.2.1 leaves it: the coordinators as tabs of
// one space ("herdr-projects"), the repo's own space (a shell in the clone), the
// tasks' worktree spaces linked to it by Herdr (same repo_key), and spaces of
// the user's own.
const REPO_KEY = '/home/u/dev/app/.git'
const wt = (linked: boolean, path: string) => ({ checkout_path: path, is_linked_worktree: linked, repo_key: REPO_KEY, repo_name: 'app', repo_root: '/home/u/dev/app' })
type RawPane = { pane_id: string, workspace_id: string, tab_id: string, agent: string | null, agent_status: string }
const pane = (id: string, agent: string | null = 'claude', status = 'idle'): RawPane => ({ pane_id: id, workspace_id: id.split(':')[0]!, tab_id: `${id.split(':')[0]}:t${id.endsWith('p9') ? 2 : 1}`, agent, agent_status: agent ? status : 'unknown' })
function snapshot(machine = '') {
  const workspaces = [
    { workspace_id: 'w1', label: 'herdr-projects', number: 1 },
    { workspace_id: 'w2', label: 'app', number: 2, worktree: wt(false, '/home/u/dev/app') },
    { workspace_id: 'w3', label: 'APP-1 Login redirect', number: 3, worktree: wt(true, '/home/u/wt/app-1') },
    { workspace_id: 'w4', label: 'APP-2 Rate limits', number: 4, worktree: wt(true, '/home/u/wt/app-2') },
    { workspace_id: 'w5', label: 'notes', number: 5 },
    { workspace_id: 'w6', label: 'spike', number: 6, worktree: wt(true, '/home/u/wt/spike') },
  ]
  const panes = [
    pane('w1:p1', 'claude', 'idle'), pane('w1:p2', 'claude', 'working'),
    pane('w2:p1', null),
    pane('w3:p1', 'claude', 'working'), pane('w3:p9', 'codex', 'blocked'),
    pane('w4:p1', 'codex', 'blocked'),
    pane('w5:p1', 'claude', 'done'),
    pane('w6:p1', 'claude', 'idle'),
  ]
  const tabs = [...new Set(panes.map(p => p.tab_id))].map((id, i) => ({ tab_id: id, workspace_id: id.split(':')[0], label: String(i + 1), number: Number(id.split(':t')[1]) }))
  return reduceSnapshot({ workspaces, tabs, panes }, machine)
}
const SOCK = '/home/u/.config/herdr/herdr.sock'
const local = (socket: unknown) => (socket === SOCK || socket == null ? '' : null)

const links = (): MachineLinks => ({
  machine: '',
  coordinators: [
    { level: 'top', pane: 'w1:p1', workspace: 'w1' },
    { level: 'project', repo: 'app', pane: 'w1:p2', workspace: 'w1' },
  ],
  tasks: tasksFromFiles([
    linksFromTaskFile({ id: 'app/1', title: 'Login  redirect', stage: 'reviewing', reviewAt: 5000, since: 1000, watch: { progress: 42.4, msg: 'Checking the loop' }, link: { socket: SOCK, pane: 'w3:p1', workspace: 'w3', ownsWorkspace: true, reviewer: { pane: 'w3:p9' } } }, local)!,
    linksFromTaskFile({ id: 'app/2', title: 'Rate limits', stage: 'working', since: 1000, workAt: 2000, msg: 'Writing tests', link: { socket: SOCK, pane: 'w4:p1', workspace: 'w4', ownsWorkspace: true } }, local)!,
  ], { app: 'APP' }),
  repos: [{ repo: 'app', root: '/home/u/dev/app', branch: 'main', behind: 38 }],
})

describe('reading the board\'s files', () => {
  it('a task: its panes by role, its space, its report', () => {
    const t = links().tasks.find(x => x.id === 'app/1')!
    expect(t).toMatchObject({ key: 'APP-1', title: 'Login redirect', workspace: 'w3', progress: 42, msg: 'Checking the loop', since: 5000, stage: 'reviewing' })
    expect(t.panes).toEqual([{ id: 'w3:p1', role: 'worker' }, { id: 'w3:p9', role: 'reviewer' }])
    // The worker's turn: the later of `since` and `workAt`; the task's own line without a watcher's.
    expect(links().tasks.find(x => x.id === 'app/2')).toMatchObject({ since: 2000, msg: 'Writing tests', progress: null })
  })

  it('an attempt joins its task; a session wherdr has not opened names no pane', () => {
    const attempt = linksFromTaskFile({ id: 'app/3b', attemptOf: 'app/3', letter: 'B', link: { socket: SOCK, pane: 'w7:p1' } }, local)!
    const own = linksFromTaskFile({ id: 'app/3', title: 'Two ways', link: { socket: '/x/sessions/other/herdr.sock', pane: 'w8:p1' } }, local)!
    expect(own.panes).toEqual([])
    const [t] = tasksFromFiles([own, attempt], {})
    expect(t).toMatchObject({ id: 'app/3', key: '#3', panes: [{ id: 'w7:p1', role: 'attempt', letter: 'B' }] })
    // An attempt that does not name its task, a bad id, a remote pane id: refused.
    expect(linksFromTaskFile({ id: 'app/3b', attemptOf: 'app/4' }, local)).toBeNull()
    expect(linksFromTaskFile({ id: '../x/1' }, local)).toBeNull()
    expect(linksFromTaskFile({ id: 'app/5', link: { pane: 'abc~w1:p1' } }, local)!.panes).toEqual([])
  })

  it('remote machines prefix the ids; tasks with nothing open are left out', () => {
    const t = linksFromTaskFile({ id: 'app/4', link: { pane: 'w2:p3', workspace: 'w2', ownsWorkspace: true } }, () => '0a1b2c3d')!
    expect(t).toMatchObject({ panes: [{ id: '0a1b2c3d~w2:p3', role: 'worker' }], workspace: '0a1b2c3d~w2' })
    expect(tasksFromFiles([linksFromTaskFile({ id: 'app/6', link: null }, local)!], {})).toEqual([])
  })

  it('carries worker takeover and review identity through Home grouping', () => {
    const file = linksFromTaskFile({ id: 'app/4', agent: 'claude', on: 'codex/gpt', stage: 'reviewing', handovers: [{ role: 'worker', from: 'claude', to: 'codex/gpt' }], link: { pane: 'w2:p3', reviewer: { pane: 'w2:p4', kind: 'omp' } } }, local)!
    expect(tasksFromFiles([file], {})[0]!.identity).toEqual({ agent: 'codex', reviewer: 'omp', from: 'claude' })
  })

  it('names the Herdr session of a task from its socket', () => {
    expect(socketSession('/run/sessions/other/herdr.sock', 'default')).toBe('other')
    expect(socketSession(SOCK, 'default')).toBe('default')
    expect(socketSession(undefined, 'main')).toBe('main')
    const name = (s: unknown) => socketSession(s, 'default')
    const other = linksFromTaskFile({ id: 'shop/2', link: { socket: '/run/sessions/other/herdr.sock', pane: 'w2:p1' } }, () => 'abcd', name)!
    expect(tasksFromFiles([other], {})[0]).toMatchObject({ session: 'other', panes: [{ id: 'abcd~w2:p1' }] })
    expect(linksFromTaskFile({ id: 'shop/1', link: { pane: 'w2:p1' } }, local, name)!.session).toBe('default')
  })

  it('coordinator state files', () => {
    expect(coordinatorFromFile('top', { socket: SOCK, pane: 'w1:p1', space: 'w1' }, local)).toEqual({ level: 'top', pane: 'w1:p1', workspace: 'w1' })
    expect(coordinatorFromFile('project', { socket: SOCK, pane: 'w1:p2' }, local, 'web')).toEqual({ level: 'project', repo: 'web', pane: 'w1:p2', workspace: null })
    expect(coordinatorFromFile('machine', { socket: SOCK, pane: null, space: null }, local)).toBeNull()
    expect(coordinatorFromFile('project', { pane: 'w1:p2', repo: '../etc' }, local)).toBeNull()
  })

  it('git: branch and behind count', () => {
    expect(parseRepoGit('main\t38\n')).toEqual({ branch: 'main', behind: 38 })
    expect(parseRepoGit('feature/x\t\n')).toEqual({ branch: 'feature/x', behind: null })
    expect(parseRepoGit('')).toEqual({ branch: '', behind: null })
  })
})

describe('the home list follows Herdr\'s worktree groups', () => {
  const st = snapshot()
  const live = new Set(st.panes.map(p => p.id))
  const s = boardSections(spaceRows(st), st.workspaces, [links()], live)

  it('the coordinators: by role, one row each, at the top', () => {
    expect(s.coordinators.map(c => [c.level, c.row.key])).toEqual([['top', 'w1:p1']])
    expect(s.projects[0]!.coordinator?.key).toBe('w1:p2')
  })

  it('the repo space heads its group, the task agents under it, most urgent first', () => {
    expect(s.projects).toHaveLength(1)
    const g = s.projects[0]!
    expect(g).toMatchObject({ id: REPO_KEY, repo: 'app', key: 'APP', info: { branch: 'main', behind: 38 }, remote: null })
    expect(g.space?.key).toBe('w2:p1')
    // One row per task, both waiting on you (APP-1's reviewer asks), in Herdr's order.
    expect(g.members.map(m => [m.row.key, m.row.lead.id, m.task?.key ?? null])).toEqual([
      ['w3', 'w3:p9', 'APP-1'], ['w4:p1', 'w4:p1', 'APP-2'],
    ])
    // The project coordinator and both tasks are in the working group.
    expect(g.sum).toEqual({ blocked: 0, working: 3, ready: 0, total: 3 })
    expect(g.state).toBe('working')
  })

  it('a worker and its reviewer in one space: one row, led by the reviewer', () => {
    const g = s.projects[0]!
    const app1 = g.members.filter(m => m.task?.id === 'app/1')
    expect(app1).toHaveLength(1)
    const m = app1[0]!
    expect([m.row.kind, m.row.lead.id, memberTag(m, 'review')]).toEqual(['space', 'w3:p9', 'APP-1'])
    expect(m.focus).toEqual({ id: 'w3:p9', role: 'reviewer', kind: 'codex' })
    expect(memberStage(m)).toEqual({ what: 'review', by: 'codex' })
    // The reviewer's tab is the one the row opens.
    expect(m.row.kind === 'space' && m.row.leadTab.tab.id).toBe('w3:t2')
  })

  it('spaces that are not the board\'s stay as they were, worktrees of the repo included', () => {
    expect(s.others.map(r => r.key)).toEqual(['w5:p1', 'w6:p1'])
  })

  it('without the board, nothing is grouped: Herdr\'s worktree group stays in the usual lists', () => {
    const bare = boardSections(spaceRows(st), st.workspaces, [], live)
    expect(bare.coordinators).toEqual([])
    expect(bare.projects).toEqual([])
    expect(bare.others.map(r => r.key)).toEqual(spaceRows(st).map(r => r.key))
  })

  it('a repo on two machines: each group shows its own machine\'s checkout', () => {
    const remote = snapshot('abcd1234')
    const remoteLinks: MachineLinks = {
      machine: 'abcd1234', coordinators: [],
      tasks: tasksFromFiles([linksFromTaskFile({ id: 'app/9', title: 'Far', link: { pane: 'w4:p1', workspace: 'w4', ownsWorkspace: true } }, () => 'abcd1234')!], {}),
      repos: [{ repo: 'app', root: '/home/u/dev/app', branch: 'remote-feature', behind: 1 }],
    }
    const both = [links(), remoteLinks]
    const all = new Set([...live, ...remote.panes.map(p => p.id)])
    const far = boardSections(spaceRows(remote, 'abcd1234'), [...st.workspaces, ...remote.workspaces], both, all).projects[0]!
    expect(far.info).toMatchObject({ branch: 'remote-feature', behind: 1 })
    expect(far.space?.key).toBe('abcd1234~w2:p1')
    expect(far.members.map(m => m.task?.key)).toEqual(['#9'])
    const near = boardSections(spaceRows(st, ''), [...st.workspaces, ...remote.workspaces], both, all).projects[0]!
    expect(near.info).toMatchObject({ branch: 'main', behind: 38 })
    // A named session of a machine reads that machine's board.
    const session = boardSections(spaceRows(remote, 'abcd1234'), remote.workspaces, both, all, k => (k === 'abcd1234' ? 'abcd1234' : k)).projects[0]!
    expect(session.info?.branch).toBe('remote-feature')
  })

  it('a repo coordinated from another machine: its tasks stay here, with the link', () => {
    const far: MachineLinks = { machine: '0a1b2c3d', tasks: [], coordinators: [{ level: 'project', repo: 'app', pane: '0a1b2c3d~w1:p4', workspace: null }] }
    const here = { ...links(), coordinators: links().coordinators.filter(c => c.level === 'top') }
    const g = boardSections(spaceRows(st), st.workspaces, [here, far], new Set([...live, '0a1b2c3d~w1:p4'])).projects[0]!
    expect(g.coordinator).toBeNull()
    expect(g.remote).toEqual({ pane: '0a1b2c3d~w1:p4', machine: '0a1b2c3d' })
    // Its pane gone from Herdr: no link.
    expect(boardSections(spaceRows(st), st.workspaces, [here, far], live).projects[0]!.remote).toBeNull()
  })

  it('closing the repo space: the tasks whose agents stop with it', () => {
    expect(tasksIn(['w2', 'w3', 'w4', 'w6'], st.panes, [links()]).map(t => t.key)).toEqual(['APP-2', 'APP-1'])
    expect(tasksIn(['w5'], st.panes, [links()])).toEqual([])
  })
})

// herdr-projects 1.2.1 gives each helper of a task its own tab in the task's
// space (its docs/tabs.md): Agent, Reviewer #N, Planner, Plan review, Agent A /
// Agent B and Picker. The list keeps one row per task.
describe('one row per task, whatever helpers its space holds', () => {
  // [tab id, tab label, pane id, agent, status]
  type T = [string, string, string, string | null, string]
  function session(tabs: T[]) {
    const ids = [...new Set(tabs.map(x => x[2].split(':')[0]!))]
    const workspaces = [
      { workspace_id: 'w2', label: 'app', number: 2, worktree: wt(false, '/home/u/dev/app') },
      ...ids.map(id => ({ workspace_id: id, label: `task ${id}`, number: Number(id.slice(1)), worktree: wt(true, `/home/u/wt/${id}`) })),
    ]
    const all: T[] = [['w2:t1', '1', 'w2:p1', null, ''], ...tabs]
    const panes = all.map(([tab, , id, agent, status]) => ({ pane_id: id, workspace_id: id.split(':')[0]!, tab_id: tab, agent, agent_status: agent ? status : 'unknown' }))
    const seen = new Set<string>()
    const tabList = all.filter(x => !seen.has(x[0]) && seen.add(x[0])).map(([tab, label]) => ({ tab_id: tab, workspace_id: tab.split(':')[0]!, label, number: Number(tab.split(':t')[1]) }))
    return reduceSnapshot({ workspaces, tabs: tabList, panes }, '')
  }
  const board = (files: unknown[]): MachineLinks => ({
    machine: '', coordinators: [],
    tasks: tasksFromFiles(files.map(f => linksFromTaskFile(f, local)!), { app: 'APP' }),
    repos: [{ repo: 'app', root: '/home/u/dev/app', branch: 'main', behind: 0 }],
  })
  const groupOf = (st: ReturnType<typeof session>, links: MachineLinks) =>
    boardSections(spaceRows(st), st.workspaces, [links], new Set(st.panes.map(p => p.id))).projects[0]!
  const tabOf = (m: { row: { kind: string } }) => (m.row as { leadTab?: { tab: { label: string } } }).leadTab?.tab.label

  const reviewing = { id: 'app/7', title: 'Payment recap', stage: 'reviewing', reviewAt: 9000, link: { pane: 'w7:p1', workspace: 'w7', ownsWorkspace: true, reviewer: { pane: 'w7:p2', tab: 'w7:t2', kind: 'codex' } } }
  const reviewTabs: T[] = [['w7:t1', 'Agent', 'w7:p1', 'claude', 'idle'], ['w7:t2', 'Reviewer #1', 'w7:p2', 'codex', 'working']]

  it('under review: one row, the reviewer\'s state and tab, "review · codex"', () => {
    const g = groupOf(session(reviewTabs), board([reviewing]))
    expect(g.members).toHaveLength(1)
    const m = g.members[0]!
    expect([m.row.kind, m.row.lead.id, m.task?.key, tabOf(m)]).toEqual(['space', 'w7:p2', 'APP-7', 'Reviewer #1'])
    expect(memberStage(m)).toEqual({ what: 'review', by: 'codex' })
    // The repo group counts one task, at work.
    expect(g.sum).toEqual({ blocked: 0, working: 1, ready: 0, total: 1 })
  })

  it('project totals follow task groups despite leftover working terminals', () => {
    const st = session([...reviewTabs, ['w8:t1', 'Agent', 'w8:p1', 'codex', 'working'], ['w9:t1', 'Agent', 'w9:p1', 'codex', 'working']])
    const b = board([reviewing,
      { id: 'app/8', stage: 'done', link: { pane: 'w8:p1', workspace: 'w8', ownsWorkspace: true } },
      { id: 'app/9', stage: 'todo', link: { pane: 'w9:p1', workspace: 'w9', ownsWorkspace: true } },
    ])
    expect(groupOf(st, b).sum).toEqual({ blocked: 0, working: 1, ready: 2, total: 3 })
  })

  it('the review over: its tab closed, the task\'s own agent again', () => {
    const done = { ...reviewing, stage: 'approval', link: { ...reviewing.link, reviewer: null } }
    const g = groupOf(session([reviewTabs[0]!]), board([done]))
    expect(g.members.map(m => [m.row.kind, m.row.lead.id, memberStage(m)])).toEqual([['pane', 'w7:p1', null]])
  })

  it('a worker that asks during a review: the row shows its question', () => {
    const tabs: T[] = [['w7:t1', 'Agent', 'w7:p1', 'claude', 'blocked'], reviewTabs[1]!]
    const m = groupOf(session(tabs), board([reviewing])).members[0]!
    expect([m.row.lead.id, tabOf(m)]).toEqual(['w7:p1', 'Agent'])
    // Still under review: the stage says so.
    expect(memberStage(m)).toEqual({ what: 'review', by: 'codex' })
  })

  it('a reviewer pane without its program on file: Herdr\'s agent names it', () => {
    const file = { ...reviewing, link: { ...reviewing.link, reviewer: { pane: 'w7:p2' } } }
    expect(memberStage(groupOf(session(reviewTabs), board([file])).members[0]!)).toEqual({ what: 'review', by: 'codex' })
  })

  it('a plan: its planner, then its plan review, in the task\'s row', () => {
    const planning = { id: 'app/8', title: 'Plan first', stage: 'working', agent: 'codex', plan: { asked: 1, home: { pane: 'w8:p1', agent: 'claude' } }, link: { pane: 'w8:p2', workspace: 'w8', ownsWorkspace: true } }
    const tabs: T[] = [['w8:t1', 'Agent', 'w8:p1', 'claude', 'idle'], ['w8:t2', 'Planner', 'w8:p2', 'codex', 'working']]
    const links = board([planning])
    expect(links.tasks[0]!.panes).toEqual([{ id: 'w8:p1', role: 'worker', kind: 'claude' }, { id: 'w8:p2', role: 'planner', kind: 'codex' }])
    const m = groupOf(session(tabs), links).members[0]!
    expect([m.row.lead.id, tabOf(m), memberStage(m)]).toEqual(['w8:p2', 'Planner', { what: 'planning', by: 'codex' }])
    // The plan written, a reviewer checks it in "Plan review".
    const looked = { ...planning, plan: { asked: 1 }, link: { pane: 'w8:p1', workspace: 'w8', ownsWorkspace: true, reviewer: { pane: 'w8:p3', kind: 'claude' } } }
    const g = groupOf(session([tabs[0]!, ['w8:t3', 'Plan review', 'w8:p3', 'claude', 'working']]), board([looked]))
    expect(g.members).toHaveLength(1)
    expect([g.members[0]!.row.lead.id, tabOf(g.members[0]!), memberStage(g.members[0]!)]).toEqual(['w8:p3', 'Plan review', { what: 'plan-review', by: 'claude' }])
    // An approved plan: its old home is not read.
    expect(linksFromTaskFile({ ...planning, plan: { approvedAt: 2, home: { pane: 'w8:p1' } } }, local)!.panes).toEqual([{ id: 'w8:p2', role: 'worker', kind: 'codex' }])
  })

  it('several attempts, then the Picker: one row', () => {
    const own = { id: 'app/9', title: 'Two ways', stage: 'attempts', link: { workspace: 'w9', ownsWorkspace: true } }
    const a = { id: 'app/9a', attemptOf: 'app/9', letter: 'A', agent: 'claude', link: { pane: 'w9:p1' } }
    const b = { id: 'app/9b', attemptOf: 'app/9', letter: 'B', agent: 'codex', link: { pane: 'w9:p2' } }
    const tabs: T[] = [['w9:t1', 'Agent A', 'w9:p1', 'claude', 'working'], ['w9:t2', 'Agent B', 'w9:p2', 'codex', 'idle']]
    const g = groupOf(session(tabs), board([own, a, b]))
    expect(g.members).toHaveLength(1)
    expect([g.members[0]!.task?.key, memberTag(g.members[0]!, 'review'), memberStage(g.members[0]!)]).toEqual(['APP-9', 'APP-9', { what: 'attempts', n: 2 }])
    expect(g.sum.total).toBe(1)
    // The reviewer comparing them, in "Picker".
    const picking = { ...own, stage: 'reviewing', comparing: { at: 1 }, link: { ...own.link, reviewer: { pane: 'w9:p3', kind: 'claude' } } }
    const m = groupOf(session([...tabs, ['w9:t3', 'Picker', 'w9:p3', 'claude', 'working']]), board([picking, a, b])).members
    expect(m).toHaveLength(1)
    expect([m[0]!.row.lead.id, tabOf(m[0]!), memberStage(m[0]!)]).toEqual(['w9:p3', 'Picker', { what: 'pick', by: 'claude' }])
  })

  it('a space two tasks share: each agent keeps its own row', () => {
    const one = { id: 'app/7', title: 'One', link: { pane: 'w7:p1' } }
    const two = { id: 'app/8', title: 'Two', link: { pane: 'w7:p2' } }
    const g = groupOf(session(reviewTabs), board([one, two]))
    expect(g.members.map(m => [m.row.kind, m.row.lead.id, m.task?.key])).toEqual([['pane', 'w7:p2', 'APP-8'], ['pane', 'w7:p1', 'APP-7']])
  })

  it('a space two tasks share, one under review: a row per task, the counters agree', () => {
    const other = { id: 'app/8', title: 'Other', stage: 'working', link: { pane: 'w7:p3' } }
    const st = session([...reviewTabs, ['w7:t3', 'Other', 'w7:p3', 'claude', 'working']])
    const links = board([reviewing, other])
    const g = groupOf(st, links)
    expect(g.members.map(m => [m.row.kind, m.row.lead.id, memberTag(m, 'review'), memberStage(m)])).toEqual([
      ['space', 'w7:p2', 'APP-7', { what: 'review', by: 'codex' }], ['pane', 'w7:p3', 'APP-8', null],
    ])
    expect(tabOf(g.members[0]!)).toBe('Reviewer #1')
    expect(g.sum.total).toBe(2)
    expect(countedPanes(st.panes.filter(p => p.agent), [links])).toHaveLength(g.sum.total)
  })

  it('only its reviewer left open: still "review · codex", one row, no "· review" tag', () => {
    const g = groupOf(session([reviewTabs[1]!]), board([reviewing]))
    expect(g.members).toHaveLength(1)
    const m = g.members[0]!
    expect([m.row.kind, m.row.lead.id, memberTag(m, 'review'), memberStage(m)]).toEqual(['pane', 'w7:p2', 'APP-7', { what: 'review', by: 'codex' }])
  })

  it('the counters count tasks: a task\'s helpers once', () => {
    const st = session([...reviewTabs, ['w5:t1', '1', 'w5:p1', 'claude', 'done']])
    const counted = countedPanes(st.panes.filter(p => p.agent), [board([reviewing])])
    expect(counted.map(p => p.id).sort()).toEqual(['w5:p1', 'w7:p2'])
    // A reviewer in its own space still belongs to the same task.
    const apart = session([reviewTabs[0]!, ['w6:t1', 'Reviewer', 'w6:p2', 'codex', 'working']])
    const far = board([{ ...reviewing, link: { ...reviewing.link, reviewer: { pane: 'w6:p2', kind: 'codex' } } }])
    expect(groupOf(apart, far).sum.total).toBe(1)
    expect(countedPanes(apart.panes.filter(p => p.agent), [far])).toHaveLength(1)
    // Without the board, every agent counts.
    expect(countedPanes(st.panes.filter(p => p.agent), [])).toHaveLength(3)
  })

  it('the pane a task shows', () => {
    const p = (id: string, status: string) => ({ id, agent: 'claude', status })
    expect(shownPane([p('a', 'idle'), p('b', 'working')], 'b')?.id).toBe('b')
    expect(shownPane([p('a', 'blocked'), p('b', 'working')], 'b')?.id).toBe('a')
    expect(shownPane([p('a', 'idle'), p('b', 'working')], null)?.id).toBe('b')
    expect(shownPane([], 'b')).toBeNull()
  })
})

describe('labels', () => {
  it('a member\'s tag', () => {
    const task = links().tasks[0]!
    expect(memberTag({ task, role: 'worker' }, 'review')).toBe(task.key)
    expect(memberTag({ task, role: 'reviewer' }, 'review')).toBe(`${task.key} · review`)
    expect(memberTag({ task, role: 'attempt', letter: 'B' }, 'review')).toBe(`${task.key} · B`)
    expect(memberTag({ task: null, role: 'worker' }, 'review')).toBe('')
  })
  it('elapsed time', () => {
    expect(elapsedLabel(45_000)).toBe('45s')
    expect(elapsedLabel(17 * 60_000)).toBe('17m')
    expect(elapsedLabel(125 * 60_000)).toBe('2h05')
    expect(elapsedLabel(3 * 86_400_000)).toBe('3d')
    expect(elapsedLabel(-5)).toBe('0s')
  })
})

describe('closing what holds a task', () => {
  const st = snapshot()
  const all = links()
  it('the repo space closes its worktree group: every task in it is named', async () => {
    const { planClose, tasksClosing, taskStopMessage } = await import('../app/utils/closeFlow')
    const plan = planClose(st, 'workspace', 'w2')
    expect(plan.group).toBe(true)
    const tasks = tasksClosing(plan, 'workspace', [all])
    expect(tasks.map(t => t.key).sort()).toEqual(['APP-1', 'APP-2'])
    const en = (a: string) => a
    expect(taskStopMessage(tasks, en)?.action).toBe('Close and stop 2 tasks')
    expect(taskStopMessage(tasks, en)?.message).toContain('APP-1 Login redirect')
  })
  it('a task\'s own space, or its agent\'s pane, names that task; a shell elsewhere names none', async () => {
    const { planClose, tasksClosing, taskStopMessage } = await import('../app/utils/closeFlow')
    expect(tasksClosing(planClose(st, 'workspace', 'w4'), 'workspace', [all]).map(t => t.key)).toEqual(['APP-2'])
    expect(tasksClosing(planClose(st, 'pane', 'w3:p9'), 'pane', [all]).map(t => t.key)).toEqual(['APP-1'])
    expect(tasksClosing(planClose(st, 'workspace', 'w5'), 'workspace', [all])).toEqual([])
    expect(taskStopMessage([], (a: string) => a)).toBeNull()
    expect(taskStopMessage([{ key: 'APP-2', title: '' }], (a: string) => a)?.action).toBe('Close and stop the task')
  })
})

// herdr-projects keeps a reviewer's `watch` after the review (close_reviewer
// drops the link, not the watcher): the task's own stage and line still decide.
describe('a watcher kept after its review', () => {
  const file = { id: 'demo/9', stage: 'merging', msg: 'Waiting for GitHub checks · 1 of 2 passed', watch: { role: 'reviewer', msg: 'Reviewing the result', progress: 90 }, link: { socket: SOCK, pane: 'w1:p1' } }
  it('the link waits for CI as the row does, with the task\'s line and no progress', () => {
    const link = linksFromTaskFile(file, local)!
    expect(link.activity).toEqual({ kind: 'ci', passed: 1, total: 2 })
    expect(link.activity).toEqual(taskActivity(rowFromTaskFile(file, null)!))
    expect(link.msg).toBe('Waiting for GitHub checks · 1 of 2 passed')
    expect(link.progress).toBeNull()
    expect(tasksFromFiles([link], {})[0]!.activity).toEqual({ kind: 'ci', passed: 1, total: 2 })
  })
  it('while an agent runs, the watcher\'s line and progress are kept', () => {
    const link = linksFromTaskFile({ ...file, stage: 'reviewing', msg: 'Under review' }, local)!
    expect(link.activity).toEqual({ kind: 'running' })
    expect(link.msg).toBe('Reviewing the result')
    expect(link.progress).toBe(90)
  })
})

describe('checkout path attachment after a repository move', () => {
  it('keeps the board name and key when the project coordinator is closed', () => {
    const st = snapshot()
    for (const w of st.workspaces) if (w.repo) w.repoName = 'feature-folder'
    const board = links()
    board.coordinators = []
    const result = boardSections(spaceRows(st), st.workspaces, [board], new Set(st.panes.map(p => p.id)))
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]).toMatchObject({ repo: 'app', key: 'APP', coordinator: null, remote: null })
    expect(result.projects[0]!.members.length).toBeGreaterThan(0)
    expect(result.projects[0]!.space?.lead.id).toBe('w2:p1')
  })

  it('preserves the checkout path from Herdr metadata', () => {
    expect(snapshot().workspaces.find(w => w.id === 'w2')!.path).toBe('/home/u/dev/app')
  })

  for (const metadata of [false, true]) {
    it(`attaches the checkout with ${metadata ? 'stale' : 'missing'} Git metadata without renaming the board`, () => {
      const st = snapshot()
      const w = st.workspaces.find(w => w.id === 'w2')!
      w.label = 'renamed-folder'
      w.repo = metadata ? '/old/checkout/.git' : undefined
      w.path = undefined
      st.panes.find(p => p.id === 'w2:p1')!.cwd = '/projects/renamed-folder/'
      const board = links()
      board.repos![0]!.root = '/projects/renamed-folder'
      const result = boardSections(spaceRows(st), st.workspaces, [board], new Set(st.panes.map(p => p.id)))
      expect(result.projects).toHaveLength(1)
      expect(result.projects[0]!.repo).toBe('app')
      expect(result.projects[0]!.space?.lead.id).toBe('w2:p1')
      expect(result.others.some(r => r.lead.id === 'w2:p1')).toBe(false)
      // A sibling or subdirectory must not be treated as the checkout.
      st.panes.find(p => p.id === 'w2:p1')!.cwd = '/projects/renamed-folder/subdir'
      expect(boardSections(spaceRows(st), st.workspaces, [board], new Set()).projects[0]!.space).toBeNull()
      w.machine = 'another-machine'
      st.panes.find(p => p.id === 'w2:p1')!.cwd = '/projects/renamed-folder'
      expect(boardSections(spaceRows(st), st.workspaces, [board], new Set()).projects[0]!.space).toBeNull()
    })
  }
})

// herdr-projects writes a coordinator's pane and space when it starts it. Once
// Herdr closes that pane (Herdr or the agent restarted), the file keeps ids that
// no longer say where it is, until the coordinator is restarted. Seen on macOS
// with omp coordinators: the Coordinator and a project coordinator were listed
// in Ready as plain spaces. Herdr reports each one's conversation on its pane
// (`agent_session`), the same as the file's `session`.
describe('a coordinator whose file names a closed pane', () => {
  const CONV = {
    top: '/home/user/.omp/agent/sessions/-chat/top.jsonl',
    machine: '/home/user/.omp/agent/sessions/-machine-chat/machine.jsonl',
    project: '/home/user/.omp/agent/sessions/-acme-shop/project.jsonl',
  }
  const ACME = '/home/user/dev/acme-shop/.git'
  const acme = (linked: boolean, path: string) => ({ checkout_path: path, is_linked_worktree: linked, repo_key: ACME, repo_name: 'acme-shop', repo_root: '/home/user/dev/acme-shop' })
  const omp = (id: string, tab: string, conv: string | null, agent: string | null = 'omp') => ({
    pane_id: id, workspace_id: id.split(':')[0]!, tab_id: tab, agent, agent_status: agent ? 'done' : 'unknown',
    ...(conv ? { agent_session: { agent: 'omp', kind: 'path', source: 'herdr:omp', value: conv } } : {}),
  })
  // What Herdr shows now: the Coordinator in a tab of the home space, the
  // project coordinator in a tab of the repo's space, a task, and a space of
  // the user's own whose ids the coordinators' files still name.
  function now(machine = '') {
    const workspaces = [
      { workspace_id: 'wA', label: 'notes', number: 1 },
      { workspace_id: 'wB', label: 'home', number: 2 },
      { workspace_id: 'wC', label: 'acme-shop', number: 3, worktree: acme(false, '/home/user/dev/acme-shop') },
      { workspace_id: 'wD', label: 'ACM-1 Checkout', number: 4, worktree: acme(true, '/home/user/wt/acme-1') },
    ]
    const panes = [
      omp('wA:p2', 'wA:t1', '/home/user/.omp/agent/sessions/-notes/notes.jsonl'),
      omp('wB:p1', 'wB:t1', null, null), omp('wB:p5', 'wB:t5', CONV.top),
      omp('wC:p1', 'wC:t1', null, null), omp('wC:p2', 'wC:t2', CONV.project),
      omp('wD:p1', 'wD:t1', 'task-conv', 'codex'),
    ]
    const tabs = [...new Set(panes.map(p => p.tab_id))].map(id => ({ tab_id: id, workspace_id: id.split(':')[0], label: id, number: Number(id.split(':t')[1]) }))
    return reduceSnapshot({ workspaces, tabs, panes }, machine)
  }
  const SOCK_MAC = '/home/user/.config/herdr/herdr.sock'
  const key = (socket: unknown) => (socket === SOCK_MAC ? '' : null)
  // The files as left by an earlier Herdr run: the Coordinator's and the
  // project coordinator's pane ids now name nothing or the user's own space.
  const files = () => [
    coordinatorFromFile('top', { socket: SOCK_MAC, space: 'wA', tab: 'wA:t5', pane: 'wA:p5', session: CONV.top, agent: 'sw-coordinator', run: { kind: 'omp' } }, key, '', 'default')!,
    coordinatorFromFile('machine', { socket: SOCK_MAC, space: 'wB', tab: 'wB:t4', pane: 'wB:p4', session: CONV.machine, run: { kind: 'omp' } }, key, '', 'default')!,
    coordinatorFromFile('project', { socket: SOCK_MAC, repo: 'acme-shop', space: 'wA', tab: 'wA:t2', pane: 'wA:p2', session: CONV.project, run: { kind: 'omp' } }, key, 'acme-shop', 'default')!,
  ]
  const task = linksFromTaskFile({ id: 'acme-shop/1', title: 'Checkout', stage: 'working', link: { socket: SOCK_MAC, pane: 'wD:p1', workspace: 'wD', ownsWorkspace: true } }, key)!
  const board = (machine = ''): MachineLinks => ({ machine, coordinators: files(), tasks: tasksFromFiles([task], { 'acme-shop': 'ACM' }) })
  const sections = (machines: MachineLinks[]) => {
    const st = now()
    return boardSections(spaceRows(st), st.workspaces, machines, new Set(st.panes.map(p => p.id)))
  }

  it('reads the conversation from the file', () => {
    expect(files()[0]).toEqual({ level: 'top', pane: 'wA:p5', workspace: 'wA', session: 'default', agentSession: CONV.top })
  })

  it('without it, the home list loses them and takes a plain space for one', () => {
    const s = sections([board()])
    // The Coordinator is lost, the machine coordinator (not running) takes its space,
    // and the user's own agent passes for the project coordinator.
    expect(s.coordinators.map(c => [c.level, c.row.key])).toEqual([['machine', 'wB']])
    expect(s.projects.find(p => p.repo === 'acme-shop')?.coordinator?.key).toBe('wA:p2')
  })

  it('finds each one again on the pane of its conversation', () => {
    const [b] = resolveCoordinators([board()], now().panes)
    expect(b!.coordinators.map(c => [c.level, c.pane, c.workspace])).toEqual([
      ['top', 'wB:p5', 'wB'],
      // Not running: its pane is gone, its space holds only the Coordinator.
      ['machine', 'wB:p4', 'wB'],
      ['project', 'wC:p2', 'wC'],
    ])
    const s = sections(resolveCoordinators([board()], now().panes))
    expect(s.coordinators.map(c => [c.level, c.row.key])).toEqual([['top', 'wB']])
    const g = s.projects.find(p => p.repo === 'acme-shop')!
    expect([g.coordinator?.key, g.members.map(m => m.task?.key)]).toEqual(['wC', ['ACM-1']])
    // The user's own space stays one.
    expect(s.others.map(r => r.key)).toEqual(['wA:p2'])
  })

  it('never takes another conversation\'s pane or space', () => {
    // The project coordinator is not running: wA:p2 is another agent's, and so is its space.
    const panes = now().panes.filter(p => p.id !== 'wC:p2')
    const [b] = resolveCoordinators([board()], panes)
    expect(b!.coordinators.find(c => c.level === 'project')).toMatchObject({ pane: null, workspace: null })
    const st = now()
    const s = boardSections(spaceRows({ ...st, panes }), st.workspaces, resolveCoordinators([board()], panes), new Set(panes.map(p => p.id)))
    expect(s.others.map(r => r.key)).toContain('wA:p2')
    expect(s.projects.find(p => p.repo === 'acme-shop')?.coordinator ?? null).toBeNull()
  })

  it('two panes with the same conversation: neither is chosen', () => {
    const st = now()
    const twin = { ...st.panes.find(p => p.id === 'wB:p5')!, id: 'wD:p7', workspace: 'wD' }
    const [b] = resolveCoordinators([board()], [...st.panes, twin])
    expect(b!.coordinators[0]).toMatchObject({ level: 'top', pane: 'wA:p5', workspace: null })
  })

  it('stays on its own machine', () => {
    const far = now('0a1b2c3d').panes
    const [b] = resolveCoordinators([board()], far)
    expect(b!.coordinators.map(c => c.pane)).toEqual(['wA:p5', 'wB:p4', 'wA:p2'])
    const [r] = resolveCoordinators([{ ...board('0a1b2c3d'), coordinators: files().map(c => ({ ...c, pane: `0a1b2c3d~${c.pane}`, workspace: `0a1b2c3d~${c.workspace}` })) }], far)
    expect(r!.coordinators.map(c => c.pane)).toEqual(['0a1b2c3d~wB:p5', '0a1b2c3d~wB:p4', '0a1b2c3d~wC:p2'])
  })

  it('ids that still hold, or a file without a conversation, change nothing', () => {
    const fresh = [{ ...board(), coordinators: [
      { level: 'top' as const, pane: 'wB:p5', workspace: 'wB', agentSession: CONV.top },
      { level: 'project' as const, repo: 'acme-shop', pane: 'wC:p2', workspace: 'wC', agentSession: CONV.project },
    ] }]
    expect(resolveCoordinators(fresh, now().panes)).toBe(fresh)
    // The Linux session above (herdr-projects 1.2.1, no conversation read): the same links.
    const linux = [links()]
    expect(resolveCoordinators(linux, snapshot().panes)).toBe(linux)
  })
})
