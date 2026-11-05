import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import BoardView from '~/components/BoardView.vue'
import { herdrState } from '~/composables/useHerdr'
import { boardColumns, cardOf, type Board } from '#shared/pm/board'
import { initialState, planSteps, type StepState } from '#shared/pm/steps'
import { company, vibe } from '#shared/pm/examples'
import type { Run, Task } from '#shared/pm/run'
import type { Template } from '#shared/pm/workflow'
import type { Pane } from '#shared/types'

// Cards built by the same code as the server (server/utils/pmBoard.ts).
const run = (task: string, role: Run['role'], terminal: string): Run =>
  ({ id: `${task}-${role}`, task, role, program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'b', instructions: '/i', terminal, attempt: 1, state: 'running', startedAt: 1 })
const runs = [run('VIB-1', 'worker', 'host-a/t1'), run('CO-1', 'worker', 'host-a/t2'), run('CO-1', 'reviewer', 'host-a/t3')]
const at = (i: number, more: Partial<StepState> = {}): StepState => ({ ...initialState(), started: true, at: i, ...more })
const task = (id: string, step: StepState, more: Partial<Task> = {}): Task => ({ id, project: id.split('-')[0]!, title: `Task ${id}`, description: '', type: 'feature', state: 'working', step, createdAt: 1, ...more })
const columns = (t: Template) => boardColumns(Object.keys(t.taskTypes).map(type => planSteps(t, { type })))
const vibeTask = (id: string, step: StepState) => cardOf({ ...task(id, step), type: 'simple' }, planSteps(vibe, { type: 'simple' }), runs)
const coTask = (t: Task) => cardOf(t, planSteps(company, { type: 'feature' }), runs)

let board: Board
const reset = (co1: Partial<StepState> = {}) => {
  board = {
    projects: [{ key: 'VIB', name: 'Vibe', columns: columns(vibe) }, { key: 'CO', name: 'Company', columns: columns(company) }],
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
registerEndpoint('/api/pm/coordinators', () => [])
const pane = (coreAddress: string, status: Pane['status']) => ({ id: coreAddress, coreAddress, status, agent: 'claude', workspace: 'w', tab: 't' }) as Pane
herdrState.value = { ok: true, workspaces: [], panes: [pane('host-a/t1', 'working'), pane('host-a/t2', 'idle'), pane('host-a/t3', 'working')] }

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset() })
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
  await w.find('[data-testid="board-project"]').setValue('VIB')
  expect(lanes(w)).toEqual(['your-turn', 'To do', 'Working', 'Done'])
  expect(laneOf(w, 'VIB-1')).toBe('Working')
  await w.find('[data-testid="board-project"]').setValue('CO')
  expect(lanes(w)).toEqual(['your-turn', 'To do', 'Working', 'Review', 'Deploy', 'Done'])
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
  } finally { herdrState.value = before }
})

it('moves a card to Your turn whatever its step, and keeps its step and indicator', async () => {
  reset({ yourTurn: { reason: 'timeout', badge: 'Check review: over 90m' } })
  const w = await mount()
  await w.find('[data-testid="board-project"]').setValue('CO')
  expect(laneOf(w, 'CO-1')).toBe('your-turn')
  expect(card(w, 'CO-1').text()).toContain('review')
  expect(card(w, 'CO-1').find('[data-testid="holder-state"]').exists()).toBe(true)
  expect(w.find('[data-lane="Review"]').findAll('[data-testid="board-card"]')).toHaveLength(0)
})

it('filters the board by tag, and the card\'s one-tap link is its PR', async () => {
  const w = await mount()
  expect(card(w, 'VIB-1').find('[data-testid="board-link"]').attributes('href')).toBe('https://example.com/pr/2')
  expect(w.findAll('[data-testid="board-tag"] option').map(o => o.text())).toEqual(['Tags', 'CTP-1', 'client', 'x'])
  await w.find('[data-testid="board-tag"]').setValue('client')
  expect(w.findAll('[data-testid="board-card"]').map(c => c.attributes('data-task'))).toEqual(['VIB-1', 'CO-1'])
  await w.find('[data-testid="board-tag"]').setValue('x')
  expect(w.findAll('[data-testid="board-card"]').map(c => c.attributes('data-task'))).toEqual(['CO-1'])
})

it('shows the coordinator\'s choice and its reason in the task\'s log', async () => {
  const w = await mount()
  await card(w, 'CO-1').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="task-log"]')?.textContent).toContain('coordinator CO'))
  expect(document.querySelector('[data-testid="task-log"]')!.textContent).toContain('chose pass (advice: pass, nothing above minor). Only a naming nit is left.')
})
