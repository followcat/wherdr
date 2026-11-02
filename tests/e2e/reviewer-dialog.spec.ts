import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_PANE, OMP_APPROVAL_PANE, SOCK_FILE, fakeHerdr } from './scenario.mjs'

// WHR-75: the task's reviewer, not its agent, shows a dialog (herdr-projects
// stage `reviewneeds`). The banner opens the reviewer's pane, says plainly
// when it cannot be reached or its dialog is gone; an agent's own dialog keeps
// today's buttons. All data is fictional.
const REVIEW_MSG = 'The reviewer shows a dialog: open it and answer'
const task = { id: 'shop/75', title: 'Cache the product images', stage: 'reviewneeds', state: 'blocked', kind: '', app: 'claude', msg: REVIEW_MSG, pr: 'https://github.com/example/shop/pull/512' }

const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const taskDir = path.join(home, '.herdr-projects/data/tasks/shop/75')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-reviewer-'))
fs.mkdirSync(path.join(root, 'bin'))
const write = (row: Record<string, unknown>, link: Record<string, unknown> = { pane: CLAUDE_PANE, reviewer: { pane: OMP_APPROVAL_PANE, kind: 'omp' } }) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([row]))
  fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { ...row, description: 'Serve product images from a cache.' } }))
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ ...row, link }))
}
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
case "$1" in
  list) cat '${root}/list.json' ;;
  details) cat '${root}/details.json' ;;
  coordinator) echo '{"state":"none","pane":""}' ;;
  show) echo '{"settings":[],"problems":[]}' ;;
  *) echo ok ;;
esac
`, { mode: 0o755 })
const plugin = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.1', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }

test.beforeEach(async () => {
  write(task)
  await fakeHerdr('e2e.plugins', { plugins: [plugin] })
})
test.afterEach(async () => {
  await fakeHerdr('e2e.pane_status', { pane_id: OMP_APPROVAL_PANE, status: 'blocked' })
  await fakeHerdr('e2e.plugins', { plugins: [] })
  fs.rmSync(taskDir, { recursive: true, force: true })
})
// The server reuses this board's list for REUSE_MS (5 s): the next spec
// file must not see it.
test.afterAll(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  await new Promise(r => setTimeout(r, 5500))
})

const OPEN = '/#/board?machine=&task=shop%2F75'
// The server reuses a board's list for a few seconds: open the task again
// until the row just written shows.
async function shows(page: Page, button: string) {
  const got = page.locator('.board-panel .task-needs .task-needs-actions button')
  await expect(async () => {
    await page.goto('about:blank')
    await page.goto(OPEN)
    await expect(got).toHaveText([button], { timeout: 2000 })
  }).toPass({ timeout: 25_000 })
}

async function desktopShot(page: Page, file: string) {
  const phone = page.viewportSize()!
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: file })
  await page.setViewportSize(phone)
}

test('a reviewer\'s dialog: the banner opens the reviewer, never the agent', async ({ page }, testInfo) => {
  await page.goto(OPEN)
  const panel = page.locator('.board-panel')
  const banner = panel.locator('.task-needs')
  await expect(banner.locator('h3')).toHaveText(`Needs you · ${REVIEW_MSG}`)
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Open the reviewer'])
  await expect(banner.getByRole('button', { name: 'Answer in the conversation' })).toHaveCount(0)
  await expect(banner.getByRole('button', { name: 'Open terminal' })).toHaveCount(0)
  await page.screenshot({ path: `.shots/reviewer-banner-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/reviewer-banner-desktop.png')

  await banner.getByRole('button', { name: 'Open the reviewer' }).click()
  const tabs = panel.locator('.board-panel-tabs')
  await expect(tabs.getByRole('button', { name: 'Reviewer', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.board-panel-reviewer-who')).toContainText('Reviewer')
  // The reviewer's own conversation, not the agent's.
  await expect(panel.locator('.chat')).toContainText('Clean the build folder.')
  await page.screenshot({ path: `.shots/reviewer-open-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/reviewer-open-desktop.png')
  // Its terminal, where the dialog is on screen.
  await panel.locator('.board-panel-reviewer-mode').click()
  await expect(panel.locator('#term')).toBeVisible()

  // The dialog answered elsewhere, the board not caught up yet.
  await fakeHerdr('e2e.pane_status', { pane_id: OMP_APPROVAL_PANE, status: 'idle' })
  await expect(banner.locator('.task-needs-reviewer')).toHaveText('The reviewer shows no dialog now: the board moves on by itself in a few seconds.')
})

test('a reviewer wherdr cannot reach, or whose pane is closed: said plainly (legacy French preference)', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  const banner = page.locator('.board-panel .task-needs')
  // Its session is not open in wherdr.
  write(task, { socket: '/elsewhere/.config/herdr/sessions/other/herdr.sock', pane: CLAUDE_PANE, reviewer: { pane: OMP_APPROVAL_PANE } })
  await shows(page, 'Task actions')
  await expect(banner.locator('.task-needs-reviewer')).toContainText('wherdr cannot reach the reviewer’s pane. Answer it on')
  await expect(page.locator('.board-panel-tabs').getByRole('button', { name: 'Reviewer' })).toHaveCount(0)
  await page.screenshot({ path: `.shots/reviewer-away-fr-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/reviewer-away-fr-desktop.png')

  // Its pane closed: no dialog left; the task's actions instead.
  write(task, { pane: CLAUDE_PANE, reviewer: { pane: 'w98:p1' } })
  await expect(async () => {
    await page.goto('about:blank')
    await page.goto(OPEN)
    await expect(banner.locator('.task-needs-reviewer')).toHaveAttribute('data-wait', 'gone', { timeout: 2000 })
  }).toPass({ timeout: 25_000 })
  await expect(banner.locator('.task-needs-reviewer')).toContainText('The reviewer’s pane is closed')
  await page.screenshot({ path: `.shots/reviewer-gone-fr-${testInfo.project.name}.png` })
  await banner.getByRole('button', { name: 'Task actions' }).click()
  await expect(page.locator('.board-panel-tabs').getByRole('button', { name: 'Task' })).toHaveAttribute('aria-pressed', 'true')
})

test('an agent\'s own dialog keeps its buttons', async ({ page }) => {
  write({ ...task, stage: 'working', msg: 'Waiting for your answer' }, { pane: CLAUDE_PANE })
  await shows(page, 'Open terminal')
  await expect(page.locator('.board-panel .task-needs-reviewer')).toHaveCount(0)
  await expect(page.locator('.board-panel-tabs').getByRole('button', { name: 'Reviewer' })).toHaveCount(0)
})

// Review finding: the reviewer's pane open in a session this device does not
// show (two sessions of one machine, "default" shown) is not a closed pane.
test('a reviewer in a session this device does not show: switch to it, then answer', async ({ page }, testInfo) => {
  const HIDDEN = `abcdef01~${OMP_APPROVAL_PANE}`
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
  const base = await (await page.request.get('/api/state')).json()
  const inReview = (w: string) => w === OMP_APPROVAL_PANE.split(':')[0]
  const state = { ...base,
    machines: [{ key: '', label: 'devbox', local: true, status: 'online', error: null, session: 'default' }, { key: 'abcdef01', baseKey: '', label: 'devbox', local: true, status: 'online', error: null, session: 'review' }],
    workspaces: base.workspaces.map((w: { id: string }) => inReview(w.id) ? { ...w, id: `abcdef01~${w.id}`, machine: 'abcdef01' } : { ...w, machine: '' }),
    tabs: base.tabs.map((t: { id: string, workspace: string }) => inReview(t.workspace) ? { ...t, id: `abcdef01~${t.id}`, workspace: `abcdef01~${t.workspace}`, machine: 'abcdef01' } : { ...t, machine: '' }),
    panes: base.panes.map((p: { id: string, workspace: string, tab: string }) => inReview(p.workspace) ? { ...p, id: HIDDEN, workspace: `abcdef01~${p.workspace}`, tab: `abcdef01~${p.tab}`, machine: 'abcdef01', status: 'blocked' } : { ...p, machine: '' }),
  }
  await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
  await page.route('**/api/tasks/details**', async (route) => {
    const r = await route.fetch()
    await route.fulfill({ response: r, json: { ...await r.json(), reviewer: { pane: HIDDEN } } })
  })
  let asked: unknown = null
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    asked = route.request().postDataJSON()
    await route.fulfill({ json: { session: { name: 'review', key: 'abcdef01', running: true } } })
  })
  await page.addInitScript(() => localStorage.setItem('machineSessions', JSON.stringify({ '': 'default' })))
  await page.goto(OPEN)
  const banner = page.locator('.board-panel .task-needs')
  await expect(banner.locator('.task-needs-reviewer')).toHaveAttribute('data-wait', 'hidden')
  await expect(banner.locator('.task-needs-reviewer')).toHaveText('The reviewer runs in the session “review”, which this device does not show. Switch to it to answer.')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Switch to that session'])
  await page.screenshot({ path: `.shots/reviewer-hidden-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/reviewer-hidden-desktop.png')

  await banner.getByRole('button', { name: 'Switch to that session' }).click()
  expect(asked).toEqual({ machine: '', name: 'review' })
  await expect(page.locator('.board-panel-tabs').getByRole('button', { name: 'Reviewer', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Its pane is shown now, waiting on its dialog (its conversation is served
  // by a session this test only fakes in the browser).
  await expect(page.locator('.board-panel-reviewer-who')).toHaveText('Reviewer · Your turn')
  await expect(page.locator('.board-panel .task-needs-reviewer')).toHaveCount(0)
})
