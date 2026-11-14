// WHR-113: a task's sheet opens over the page the user is on (?task=ID on the
// current route), not on the board; closing leaves that page as it was. The
// board keeps its own sheet.
import { expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery } from 'h3'
import { useRouter } from '#app'
import TaskSheetHost from '~/components/TaskSheetHost.vue'
import { initialState } from '#shared/pm/steps'
import type { Board, Card } from '#shared/pm/board'

const card: Card = {
  id: 'CO-4', project: 'CO', title: 'Fix login redirect', description: '', column: 'To do', phase: 'todo', step: '', holder: 'none',
  tags: [], links: [], log: [], plan: [], state: initialState(),
}
// Started, with a branch and no step naming a target: it goes to the project's working branch.
const branched: Card = { ...card, id: 'CO-5', title: 'Branched task', phase: 'working', branch: 'task/CO-5', state: { ...initialState(), started: true } }
registerEndpoint('/api/pm/board', (): Partial<Board> => ({ cards: [card, branched], projects: [{ key: 'CO', base: 'v3', name: 'Company', columns: [], types: [] }] }))
const sheet = () => document.querySelector('[data-testid="task-sheet"]')

it('opens over the current page and closing returns to it', async () => {
  const w = await mountSuspended(TaskSheetHost, { route: '/settings?section=phone' })
  const router = useRouter()
  await openTaskSheet('CO-4')
  expect(router.currentRoute.value.fullPath).toBe('/settings?section=phone&task=CO-4')
  await expect.poll(sheet).not.toBeNull()
  expect(document.body.textContent).toContain('Fix login redirect')
  closeTaskSheet()
  await expect.poll(() => router.currentRoute.value.fullPath).toBe('/settings?section=phone')
  await expect.poll(sheet).toBeNull()
  // A linked or reloaded sheet (no entry of ours behind it): only ?task goes.
  await router.replace('/settings?section=phone&task=CO-4')
  await expect.poll(sheet).not.toBeNull()
  closeTaskSheet()
  await expect.poll(() => router.currentRoute.value.fullPath).toBe('/settings?section=phone')
  w.unmount()
})

it('leaves the board to its own sheet', async () => {
  const w = await mountSuspended(TaskSheetHost, { route: '/board?task=CO-4' })
  await new Promise(r => setTimeout(r, 50))
  expect(w.html()).not.toContain('task-sheet')
  expect(sheet()).toBeNull()
  w.unmount()
})

// WHR-230: the board leaves archived tasks out; a link to one reads its card on its own.
it('opens an archived task from a link, with Unarchive', async () => {
  registerEndpoint('/api/pm/archived', (e): { card: Card | null } => ({ card: getQuery(e).id === 'CO-7' ? { ...card, id: 'CO-7', title: 'Old login fix', phase: 'done', archived: 1 } : null }))
  const w = await mountSuspended(TaskSheetHost, { route: '/settings?section=phone&task=CO-7' })
  await expect.poll(sheet).not.toBeNull()
  expect(document.body.textContent).toContain('Old login fix')
  expect(document.querySelector('[data-testid="task-unarchive"]')).not.toBeNull()
  closeTaskSheet()
  await expect.poll(sheet).toBeNull()
  w.unmount()
})

// A sheet opened off the board still knows the project's working branch.
it('shows the branch line with the project\'s working branch', async () => {
  const w = await mountSuspended(TaskSheetHost, { route: '/settings?task=CO-5' })
  await expect.poll(() => document.querySelector('[data-testid="branch-base"]')?.textContent).toBe('v3')
  expect(document.querySelector('[data-testid="branch-head"]')?.textContent).toBe('task/CO-5')
  closeTaskSheet()
  await expect.poll(sheet).toBeNull()
  w.unmount()
})
