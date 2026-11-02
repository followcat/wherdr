import { expect, test } from './test'
import fs from 'node:fs/promises'

// The home list and the Board say the same of a task: the state herdr-projects'
// CLI gives (`list --json`), not the stage in its file. Neutral fixtures only;
// no user's Board is read or written.
test('home cards and counters follow the Board\'s task state', async ({ page }, info) => {
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
  const base = await (await page.request.get('/api/state')).json()
  const keep = new Set(['w1', 'w2', 'w3'])
  // TV-9's agent has exited but its terminal still reads "working"; DEMO-5 works.
  const status: Record<string, string> = { w1: 'working', w2: 'working', w3: 'working' }
  const state = { ...base,
    workspaces: base.workspaces.filter((w: { id: string }) => keep.has(w.id)),
    tabs: base.tabs.filter((t: { workspace: string }) => keep.has(t.workspace)),
    panes: base.panes.filter((p: { workspace: string }) => keep.has(p.workspace))
      .map((p: { workspace: string }) => ({ ...p, status: status[p.workspace], prompt: undefined, screen: undefined, menu: undefined })),
  }
  await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
  await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
    version: 'board-state-fixture', machines: [{ machine: '', coordinators: [], tasks: [
      // The original pane is gone; a replacement terminal remains in the kept workspace.
      { id: 'demo/4', repo: 'demo', n: 4, key: 'DEMO-4', title: 'Finished cleanup', panes: [{ id: 'w3:p9', role: 'worker' }], workspace: 'w3', stage: 'done', group: 'done', progress: null, msg: 'Merged into main. Kept worktree.', since: null },
      { id: 'tv/9', repo: 'tv', n: 9, key: 'TV-9', title: 'Remote control pairing', panes: [{ id: 'w1:p1', role: 'worker' }], workspace: 'w1', stage: 'working', group: 'working', progress: 40, msg: 'Pairing', since: null },
      { id: 'demo/5', repo: 'demo', n: 5, key: 'DEMO-5', title: 'Simplify filters', panes: [{ id: 'w2:p1', role: 'worker' }], workspace: 'w2', stage: 'working', group: 'working', progress: 20, msg: 'Filters', since: null },
    ] }],
  } }))
  // Herdr alone first (no herdr-projects), then the board's own list.
  let cli = false
  const rows = [
    { id: 'demo/4', state: 'done', kind: '', stage: 'done', title: 'Finished cleanup', msg: 'Merged into main. Kept worktree.' },
    { id: 'tv/9', state: 'error', kind: '', stage: 'working', title: 'Remote control pairing', msg: 'The agent has exited' },
    { id: 'demo/5', state: 'working', kind: '', stage: 'working', title: 'Simplify filters', msg: 'Filters' },
    { id: 'demo/181', state: 'blocked', kind: 'permission', stage: 'approval', title: 'Approve the menu', msg: 'Ready to approve' },
  ]
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: cli
    ? { version: 'cli', machines: [{ machine: '', status: 'ready', version: '1.2.16', tasks: rows.map(r => ({ ...r, repo: r.id.split('/')[0], n: Number(r.id.split('/')[1]), app: 'claude', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, repoKey: r.id.startsWith('tv') ? 'TV' : 'DEMO', group: r.state === 'error' ? 'needs' : r.state === 'working' ? 'working' : r.state === 'done' ? 'done' : 'ready' })) }] }
    : { version: 'none', machines: [{ machine: '', status: 'missing', version: '', tasks: [] }] } }))
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'en'))

  const counters = async () => Object.fromEntries(await Promise.all(['blocked', 'working', 'done'].map(async s => [s, Number(await page.locator(`.stats .stat.${s} b`).textContent())])))
  const tv = page.locator('.project-tree .card', { hasText: 'TV-9' })

  await page.goto('/')
  await expect(tv).toBeVisible()
  await expect(page.locator('.stats .stat.working b')).toHaveText('2')
  expect(await counters()).toEqual({ blocked: 0, working: 2, done: 1 })
  await fs.mkdir('.shots', { recursive: true })
  await page.screenshot({ path: `.shots/home-board-state-before-${info.project.name}.png` })

  cli = true
  await page.goto('/')
  await expect(tv.locator('.task-state')).toHaveText('Needs you')
  await expect(tv.locator('.task-state')).not.toHaveText('Working')
  await expect(page.locator('.project-tree .card', { hasText: 'DEMO-5' }).locator('.task-state')).toHaveText('Working')
  // TV-9 (agent exited) and DEMO-181 (ready to approve, no pane) are the user's turn; each task once.
  await expect(page.locator('.stats .stat.blocked b')).toHaveText('2')
  expect(await counters()).toEqual({ blocked: 2, working: 1, done: 1 })
  const project = page.locator('.project', { hasText: 'DEMO-5' })
  await expect(project.locator('.project-bar')).toContainText('1 working')
  await expect(page.locator('.project-tree .card', { hasText: 'DEMO-4' }).locator('.task-state')).not.toHaveText('Working')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/home-board-state-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `.shots/home-board-state-after-${info.project.name}.png` })

  // The Board counts them the same way: your turn = needs you + ready to approve.
  await page.goto('/#/board')
  await expect(page.getByRole('button', { name: 'Needs you 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ready to approve 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Working 1', exact: true })).toBeVisible()
})

test('an independent working agent in a shared task workspace stays in the counter', async ({ page }) => {
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
  const base = await (await page.request.get('/api/state')).json()
  const template = base.panes.find((p: { id: string }) => p.id === 'w1:p1')
  const state = { ...base,
    workspaces: base.workspaces.filter((w: { id: string }) => w.id === 'w1'),
    tabs: base.tabs.filter((t: { id: string }) => t.id === template.tab),
    panes: [1, 2, 3].map(n => ({ ...template, id: `w1:p${n}`, status: 'working',
      name: n === 3 ? 'Independent worker' : `Finished worker ${n}`, prompt: undefined, screen: undefined, menu: undefined })),
  }
  const tasks = [1, 2].map(n => ({ id: `demo/${n}`, repo: 'demo', n, key: `DEMO-${n}`, title: `Finished task ${n}`,
    panes: [{ id: `w1:p${n}`, role: 'worker' }], workspace: 'w1', stage: 'done', group: 'done', progress: null, msg: '', since: null }))
  await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
  await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
    version: 'shared-workspace', machines: [{ machine: '', coordinators: [], tasks }],
  } }))
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: {
    version: 'shared-workspace', machines: [{ machine: '', status: 'ready', version: '1.2.21', tasks: [] }],
  } }))
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'en'))
  await page.goto('/')
  await expect(page.locator('.project-tree .task-state')).toHaveText(['Done', 'Done'])
  await expect(page.locator('.agent-group.working .card[data-pane="w1:p3"]')).toBeVisible()
  await expect(page.locator('.stats .stat.working b')).toHaveText('1')
  await expect(page.locator('.project-sum-working')).toHaveCount(0)
  await fs.mkdir('.shots', { recursive: true })
  await page.screenshot({ path: '.shots/home-shared-workspace-phone.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/home-shared-workspace-desktop.png' })
})
