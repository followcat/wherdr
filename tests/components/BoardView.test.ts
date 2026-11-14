import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody } from 'h3'
import BoardView from '~/components/BoardView.vue'
import { herdrState } from '~/composables/useHerdr'
import { answerConfirm, confirmState, menuState } from '~/composables/useUi'
import { boardColumns, cardOf, type Board } from '#shared/pm/board'
import { archivedMatch } from '#shared/pm/archive'
import { initialState, planSteps, type StepState } from '#shared/pm/steps'
import { company, vibe, wherdr } from '#shared/pm/examples'
import type { Run, Task } from '#shared/pm/run'
import type { Template } from '#shared/pm/workflow'
import type { Pane } from '#shared/types'
import { nextTick } from 'vue'
import { pick, select, selectLabels, selectValue } from '../helpers/select'
import { boardProject } from '~/composables/useBoardProject'
import { machineBarSaved, machineGroups } from '~/composables/useMachineBar'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

// Cards built by the same code as the server (server/utils/pmBoard.ts).
const run = (task: string, role: Run['role'], terminal: string): Run =>
  ({ id: `${task}-${role}`, task, role, program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'b', instructions: '/i', terminal, attempt: 1, state: 'running', startedAt: 1 })
const runs = [run('VIB-1', 'worker', 'host-a/t1'), run('CO-1', 'worker', 'host-a/t2'), run('CO-1', 'reviewer', 'host-a/t3')]
const at = (i: number, more: Partial<StepState> = {}): StepState => ({ ...initialState(), started: true, at: i, ...more })
const task = (id: string, step: StepState, more: Partial<Task> = {}): Task => ({ id, project: id.split('-')[0]!, title: `Task ${id}`, description: '', type: 'feature', state: 'working', step, createdAt: 1, ...more })
const columns = (t: Template) => boardColumns(Object.keys(t.taskTypes).map(type => planSteps(t, { type })))
const types = (t: Template) => Object.keys(t.taskTypes).map(id => ({ id, plan: planSteps(t, { type: id }).map(s => s.id).join(' → ') }))
const vibeTask = (id: string, step: StepState) => cardOf({ ...task(id, step), type: 'simple' }, planSteps(vibe, { type: 'simple' }), runs)
const coTask = (t: Task) => cardOf(t, planSteps(company, { type: 'feature' }), runs)

let board: Board
const reset = (co1: Partial<StepState> = {}) => {
  board = {
    projects: [{ key: 'VIB', name: 'Vibe', columns: columns(vibe), types: types(vibe) }, { key: 'CO', name: 'Company', columns: columns(company), types: types(company) }],
    cards: [
      cardOf(task('VIB-1', at(1), { type: 'simple', tags: ['client'], links: [{ label: 'Ticket', url: 'https://example.com/t/1' }, { label: 'PR', url: 'https://example.com/pr/2' }] }), planSteps(vibe, { type: 'simple' }), runs),
      coTask(task('CO-1', at(2, co1), {
        tags: ['CTP-1', 'client', 'x'], links: [{ label: 'PR', url: 'https://example.com/pr/1' }],
        log: [{ at: 1, by: 'coordinator CO', text: 'review: coordinator chose pass (advice: pass, nothing above minor). Only a naming nit is left.' }],
      })),
      coTask(task('CO-2', at(4, { yourTurn: { reason: 'user', badge: 'Merge the PR' } }))),
    ],
  }
}
reset()
registerEndpoint('/api/pm/board', () => board)
// Alfred has no autopilot: only a project's coordinator gets the header button.
// Vibe works on host-a, Company on host-b: the home tabs that show each (projectOnBar).
registerEndpoint('/api/pm/coordinators', () => [{ project: '_main', name: 'Alfred', main: true }, { project: 'VIB', name: 'Vibe', machines: ['host-a'], autopilot: { on: true, goal: '', events: [], perDay: 1, atOnce: 1 } }, { project: 'CO', name: 'Company', machines: ['host-b'] }])
const posts: { url: string, body: Record<string, unknown> }[] = []
// task: the new task, added to the board; task-start: refused (a limit) when `refuse` is set.
let refuse = ''
const answers: Record<string, (body: Record<string, unknown>) => unknown> = {
  '/api/pm/task': (b) => {
    const t = task(`${b.project}-9`, initialState(), { project: b.project as string, title: b.title as string, type: b.type as string, state: 'todo' })
    board.cards.push(cardOf(t, [], []))
    return { task: t }
  },
  '/api/pm/task-start': b => ({ task: { id: b.id, state: refuse ? 'waiting' : 'working', ...(refuse ? { waiting: refuse } : {}) } }),
}
for (const url of ['/api/pm/task-stop', '/api/pm/task-resume', '/api/pm/task-remove', '/api/pm/task', '/api/pm/task-start'])
  registerEndpoint(url, { method: 'POST', handler: async (e) => { const body = await readBody(e); posts.push({ url, body }); return answers[url]?.(body) ?? {} } })
const pane = (coreAddress: string, status: Pane['status']) => ({ id: coreAddress, coreAddress, status, agent: 'claude', workspace: 'w', tab: 't' }) as Pane
herdrState.value = { ok: true, workspaces: [], panes: [pane('host-a/t1', 'working'), pane('host-a/t2', 'idle'), pane('host-a/t3', 'working')] }

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset(); refuse = ''; posts.length = 0; boardProject.value = null; machineGroups.value = []; machineBarSaved.value = null })
const mount = async () => {
  const w = await mountSuspended(BoardView)
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="board-card"]')).toHaveLength(3))
  return w
}
const lanes = (w: Awaited<ReturnType<typeof mount>>) => w.findAll('[data-testid="board-lane"]').map(l => l.attributes('data-lane'))
const card = (w: Awaited<ReturnType<typeof mount>>, id: string) => w.find(`[data-task="${id}"]`)
const laneOf = (w: Awaited<ReturnType<typeof mount>>, id: string) => card(w, id).element.closest('[data-lane]')!.getAttribute('data-lane')

it('shows the columns of a template without review, and of all projects', async () => {
  const w = await mount()
  expect(lanes(w)).toEqual(['your-turn', 'todo', 'working', 'done'])
  expect(w.find('[data-testid="alfred"]').exists()).toBe(false) // no bar above the columns
  expect(w.find('[data-testid="coordinator-button"]').exists()).toBe(false) // All projects: no autopilot control
  await pick(w, 'board-project', 'VIB')
  expect(lanes(w)).toEqual(['your-turn', 'To do', 'Working', 'Done'])
  await vi.waitFor(() => expect(w.find('[data-testid="coordinator-button"]').exists()).toBe(true))
  expect(laneOf(w, 'VIB-1')).toBe('Working')
  await pick(w, 'board-project', 'CO')
  expect(lanes(w)).toEqual(['your-turn', 'To do', 'Working', 'Review', 'Deploy', 'Done'])
})

const shown = (w: Awaited<ReturnType<typeof mount>>) => w.findAll('[data-testid="board-card"]').map(c => c.attributes('data-task')).sort()

it('the project picker: All projects without groups; Follow machine tab once groups exist, in step with the home tab; the pick is kept', async () => {
  let w = await mount()
  expect(selectLabels(w, 'board-project')).toEqual(['Follow machine tab', 'All projects', 'Vibe', 'Company'])
  expect(selectValue(w, 'board-project')).toBe('all')
  w.unmount()
  machineGroups.value = [{ id: 'g1', name: 'Group A', machines: ['host-a'] }, { id: 'g2', name: 'Group B', machines: ['host-b'] }]
  machineBarSaved.value = 'g1'
  w = mounted = await mountSuspended(BoardView)
  await vi.waitFor(() => expect(shown(w)).toEqual(['VIB-1']))
  expect(selectValue(w, 'board-project')).toBe('follow')
  machineBarSaved.value = 'g2' // the home tab changes: the board follows, in place
  await vi.waitFor(() => expect(shown(w)).toEqual(['CO-1', 'CO-2']))
  machineBarSaved.value = '*'
  await vi.waitFor(() => expect(shown(w)).toEqual(['CO-1', 'CO-2', 'VIB-1']))
  expect(navigate).not.toHaveBeenCalled()
  await pick(w, 'board-project', 'all')
  expect(boardProject.value).toBe('all') // the synced setting, kept on the server
  w.unmount()
  w = mounted = await mountSuspended(BoardView) // a reload keeps All projects, groups or not
  machineBarSaved.value = 'g1'
  await vi.waitFor(() => expect(shown(w)).toEqual(['CO-1', 'CO-2', 'VIB-1']))
  expect(selectValue(w, 'board-project')).toBe('all')
})

it('shows the reviewer\'s state in review, and no indicator on a holder: none card', async () => {
  const w = await mount()
  const review = card(w, 'CO-1').find('[data-testid="holder-state"]')
  expect(review.attributes('aria-label')).toBe('Reviewer: Working')
  expect(review.classes()).toContain('working')
  expect(card(w, 'CO-1').text()).toContain('CTP-1')
  expect(card(w, 'CO-1').text()).toContain('+1')
  expect(card(w, 'CO-1').find('a').attributes('href')).toBe('https://example.com/pr/1')
  // Waiting for a merge by hand: no agent, no indicator, in Your turn with its badge and step.
  expect(card(w, 'CO-2').find('[data-testid="holder-state"]').exists()).toBe(false)
  expect(laneOf(w, 'CO-2')).toBe('your-turn')
  expect(card(w, 'CO-2').text()).toContain('Merge the PR')
  expect(card(w, 'CO-2').text()).toContain('merge')
})

it('moves a card to Your turn when its agent waits for the user', async () => {
  const before = herdrState.value
  herdrState.value = { ...before, panes: before.panes.map(p => (p.coreAddress === 'host-a/t1' ? { ...p, status: 'blocked' as const } : p)) }
  try {
    const w = await mount()
    expect(laneOf(w, 'VIB-1')).toBe('your-turn')
    expect(card(w, 'VIB-1').text()).toContain('Answer the agent')
    expect(card(w, 'VIB-1').find('[data-testid="holder-state"]').classes()).toContain('blocked')
    // WHR-145: a tap opens that agent's conversation; the task's sheet stays in the menu.
    navigate.mockReset()
    await card(w, 'VIB-1').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/a/host-a%2Ft1')
    expect(document.querySelector('[data-testid="task-panel"]')).toBeNull()
    await card(w, 'VIB-1').trigger('contextmenu')
    expect(menuState.items.map(i => ('label' in i ? i.label : '')).slice(0, 2)).toEqual(['Open the agent', 'Open the task'])
    menuState.open = false
    // A merge waiting for the user opens its sheet on To do.
    await card(w, 'CO-2').trigger('click')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="task-todo"]')).not.toBeNull())
  } finally { herdrState.value = before }
})

it('moves a card to Your turn whatever its step, and keeps its step and indicator', async () => {
  reset({ yourTurn: { reason: 'timeout', badge: 'Check review: over 90m' } })
  const w = await mount()
  await pick(w, 'board-project', 'CO')
  expect(laneOf(w, 'CO-1')).toBe('your-turn')
  expect(card(w, 'CO-1').text()).toContain('review')
  expect(card(w, 'CO-1').find('[data-testid="holder-state"]').exists()).toBe(true)
  expect(w.find('[data-lane="Review"]').findAll('[data-testid="board-card"]')).toHaveLength(0)
})

it('filters the board by tag, and the card\'s one-tap link is its PR', async () => {
  const w = await mount()
  expect(card(w, 'VIB-1').find('[data-testid="board-link"]').attributes('href')).toBe('https://example.com/pr/2')
  expect(selectLabels(w, 'board-tag')).toEqual(['Tags', 'CTP-1', 'client', 'x'])
  await pick(w, 'board-tag', 'client')
  expect(w.findAll('[data-testid="board-card"]').map(c => c.attributes('data-task'))).toEqual(['VIB-1', 'CO-1'])
  await pick(w, 'board-tag', 'x')
  expect(w.findAll('[data-testid="board-card"]').map(c => c.attributes('data-task'))).toEqual(['CO-1'])
})

it('a card shows its branch line only when it goes elsewhere than the project\'s working branch', async () => {
  board.projects[1]!.base = 'v3'
  board.cards[1] = { ...board.cards[1]!, branch: 'task/CO-1', pr: { base: 'develop' } }
  board.cards[2] = { ...board.cards[2]!, branch: 'task/CO-2', pr: { base: 'v3' } }
  const w = await mount()
  expect(card(w, 'CO-1').findAll('[data-testid="branch-line"] code').map(x => x.text())).toEqual(['task/CO-1', 'develop'])
  expect(card(w, 'CO-2').find('[data-testid="branch-line"]').exists()).toBe(false)
})

it('splits the task\'s sheet in tabs, Description first, one open at a time; History holds the coordinator\'s choice', async () => {
  const w = await mount()
  await card(w, 'CO-1').trigger('click')
  const q = (sel: string) => document.querySelector<HTMLElement>(sel)
  const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map(t => `${t.dataset.tab}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`)
  await vi.waitFor(() => expect(tabs()).toEqual(['description*', 'plan', 'comments', 'history']))
  expect(q('[data-testid="task-panel"] a[href="https://example.com/pr/1"]')).not.toBeNull()
  expect(q('[data-testid="task-plan"]')).toBeNull()
  q('[data-tab="history"]')!.click()
  await vi.waitFor(() => expect(tabs()).toEqual(['description', 'plan', 'comments', 'history*']))
  expect(q('[data-testid="task-history"]')!.textContent).toContain('Coordinator')
  expect(q('[data-testid="task-history"]')!.textContent).toContain('chose pass (advice: pass, nothing above minor). Only a naming nit is left.')
  expect(q('[data-testid="task-panel"] a[href="https://example.com/pr/1"]')).toBeNull()
  q('[data-tab="plan"]')!.click()
  await vi.waitFor(() => expect(q('[data-testid="task-plan"] [aria-current="step"]')).not.toBeNull())
  expect(q('[data-testid="task-stop"]')).not.toBeNull() // the actions stay above the tabs
})

it('stops a task from its sheet, after a confirmation with its reason', async () => {
  posts.length = 0
  const w = await mount()
  await card(w, 'VIB-1').trigger('click')
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await vi.waitFor(() => expect(q('task-stop')).not.toBeNull())
  q('task-stop')!.click()
  await vi.waitFor(() => expect(q('task-stop-confirm')?.textContent).toContain('nothing is merged'))
  const why = q('task-stop-why')!.querySelector('input') ?? q('task-stop-why') as HTMLInputElement
  ;(why as HTMLInputElement).value = 'it loops'
  why.dispatchEvent(new Event('input'))
  q('task-stop-yes')!.click()
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/task-stop', body: { id: 'VIB-1', why: 'it loops' } }]))
  expect(card(w, 'VIB-1').element.parentElement!.querySelector('[data-testid="card-menu"]')).not.toBeNull()
})

it('a stopped card waits in Your turn with who stopped it; its sheet offers Continue, Take it as it is, Archive', async () => {
  posts.length = 0
  const stopped = { by: 'the user', why: 'it loops', at: 3 }
  board.cards[0] = cardOf(task('VIB-1', at(1), { type: 'simple', state: 'waiting', waiting: 'Stopped by the user: it loops', stopped }), planSteps(vibe, { type: 'simple' }), [])
  const w = await mount()
  expect(laneOf(w, 'VIB-1')).toBe('your-turn')
  expect(card(w, 'VIB-1').text()).toContain('Stopped by the user: it loops')
  expect(card(w, 'VIB-1').find('[data-testid="holder-state"]').exists()).toBe(true)
  await card(w, 'VIB-1').trigger('click')
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resume]')).toHaveLength(3))
  expect(document.querySelector('[data-testid="task-stop"]')).toBeNull()
  expect([...document.querySelectorAll('[data-resume]')].map(b => b.textContent!.trim())).toEqual(['Continue', 'Take it as it is', 'Archive'])
  document.querySelector<HTMLElement>('[data-resume="continue"]')!.click()
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/task-resume', body: { id: 'VIB-1', how: 'continue' } }]))
})

it('a task never started offers Delete… in its menu, confirmed first; a started one does not', async () => {
  posts.length = 0
  board.cards[0] = cardOf(task('VIB-1', initialState(), { type: 'simple', state: 'todo' }), planSteps(vibe, { type: 'simple' }), [])
  const w = await mount()
  const menu = async (id: string) => { await card(w, id).element.parentElement!.querySelector<HTMLElement>('[data-testid="card-menu"]')!.click(); return menuState.items.map(i => ('label' in i ? i.label : '')) }
  expect(await menu('CO-1')).not.toContain('Delete…')
  expect(await menu('VIB-1')).toEqual(['Open', 'Start', 'Delete…'])
  const del = menuState.items.find(i => 'label' in i && i.label === 'Delete…')!
  expect(del).toMatchObject({ danger: true })
  ;(del as { run: () => void }).run()
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  expect(confirmState.message).toContain('It never started')
  answerConfirm(true)
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/task-remove', body: { id: 'VIB-1' } }]))
})

it('the card menu opens on long press and right click; its ••• button only when it has more than Open', async () => {
  board.cards[0] = cardOf(task('VIB-1', { ...initialState(), started: true, done: true }, { type: 'simple', state: 'done' }), planSteps(vibe, { type: 'simple' }), runs)
  const w = await mount()
  const dots = (id: string) => card(w, id).element.parentElement!.querySelector('[data-testid="card-menu"]')
  expect(dots('VIB-1')).toBeNull()
  expect(dots('CO-1')).not.toBeNull()
  // A still long press with a finger: the sheet, and the lifted finger does not open the task.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await card(w, 'VIB-1').trigger('pointerdown', { pointerType: 'touch', button: 0, clientX: 0, clientY: 0 })
    vi.advanceTimersByTime(720)
    await card(w, 'VIB-1').trigger('pointerup')
    await card(w, 'VIB-1').trigger('click')
  } finally { vi.useRealTimers() }
  expect(menuState.open).toBe(true)
  expect(menuState.items.map(i => ('label' in i ? i.label : ''))).toEqual(['Open'])
  expect(document.querySelector('[data-testid="task-stop"], [data-testid="task-history"]')).toBeNull()
  menuState.open = false
  // A mouse right click on a touch or narrow screen: the same sheet.
  await card(w, 'CO-1').trigger('pointerdown', { pointerType: 'mouse', button: 2 })
  await card(w, 'CO-1').trigger('contextmenu')
  expect(menuState.open).toBe(true)
  expect(menuState.items.map(i => ('label' in i ? i.label : ''))).toContain('Stop…')
  menuState.open = false
})

it('adds a task: project required on All projects, then title; the type shows its plan; Start now starts it; the card shows at once', async () => {
  const w = await mount()
  await w.find('[data-testid="board-add"]').trigger('click')
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await vi.waitFor(() => expect(q('add-task')).not.toBeNull())
  const sheet = w.findComponent({ name: 'AddTaskSheet' })
  const errors = () => [...document.querySelectorAll('[data-testid="add-task-error"]')].map(e => e.textContent!.trim())
  expect(errors()).toEqual([]) // nothing said before the user tries
  q('add-task-submit')!.click()
  await vi.waitFor(() => expect(errors()).toEqual(['Pick a project', 'Give it a title']))
  await pick(sheet, 'add-task-project', 'CO')
  await vi.waitFor(() => expect(errors()).toEqual(['Give it a title']))
  expect(selectLabels(sheet, 'add-task-type')).toEqual(Object.keys(company.taskTypes))
  expect(q('add-task-plan')!.textContent).toBe(types(company)[0]!.plan)
  const title = q('add-task-title')!.querySelector('input') ?? q('add-task-title') as HTMLInputElement
  ;(title as HTMLInputElement).value = '  Fix the login  '
  title.dispatchEvent(new Event('input'))
  sheet.findComponent({ name: 'USwitch' }).vm.$emit('update:modelValue', true)
  await vi.waitFor(() => expect(errors()).toEqual([]))
  expect(posts).toEqual([])
  q('add-task-submit')!.click()
  await vi.waitFor(() => expect(posts.map(p => p.url)).toEqual(['/api/pm/task', '/api/pm/task-start']))
  expect(posts[0]!.body).toEqual({ project: 'CO', title: 'Fix the login', type: Object.keys(company.taskTypes)[0], description: '' })
  expect(posts[1]!.body).toEqual({ id: 'CO-9' })
  await vi.waitFor(() => expect(card(w, 'CO-9').exists()).toBe(true))
})

it('the board\'s project is preselected; a task after others posts them and its weight, and does not start now', async () => {
  board.projects[1]!.types[0]!.weight = 'heavy (screenshots)'
  board.cards[2] = coTask(task('CO-2', initialState(), { state: 'todo' }))
  const w = await mount()
  await pick(w, 'board-project', 'CO')
  await w.find('[data-testid="board-add"]').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="add-task"]')).not.toBeNull())
  const sheet = w.findComponent({ name: 'AddTaskSheet' })
  expect(selectValue(sheet, 'add-task-project')).toBe('CO')
  expect(selectLabels(sheet, 'add-task-after')).toEqual(['CO-1 · Task CO-1', 'CO-2 · Task CO-2']) // the same project's, not done
  select(sheet, 'add-task-after').vm.$emit('update:modelValue', ['CO-1', 'CO-2'])
  expect(selectLabels(sheet, 'add-task-weight')).toEqual(['Auto: heavy (screenshots)', 'Light', 'Standard', 'Heavy'])
  select(sheet, 'add-task-weight').vm.$emit('update:modelValue', 'light')
  sheet.findComponent({ name: 'UInput' }).vm.$emit('update:modelValue', 'Then deploy')
  sheet.findComponent({ name: 'USwitch' }).vm.$emit('update:modelValue', true)
  await nextTick()
  document.querySelector<HTMLElement>('[data-testid="add-task-submit"]')!.click()
  await vi.waitFor(() => expect(posts.map(p => p.url)).toEqual(['/api/pm/task']))
  expect(posts[0]!.body).toMatchObject({ project: 'CO', title: 'Then deploy', after: 'CO-1,CO-2', weight: 'light' })
})

it('Start on a To do card (menu and sheet) says the server\'s refusal; a task after an open one shows what it waits for instead', async () => {
  board.cards[0] = cardOf(task('VIB-1', initialState(), { type: 'simple', state: 'todo' }), planSteps(vibe, { type: 'simple' }), [])
  board.cards.push(coTask(task('CO-3', initialState(), { state: 'todo', after: 'CO-1' })))
  refuse = 'Autopilot limit: 2 tasks working at most'
  const w = await mountSuspended(BoardView)
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="board-card"]')).toHaveLength(4))
  const menu = async (id: string) => { await card(w, id).element.parentElement!.querySelector<HTMLElement>('[data-testid="card-menu"]')!.click(); return menuState.items.map(i => ('label' in i ? i.label : '')) }
  expect(await menu('VIB-1')).toEqual(['Open', 'Start', 'Delete…'])
  ;(menuState.items.find(i => 'label' in i && i.label === 'Start') as { run: () => void }).run()
  await vi.waitFor(() => expect(w.find('.error').text()).toBe(refuse))
  expect(posts).toEqual([{ url: '/api/pm/task-start', body: { id: 'VIB-1' } }])
  expect(card(w, 'CO-3').find('[data-testid="board-waits"]').text()).toBe('Waits for CO-1')
  expect(await menu('CO-3')).not.toContain('Start')
  menuState.open = false
  await card(w, 'CO-3').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="task-waits"]')?.textContent).toBe('Starts once CO-1 is done.'))
  expect(document.querySelector('[data-testid="task-start"]')).toBeNull()
})

it('Start on… lists the machines a project allows, starts on the one picked and says why it is not ready', async () => {
  board.projects[0]!.machines = [{ key: '', label: 'machine-a', online: true }, { key: 'b', label: 'machine-b', online: true, unready: 'gh login: not logged in' }, { key: 'c', label: 'machine-c', online: false }]
  board.cards[0] = cardOf(task('VIB-1', initialState(), { type: 'simple', state: 'todo' }), planSteps(vibe, { type: 'simple' }), [])
  refuse = 'machine-b is not ready for this project: gh login: not logged in'
  const w = await mount()
  await card(w, 'VIB-1').element.parentElement!.querySelector<HTMLElement>('[data-testid="card-menu"]')!.click()
  ;(menuState.items.find(i => i.label === 'Start on…')!).run!()
  expect(menuState.items.map(i => [i.label, i.desc, !!i.disabled])).toEqual([
    ['machine-a', 'The project\'s own machine', false], ['machine-b', 'Not ready: gh login: not logged in', false], ['machine-c', 'Offline', true]])
  menuState.items[1]!.run!()
  await vi.waitFor(() => expect(w.find('.error').text()).toBe(refuse))
  expect(posts).toEqual([{ url: '/api/pm/task-start', body: { id: 'VIB-1', machine: 'b' } }])
})

it('a task the engine resumes after an incident shows why it waits, not Your turn; its follower waits for it to resume', async () => {
  const why = 'The agent\'s terminal is gone: the machine is offline or unreachable (its herdr-core does not answer) (host-b): wherdr resumes it once host-b is back'
  board.cards[1] = coTask(task('CO-1', at(2), { state: 'waiting', waiting: why, run: 'r1', recovery: { incident: 'i1', cause: 'offline', machine: 'b', label: 'host-b', run: 'r1', at: 1, n: 1, waits: true } }))
  board.cards.push(coTask(task('CO-3', initialState(), { state: 'todo', after: 'CO-1', held: 'Waits for CO-1 to resume' })))
  const w = await mountSuspended(BoardView)
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="board-card"]')).toHaveLength(4))
  expect(laneOf(w, 'CO-1')).not.toBe('your-turn')
  expect(card(w, 'CO-1').find('[data-testid="board-status"]').text()).toBe(why)
  expect(card(w, 'CO-3').find('[data-testid="board-status"]').text()).toBe('Waits for CO-1 to resume')
})

it('an accepted merge leaves Your turn, Merging loading with its queue place, until it merges', async () => {
  // A merge step the user approves (github.merge): the engine merges it once ready.
  const merge = (step: Partial<StepState>, more: Partial<Task> = {}) => cardOf(task('CO-2', at(4, { approved: { by: 'user', at: 1 }, ...step }), { type: 'visual', ...more }), planSteps(wherdr, { type: 'visual' }), runs)
  board.cards[2] = merge({}, { queue: 2 })
  let w = await mount()
  expect(laneOf(w, 'CO-2')).not.toBe('your-turn')
  expect(card(w, 'CO-2').get('[data-testid="board-merging"]').text()).toBe('Merging')
  expect(card(w, 'CO-2').get('[data-testid="board-status"]').text()).toBe('Approved, merges by itself · 2nd in merge queue')
  w.unmount()
  board.cards[2] = merge({ done: true })
  w = await mount()
  expect(laneOf(w, 'CO-2')).not.toBe('your-turn')
  expect(card(w, 'CO-2').find('[data-testid="board-merging"]').exists()).toBe(false)
})

// The archived tasks the Done column's footer lists, and the searches asked.
const archived: ReturnType<typeof coTask>[] = [], asked: string[] = []
registerEndpoint('/api/pm/archived', (e) => {
  const q = String(getQuery(e).q ?? ''), cards = archived.filter(c => archivedMatch(c, q))
  asked.push(q)
  return { cards, total: cards.length }
})

it('the Done column\'s footer counts archived tasks and opens their sheet, which a search filters', async () => {
  archived.push(coTask(task('CO-7', at(4, { done: true }), { title: 'Old login fix', archived: 2 })), coTask(task('CO-8', at(4, { done: true }), { title: 'Docs pass', tags: ['docs'], archived: 1 })))
  board.archived = { CO: 2 }
  const w = await mount()
  const footer = w.find('[data-lane="done"] [data-testid="board-archived"]')
  expect(footer.text()).toBe('2 archived · show')
  await footer.trigger('click')
  const rows = () => [...document.body.querySelectorAll('[data-testid="archived-row"]')].map(r => r.getAttribute('data-task'))
  await vi.waitFor(() => expect(rows()).toEqual(['CO-7', 'CO-8']))
  const search = document.body.querySelector<HTMLInputElement>('[data-testid="archived-search"] input, input[data-testid="archived-search"]')!
  search.value = 'docs'
  search.dispatchEvent(new Event('input'))
  await vi.waitFor(() => expect(rows()).toEqual(['CO-8']))
  expect(asked.at(-1)).toBe('docs')
})
