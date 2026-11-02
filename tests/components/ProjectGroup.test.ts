import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectGroup from '~/components/ProjectGroup.vue'
import AgentCard from '~/components/AgentCard.vue'
import { collapsedRepos, compactList, herdrState } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'
import { type Row, spaceRows } from '#shared/spaces'
import { type LinkedTask, type Member, type ProjectSection, boardSections, linksFromTaskFile, tasksFromFiles } from '#shared/boardLinks'
import { useBoardNow } from '~/composables/useBoardLinks'
import { noteTab } from '~/composables/useWorkspaces'
import { machineBarHidden, machineBarPick, machineBarSaved } from '~/composables/useMachineBar'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const pane = (id: string, p: Partial<Pane> = {}): Pane => ({ id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null, ...p })
const row = (p: Pane): Row => ({ kind: 'pane', key: p.id, pane: p, lead: p })
const task = (n: number, p: Pane): LinkedTask => ({
  id: `shop/${n}`, repo: 'shop', n, key: `SHOP-${n}`, title: `Task ${n}`, panes: [{ id: p.id, role: 'worker' }],
  workspace: p.workspace, stage: 'working', progress: 40, msg: `Doing ${n}`, since: Date.now() - 60_000,
})

const coord = pane('w1:p1', { agent: 'codex', preview: 'Two tasks under way.' })
const workers = [pane('w2:p1', { status: 'working' }), pane('w3:p1', { status: 'working' })]
const members: Member[] = workers.map((p, i) => ({ row: row(p), task: task(i + 1, p), role: 'worker' }))
function section(over: Partial<ProjectSection> = {}): ProjectSection {
  return {
    id: 'repo:shop', repo: 'shop', key: 'SHOP', info: { repo: 'shop', root: '/tmp/shop', branch: 'main', behind: 0 }, space: null,
    coordinator: row(coord), remote: null, members, sum: { blocked: 0, working: 2, ready: 1, total: 3 }, state: 'working', ...over,
  }
}
const mount = (g: ProjectSection) => {
  herdrState.value = { ok: true, workspaces: [], panes: [coord, ...workers] }
  return mountSuspended(ProjectGroup, { props: { group: g }, global: { stubs: { UContextMenu: { template: '<div><slot /></div>' } } } })
}

describe('a repo group on the home list', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; compactList.value = true; collapsedRepos.value = [] })

  it('heads the group with its coordinator, named after the repo, above the bar and the tasks', async () => {
    const w = await mount(section())
    const lead = w.find('.project-lead')
    expect(lead.attributes('aria-label')).toBe('shop coordinator')
    const card = lead.find('.card')
    expect(card.classes()).toContain('home-lead')
    // Its title is the repo, its key on the accent, the COORDINATOR label, its state.
    expect(card.find('.card-title').text()).toBe('shop')
    expect(card.find('.lead-mark.coord').text()).toBe('SHOP')
    expect(card.find('.lead-mark.coord .app-logo').exists()).toBe(false)
    expect(card.find('.lead-coord-tag').text()).toBe('Coordinator')
    expect(card.find('.card-state').exists()).toBe(true)
    // Its last message is not shown.
    expect(card.text()).not.toContain('Two tasks under way.')
    // The bar: fold button with the summary of the tasks, no terminal button.
    expect(w.find('.project-bar .project-sum').text()).toBe('2 tasks·2 working')
    expect(w.find('.project-bar').text()).toContain('main')
    expect(w.find('[aria-label="Open the terminal of shop"]').exists()).toBe(false)
    // The tasks stay in the tree, with their id chip, and no coordinator among them.
    const tree = w.find('.project-tree')
    expect(tree.findAll('.card').map(c => c.find('.home-task-tag').text())).toEqual(['SHOP-1', 'SHOP-2'])
    expect(tree.find('.home-lead').exists()).toBe(false)
    // Lead, bar, tasks: in that order.
    const html = w.html()
    expect(html.indexOf('project-lead')).toBeLessThan(html.indexOf('project-bar'))
    expect(html.indexOf('project-bar')).toBeLessThan(html.indexOf('project-tree'))
    w.unmount()
  })

  it.each(['AB', 'WHR', 'SHOP', 'ABCDE'])('shows project key %s in its coordinator header in both list modes', async (key) => {
    for (const compact of [true, false]) {
      compactList.value = compact
      const w = await mount(section({ key }))
      expect(w.find('.project-lead .lead-mark.coord').text()).toBe(key)
      expect(w.find('.project-lead .app-logo').exists()).toBe(false)
      w.unmount()
    }
  })

  it('keeps the coordinator logo when no project key is available', async () => {
    const w = await mount(section({ key: '' }))
    expect(w.find('.project-lead .lead-mark.coord .app-logo').exists()).toBe(true)
    w.unmount()
  })

  it('opens the coordinator from its row', async () => {
    const w = await mount(section())
    navigate.mockClear()
    await w.find('.project-lead .card').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/a/w1%3Ap1')
    w.unmount()
  })

  for (const compact of [true, false]) {
    it(`task density (${compact ? 'compact' : 'normal'}) keeps only useful information`, async () => {
      compactList.value = compact
      const asking = pane('w9:p1', { status: 'blocked', usageLimit: true, preview: 'Private conversation preview', prompt: { question: 'Continue?', cursor: 0, options: [{ label: 'Yes', hint: null }] } })
      const w = await mountSuspended(AgentCard, { props: { pane: asking, board: { group: 'needs', tag: 'SHOP-9', name: 'A long task title', progress: 30, since: useBoardNow().value - 420000, msg: 'Checking the layout', stage: 'Under review · codex' } } })
      const card = w.find('.card')
      expect(card.classes()).toContain('compact')
      expect(card.find('.card-title').text()).toBe('A long task title')
      expect(card.find('.home-task-stats').text()).toBe('30% 7m')
      expect(card.find('.task-state').text()).toBe('Needs you')
      expect(card.find('.card-state').exists()).toBe(false)
      expect(card.find('.card-more').exists()).toBe(false)
      expect(card.find('.card-main').exists()).toBe(false)
      expect(card.find('.home-task-line').exists()).toBe(!compact)
      if (!compact) {
        expect(card.find('.home-task-line').text()).toContain('Checking the layout')
        expect(card.find('.home-task-stage.quota-limit').text()).toBe('Quota')
        expect(card.find('.home-task-line').text()).toContain('Under review · codex')
      }
      w.unmount()
    })
  }

  it('a coordinator alone: its row and bar, no empty task list', async () => {
    const w = await mount(section({ members: [] }))
    expect(w.find('.project-lead .home-lead').exists()).toBe(true)
    expect(w.find('.project-sum').text()).toBe('No tasks')
    expect(w.find('.project-tree').exists()).toBe(false)
    w.unmount()
  })

  it('folded: the coordinator and the bar stay in view, the tasks fold, the choice is kept per project', async () => {
    const g = section()
    collapsedRepos.value = [`|${g.id}`]
    const w = await mount(g)
    expect(w.find('.project-head').attributes('aria-expanded')).toBe('false')
    expect(w.find('.project-lead .lead-mark.coord').exists()).toBe(true)
    expect(w.find('.project-tree').exists()).toBe(false)
    // The summary says what is folded: the tasks.
    expect(w.find('.project-sum').text()).toBe('2 tasks·2 working')
    // Unfolded again: the tasks come back under it, and the list of folded projects forgets it.
    await w.find('.project-head').trigger('click')
    expect(w.findAll('.project-tree .card')).toHaveLength(2)
    expect(collapsedRepos.value).toEqual([])
    await w.find('.project-head').trigger('click')
    expect(collapsedRepos.value).toEqual(['|repo:shop'])
    w.unmount()
  })

  it('the summary and task badges ignore leftover working terminals', async () => {
    const groups = ['done', 'todo', 'ready', 'working'] as const
    const ms: Member[] = groups.map((group, i) => {
      const p = pane(`w${i + 6}:p1`, { status: 'working' })
      return { row: row(p), task: { ...task(i + 6, p), group }, role: 'worker' }
    })
    herdrState.value = { ok: true, workspaces: [], panes: ms.map(m => m.row.lead) }
    const w = await mountSuspended(ProjectGroup, {
      props: { group: section({ members: ms }) },
      global: { stubs: { UContextMenu: { template: '<div><slot /></div>' } } },
    })
    expect(w.find('.project-sum').text()).toBe('4 tasks·1 your turn·1 working')
    expect(w.findAll('.project-tree .task-state').map(s => s.text())).toEqual(['Done', 'To do', 'Ready to approve', 'Working'])
    w.unmount()
  })

  it('the summary counts the tasks waiting for you, working and at a provider quota', async () => {
    const asking = pane('w4:p1', { status: 'blocked' })
    const limited = pane('w5:p1', { status: 'idle', usageLimit: { text: 'limit' } as Pane['usageLimit'] })
    const more: Member[] = [asking, limited].map((p, i) => ({ row: row(p), task: task(i + 3, p), role: 'worker' }))
    herdrState.value = { ok: true, workspaces: [], panes: [coord, ...workers, asking, limited] }
    const w = await mountSuspended(ProjectGroup, { props: { group: section({ members: [...more, ...members] }) }, global: { stubs: { UContextMenu: { template: '<div><slot /></div>' } } } })
    const sum = w.find('.project-sum')
    expect(sum.text()).toBe('4 tasks·1 your turn·2 working·1 quota')
    expect(sum.find('.project-sum-blocked').text()).toBe('1 your turn')
    expect(sum.find('.project-sum-limit').text()).toBe('1 quota')
    // Each part is whole, and the
    // fold button's title says the whole summary.
    expect(sum.findAll('.project-sum-part').map(p => p.text())).toEqual(['4 tasks·', '1 your turn·', '2 working·', '1 quota'])
    expect(w.find('.project-head').attributes('title')).toBe('Hide the tasks of shop: 4 tasks · 1 your turn · 2 working · 1 quota')
    w.unmount()
  })

  it('a plain terminal has a static project header and remains accessible from the bar menu', async () => {
    const shell = pane('w9:p1', { agent: null, status: null })
    const w = await mount(section({ coordinator: null, space: row(shell) }))
    expect(w.find('.project-lead').exists()).toBe(false)
    expect(w.find('.project-remote').exists()).toBe(false)
    expect(w.element.firstElementChild?.classList.contains('project-identity')).toBe(true)
    expect(w.find('.project-identity h2').text()).toBe('shop')
    expect(w.find('.project-key').text()).toBe('SHOP')
    expect(w.find('.project-identity .card, .project-identity .card-state, .project-identity .lead-coord-tag').exists()).toBe(false)
    const menu = w.findComponent({ name: 'SpaceMenu' })
    const items = menu.props('items')()
    const terminal = items.find((item: { label: string }) => item.label === 'Open the terminal of shop')
    expect(terminal).toBeDefined()
    navigate.mockClear()
    terminal.run()
    expect(navigate).toHaveBeenCalledWith('/a/w9%3Ap1')
    expect(w.findAll('.project-tree .card')).toHaveLength(2)
    w.unmount()
  })

  it('without a repo space the project header remains visible with nothing to open', async () => {
    const w = await mount(section({ coordinator: null }))
    expect(w.find('.project-lead').exists()).toBe(false)
    expect(w.element.firstElementChild?.classList.contains('project-identity')).toBe(true)
    expect(w.find('.project-identity h2').text()).toBe('shop')
    expect(w.find('.project-key').text()).toBe('SHOP')
    expect(w.find('.project-identity .card, .project-identity .card-state, .project-identity .lead-coord-tag').exists()).toBe(false)
    expect(w.find('.project-bar .space-menu').exists()).toBe(false)
    expect(w.findAll('.project-tree .card')).toHaveLength(2)
    w.unmount()
  })

  it('a static project header cannot navigate and survives folding, with an icon when no key is known', async () => {
    const w = await mount(section({ coordinator: null, key: '' }))
    navigate.mockClear()
    await w.find('.project-identity').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
    expect(w.find('.project-key .iconify').exists()).toBe(true)
    const start = w.findComponent({ name: 'SpaceMenu' }).props('items')().find((item: { label: string }) => item.label === 'Start coordinator')
    expect(start).toBeDefined()
    start.run()
    expect(navigate).toHaveBeenCalledWith({ path: '/board', query: { machine: '', coordinator: 'shop' } })
    await w.find('.project-head').trigger('click')
    expect(w.find('.project-identity h2').text()).toBe('shop')
    expect(w.find('.project-tree').exists()).toBe(false)
    w.unmount()
  })

  it('a remote coordinator link follows the project identity above the bar, also when folded', async () => {
    const w = await mount(section({ coordinator: null, remote: { pane: 'abcd1234~w1:p1', machine: 'abcd1234' } }))
    expect(w.find('.project-lead').exists()).toBe(false)
    expect(w.element.firstElementChild?.classList.contains('project-identity')).toBe(true)
    expect(w.find('.project-identity h2').text()).toBe('shop')
    expect(w.find('.project-remote').text()).toContain('Coordinated from')
    navigate.mockClear()
    await w.find('.project-remote').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/a/abcd1234~w1%3Ap1')
    await w.find('.project-head').trigger('click')
    expect(w.find('.project-tree').exists()).toBe(false)
    expect(w.find('.project-remote').exists()).toBe(true)
    w.unmount()
  })

  it('a remote coordinator link switches the machine bar to its machine, shown again if hidden', async () => {
    for (const hidden of [false, true]) {
      const w = await mount(section({ coordinator: null, remote: { pane: 'abcd1234~w1:p1', machine: 'abcd1234' } }))
      herdrState.value = { ...herdrState.value, machines: [
        { key: '', label: 'Server', local: true, status: 'online', error: null },
        { key: 'abcd1234', label: 'Build box', local: false, status: 'online', error: null }] }
      machineBarHidden.value = hidden ? ['abcd1234'] : []
      machineBarSaved.value = ''
      expect(machineBarPick.value).toBe('')
      await w.find('.project-remote').trigger('click')
      expect(machineBarPick.value).toBe('abcd1234')
      expect(machineBarHidden.value).toEqual([])
      w.unmount()
    }
    machineBarSaved.value = '*'
  })

  it('a coordinator that asks something shows its question and answers in its row', async () => {
    const asking = { ...coord, status: 'blocked' as const, prompt: { question: 'Run the tests?', cursor: 0, options: [{ label: 'Yes', hint: null }, { label: 'No', hint: null }] } }
    for (const compact of [true, false]) {
      compactList.value = compact
      herdrState.value = { ok: true, workspaces: [], panes: [asking, ...workers] }
      const w = await mountSuspended(AgentCard, { props: { pane: asking, row: row(asking), board: { tag: '', name: 'shop', coordinator: true, lead: true } } })
      expect(w.find('.card-preview').text()).toBe('Run the tests?')
      expect(w.findAll('.card-choices button')).toHaveLength(2)
      w.unmount()
    }
  })

  it('a coordinator sharing its space with a terminal keeps its mark, in both list modes', async () => {
    const shell = pane('w1:p2', { agent: null, status: null })
    const state = { ok: true, workspaces: [{ id: 'w1', label: 'herdr-projects', number: 1, status: null, worktree: false }], panes: [coord, shell] }
    const shared = spaceRows(state)[0]!
    expect(shared.kind).toBe('space')
    for (const compact of [false, true]) {
      compactList.value = compact
      herdrState.value = { ...state, panes: [coord, shell, ...workers] }
      const w = await mountSuspended(ProjectGroup, { props: { group: section({ coordinator: shared }) }, global: { stubs: { UContextMenu: { template: '<div><slot /></div>' } } } })
      const card = w.find('.project-lead .card')
      expect(card.classes()).toContain('space-card')
      expect(card.find('.lead-mark.coord').exists()).toBe(true)
      expect(card.find('.space-avatar').exists()).toBe(false)
      w.unmount()
    }
  })

  it('a task under review: one row, its stage, the reviewer\'s tab opens', async () => {
    compactList.value = false
    // A task's space as herdr-projects lays it out: its "Agent" tab, then "Reviewer #1".
    const agent = pane('w7:p1', { tab: 'w7:t1', status: 'idle' })
    const reviewer = pane('w7:p2', { tab: 'w7:t2', agent: 'codex', status: 'working' })
    const tab = (id: string, label: string, number: number, p: Pane) => ({
      id, workspace: 'w7', label, number,
      layout: { tab: id, workspace: 'w7', zoomed: false, focused: p.id, area: { x: 0, y: 0, width: 80, height: 24 }, panes: [{ pane: p.id, rect: { x: 0, y: 0, width: 80, height: 24 } }], splits: [] },
    })
    const state = {
      ok: true, panes: [agent, reviewer],
      workspaces: [{ id: 'w7', label: 'SHOP-7 Payment recap', number: 7, status: null, worktree: true, repo: '/tmp/shop/.git', repoName: 'shop' }],
      tabs: [tab('w7:t1', 'Agent', 1, agent), tab('w7:t2', 'Reviewer #1', 2, reviewer)],
    }
    const file = { id: 'shop/7', title: 'Payment recap', stage: 'reviewing', watch: { progress: 60, msg: 'Reading the diff' }, link: { pane: 'w7:p1', workspace: 'w7', ownsWorkspace: true, reviewer: { pane: 'w7:p2', kind: 'codex' } } }
    const tasks = tasksFromFiles([linksFromTaskFile(file, () => '')!], { shop: 'SHOP' })
    const g = boardSections(spaceRows(state), state.workspaces, [{ machine: '', coordinators: [], tasks }], new Set(['w7:p1', 'w7:p2'])).projects[0]!
    herdrState.value = state
    // The Agent tab was the one opened last.
    noteTab('w7:t1')
    const w = await mountSuspended(ProjectGroup, { props: { group: g }, global: { stubs: { UContextMenu: { template: '<div><slot /></div>' } } } })
    const cards = w.findAll('.project-tree .card')
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.find('.home-task-tag').text()).toBe('SHOP-7')
    expect(card.find('.home-task-stage').text()).toBe('Under review')
    expect(card.find('.home-task-line').text()).toContain('Reading the diff')
    // Activity follows the reviewer; the main logo stays with the worker.
    expect(card.classes()).toContain('working')
    expect(card.find(':scope > .avatar').classes()).toContain('claude')
    expect(card.find('.task-agent-reviewer .avatar').classes()).toContain('codex')
    navigate.mockClear()
    await card.trigger('click')
    expect(navigate).toHaveBeenCalledWith({ path: '/board', query: { machine: '', task: 'shop/7', now: '1' } })
    w.unmount()
  })

  it('shows the current worker and who it took over from', async () => {
    const worker = pane('w8:p1', { agent: 'codex', status: 'working' })
    const current = { ...task(8, worker), identity: { agent: 'codex', reviewer: '', from: 'claude' } }
    const w = await mount(section({ members: [{ row: row(worker), task: current, role: 'worker' }] }))
    const card = w.find('.project-tree .card')
    expect(card.find(':scope > .avatar').classes()).toContain('codex')
    expect(card.find('.task-agent-from').text()).toContain('Took over from')
    expect(card.find('.task-agent-from .avatar').classes()).toContain('claude')
    expect(card.find('.task-agent-reviewer').exists()).toBe(false)
    w.unmount()
  })

  it('keeps each parallel attempt’s own agent logo', async () => {
    const attempt = pane('w8:p1', { agent: 'codex', status: 'working' })
    const parent = { ...task(8, attempt), identity: { agent: 'claude', reviewer: '', from: '' }, panes: [{ id: attempt.id, role: 'attempt' as const, letter: 'B' }] }
    const w = await mount(section({ members: [{ row: row(attempt), task: parent, role: 'attempt', letter: 'B' }] }))
    expect(w.find('.project-tree .card > .avatar').classes()).toContain('codex')
    w.unmount()
  })

  it('the normal list: the coordinator keeps the compact hierarchy, without its folder or last message', async () => {
    compactList.value = false
    const w = await mount(section())
    const card = w.find('.project-lead .card')
    expect(card.classes()).not.toContain('home-lead-big')
    expect(card.find('.card-where').exists()).toBe(false)
    expect(card.find('.home-task-line').exists()).toBe(false)
    expect(card.find('.card-preview').exists()).toBe(false)
    expect(card.text()).not.toContain('Two tasks under way.')
    // The tasks keep their activity line in the normal list.
    expect(w.find('.project-tree .card .home-task-line').text()).toContain('Doing 1')
    w.unmount()
  })
})

describe('a task row on the home list says what it is doing', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; compactList.value = true })
  // From the task's file, as the home list reads it (file -> link -> row).
  const rows = (stage: string, msg: string, watch: Record<string, unknown> = { progress: 40 }) => {
    const [linked] = tasksFromFiles([linksFromTaskFile({ id: 'shop/1', title: 'Task 1', stage, msg, watch, link: { pane: 'w2:p1' } }, () => '')!], { shop: 'SHOP' })
    return section({ members: [{ ...members[0]!, task: linked! }] })
  }

  it('an agent running: progress, no badge', async () => {
    const w = await mount(rows('working', 'Writing tests'))
    const card = w.find('.project-tree .card')
    expect(card.find('.task-activity').exists()).toBe(false)
    expect(card.find('.home-task-stats').text()).toContain('40%')
  })
  it('waiting for GitHub checks: a CI badge, no progress', async () => {
    const w = await mount(rows('merging', 'Waiting for GitHub checks · 1 of 2 passed'))
    const card = w.find('.project-tree .card')
    expect(card.find('.task-activity').text()).toBe('CI 1/2')
    expect(card.classes()).toContain('activity-ci')
    // The badge takes the place of its Working label.
    expect(card.find('.task-state').exists()).toBe(false)
    expect(card.text()).not.toMatch(/\d+%/)
  })
  it('waiting for CI with the reviewer\'s watcher kept after its review: CI, the task\'s own line', async () => {
    // The two-line list, which shows the task's line.
    compactList.value = false
    const w = await mount(rows('merging', 'Waiting for GitHub checks · 1 of 2 passed', { role: 'reviewer', msg: 'Reviewing the result', progress: 90 }))
    const card = w.find('.project-tree .card')
    expect(card.find('.task-activity').text()).toBe('CI 1/2')
    expect(card.classes()).toContain('activity-ci')
    expect(card.find('.home-task-line').text()).toContain('Waiting for GitHub checks · 1 of 2 passed')
    expect(card.text()).not.toContain('Reviewing the result')
    expect(card.text()).not.toMatch(/\d+%/)
  })
  it('queued: a QUEUED badge, the row dimmed, no progress', async () => {
    const w = await mount(rows('after', 'queued after SHOP-7'))
    const card = w.find('.project-tree .card')
    expect(card.find('.task-activity').text()).toBe('Queued · SHOP-7')
    expect(card.classes()).toContain('activity-queued')
    expect(card.text()).not.toMatch(/\d+%/)
  })
})
