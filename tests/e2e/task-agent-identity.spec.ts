import { expect, test } from './test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_PANE, CLAUDE_ASK_PANE, CODEX_UPDATE_PANE, SOCK_FILE, fakeHerdr } from './scenario.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'))
const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const dir = path.join(home, '.herdr-projects/data/tasks/demo/82')
const fallbackDir = path.join(home, '.herdr-projects/data/tasks/demo/83')
const handovers = [
  { at: 1700000000000, role: 'worker', from: 'codex/gpt', to: 'claude/opus', why: 'Out of allowance until tomorrow. The task continues with the next available agent.' },
  { at: 1700000060000, role: 'reviewer', from: 'claude/opus', to: 'codex/gpt', why: 'Review rounds exhausted' },
  { role: 'reviewer', why: 'Provider temporarily unavailable' },
]
const fallback = { id: 'demo/83', title: 'Cache product images', app: 'claude', agent: 'claude', on: 'claude/opus', stage: 'working', state: 'working', handovers }
const row = { id: 'demo/82', title: 'Improve product search', app: 'codex', agent: 'claude', stage: 'reviewing', state: 'working' }
fs.mkdirSync(path.join(root, 'bin'))
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
case "$1" in
list) cat '${root}/list.json';;
details) case "$4" in demo/83) cat '${root}/fallback.json';; *) cat '${root}/details.json';; esac;;
coordinator) echo '{"state":"none","pane":""}';;
show) echo '{"settings":[],"problems":[]}';;
*) echo ok;;
esac
`, { mode: 0o755 })
const plugin = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.1', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }

test.afterEach(async () => {
  await fakeHerdr('e2e.plugins', { plugins: [] })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(fallbackDir, { recursive: true, force: true })
})
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test.use({ locale: 'fr-FR' })

test('worker identity stays consistent during review on Home, Board and conversation', async ({ page, request }) => {
  test.setTimeout(60_000)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ ...row, link: { pane: CLAUDE_PANE, workspace: 'w1', ownsWorkspace: true, reviewer: { pane: CODEX_UPDATE_PANE, kind: 'codex' } } }))
  fs.mkdirSync(fallbackDir, { recursive: true })
  fs.writeFileSync(path.join(fallbackDir, 'task.json'), JSON.stringify({ ...fallback, link: { pane: CLAUDE_ASK_PANE, workspace: 'w12', ownsWorkspace: true } }))
  fs.writeFileSync(path.join(root, 'fallback.json'), JSON.stringify({ task: fallback, agent: 'claude', handovers }))
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([row, fallback]))
  fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: row, agent: 'claude' }))
  await fakeHerdr('e2e.plugins', { plugins: [plugin] })
  // Another spec may have filled Home's short-lived links cache. Wait
  // for this fixture before Home's first read, rather than its next poll.
  await expect.poll(async () => {
    const response = await request.get('/api/tasks/links')
    const board = await response.json()
    return board.machines?.flatMap((machine: { tasks: { id: string }[] }) => machine.tasks.map(task => task.id)) ?? []
  }, { timeout: 15_000 }).toContain(row.id)
  await page.goto('/')
  const homeRow = page.locator('.task-row').filter({ hasText: row.title }).first()
  await expect(homeRow.locator(':scope > .avatar')).toHaveClass(/claude/)
  await expect(homeRow.locator('.task-agent-reviewer .avatar')).toHaveClass(/codex/)
  const fallbackRow = page.locator('.task-row').filter({ hasText: fallback.title })
  await expect(fallbackRow.locator(':scope > .avatar')).toHaveClass(/claude/)
  await expect(fallbackRow.locator('.task-agent-from .avatar')).toHaveClass(/codex/)
  await page.screenshot({ path: '.shots/identity-home-phone.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/identity-home-desktop.png' })
  await page.goto('/#/board?machine=&task=demo%2F82')
  const panel = page.locator('.board-panel')
  await expect(panel.locator('.board-panel-name > .avatar')).toHaveClass(/claude/)
  await expect(panel.locator('.task-agent-reviewer .avatar')).toHaveClass(/codex/)
  await expect(panel.locator('.task-review-context')).toContainText('Claude’s conversation')
  const card = page.locator('.task-card[data-task="demo/82"]')
  await expect(card.locator('.task-agent-primary .avatar')).toHaveClass(/claude/)
  await expect(card.locator('.task-agent-reviewer .avatar')).toHaveClass(/codex/)
  await page.getByRole('group', { name: 'Board', exact: true }).getByRole('button', { name: /^Working/ }).click()
  await page.screenshot({ path: '.shots/identity-review-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await panel.locator('.board-panel-who > .task-agent-mark').evaluate(el => {
    const bounds = el.closest('.board-panel-head')!.getBoundingClientRect()
    return [el, ...el.querySelectorAll('span, .avatar')].every(child => {
      const rect = child.getBoundingClientRect()
      return rect.left >= bounds.left && rect.right <= bounds.right
    })
  })).toBe(true)
  await page.screenshot({ path: '.shots/identity-review-phone.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await panel.getByRole('button', { name: 'Open reviewer terminal', exact: true }).click()
  await expect(panel.locator('.board-panel-tab-reviewer')).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('textbox', { name: 'Terminal input', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Task', exact: true }).click()
  await expect(panel.locator('.task-handovers')).toHaveCount(0)
  await page.goto('/#/board?machine=&task=demo%2F83')
  await expect(panel.locator('.board-panel-name > .avatar')).toHaveClass(/claude/)
  await expect(panel.locator('.task-agent-from .avatar')).toHaveClass(/codex/)
  await expect(panel.locator('.task-agent-reviewer')).toHaveCount(0)
  await expect(panel.locator('.task-review-context')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Task', exact: true }).click()
  const history = panel.locator('.task-handovers')
  await expect(history).toBeVisible()
  await expect(history.locator('li')).toHaveCount(3)
  await expect(history).toContainText('Out of allowance until tomorrow')
  await expect(history).toContainText('Reviewer')
  await expect(history.locator('time')).toHaveCount(2)
  for (const time of await history.locator('time').all()) {
    const english = await time.evaluate(el => new Date(el.getAttribute('datetime')!).toLocaleString('en'))
    await expect(time).toHaveText(english)
  }
  expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: '.shots/identity-fallback-phone.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/identity-fallback-desktop.png' })
  await page.evaluate(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.reload()
  await page.goto('/#/board?machine=&task=demo%2F83')
  await panel.getByRole('button', { name: 'Task', exact: true }).click()
  await expect(history).toContainText('Handovers')
  await expect(history).toContainText('Reviewer')
  await expect(history).toContainText('Taken over by')
  await expect(panel.locator('.board-panel-name > .avatar')).toHaveClass(/claude/)

})
