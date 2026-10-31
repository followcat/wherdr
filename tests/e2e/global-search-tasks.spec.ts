import fs from 'node:fs/promises'
import { expect, test, type Page } from './test'

// Global search finds a Board task by its name and opens it on the Board.
const task = { id: 'wherdr/12', repo: 'wherdr', n: 12, state: 'working', kind: '', stage: 'working', title: 'Fix the login redirect', msg: '',
  app: 'claude', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'working', repoKey: 'WHR' }
const hit = { machine: '', id: task.id, key: 'WHR-12', repo: 'wherdr', title: task.title, stage: 'working', group: 'working', field: 'id' }
const other = { ...hit, id: 'wherdr/121', key: 'WHR-121', title: 'Session cookie', stage: 'todo', group: 'todo', field: 'description', excerpt: 'the login cookie expires too early' }

async function routes(page: Page) {
  await page.route(/\/api\/search\?/, route => route.fulfill({ json: { hits: [], limited: false, tasks: [hit, other] } }))
  await page.route('**/api/tasks/details**', route => route.fulfill({ json: { id: task.id, title: task.title, stage: 'working', pane: null, agent: 'claude' } }))
  await page.route(/\/api\/tasks(\?.*)?$/, route => route.fulfill({ json: { version: 'v-search', machines: [{ machine: '', status: 'ready', version: '1.2.1', at: Date.now(), tasks: [task] }] } }))
}

test('a task id finds the task, with its machine, project and state, and opens it on the Board', { tag: ['@chromium-desktop'] }, async ({ page }, testInfo) => {
  await routes(page)
  await page.goto('/#/')
  await page.getByRole('button', { name: 'Search agents and conversations', exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Search agents and conversations' }).fill('WHR-12')
  const group = page.getByRole('group', { name: 'Tasks' })
  const first = group.getByRole('option').first()
  await expect(first).toContainText('WHR-12')
  await expect(first).toContainText('Fix the login redirect')
  await expect(first).toContainText('Working')
  await expect(first).toContainText('wherdr')
  await expect(first.locator('.global-search-machine')).toHaveText(/\S/)
  await expect(group.getByRole('option').nth(1)).toContainText('the login cookie expires too early')
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await fs.mkdir('.shots', { recursive: true })
  await page.screenshot({ path: `.shots/global-search-tasks-${testInfo.project.name}.png` })
  await page.keyboard.press('Enter')
  await expect(page.locator('.global-search')).toHaveCount(0)
  await expect.poll(() => decodeURIComponent(page.url()).split('#')[1]).toMatch(/^\/board/)
  await expect(page.locator('.board-panel[data-kind="task"] .board-panel-title')).toHaveText('Fix the login redirect')
})
