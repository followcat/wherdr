import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOCK_FILE, fakeHerdr } from './scenario.mjs'

// WHR-85: a failed review waits for the human. Like herdr-projects ("merge
// anyway, or send the review back"), the banner offers sending the review back
// first (`review <id>`), its findings listed briefly, and Approve anyway after
// it. All data is fictional.
const findings = [
  { severity: 'minor', subject: 'The empty cart message is not translated' },
  { severity: 'critical', subject: 'The coupon code is written to the server log in clear' },
  { severity: 'major', subject: 'No test covers an expired coupon' },
  { severity: 'minor', subject: 'Unused import in the cart store' },
  { severity: 'major', subject: 'An old warning in the build output', preexisting: true },
]
const review = { meets: false, pass: false, by: 'codex', findings }
const task = { id: 'shop/85', title: 'Apply coupon codes at checkout', stage: 'approval', state: 'blocked', kind: 'permission', app: 'claude', msg: 'Approve to merge? Review: Fail (1 critical, 1 major, 2 minor, 1 pre-existing)', pr: '', review }

const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const taskDir = path.join(home, '.herdr-projects/data/tasks/shop/85')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-review-back-'))
fs.mkdirSync(path.join(root, 'bin'))
fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([task]))
fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { ...task, description: 'Let shoppers enter a coupon code.' }, review, reviews: [review] }))
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
case "$1" in
  list) cat '${root}/list.json' ;;
  details) cat '${root}/details.json' ;;
  review) printf '%s' "$*" > '${root}/sent'; echo 'Review sent back to the agent' ;;
  coordinator) echo '{"state":"none","pane":""}' ;;
  show) echo '{"settings":[],"problems":[]}' ;;
  *) echo ok ;;
esac
`, { mode: 0o755 })
const plugin = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.1', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }

test.beforeEach(async () => {
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task))
  fs.rmSync(path.join(root, 'sent'), { force: true })
  await fakeHerdr('e2e.plugins', { plugins: [plugin] })
})
test.afterEach(async () => {
  await fakeHerdr('e2e.plugins', { plugins: [] })
  fs.rmSync(taskDir, { recursive: true, force: true })
})
// The server reuses this board's list for REUSE_MS (5 s): the next spec file must not see it.
test.afterAll(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  await new Promise(r => setTimeout(r, 5500))
})

const OPEN = '/#/board?machine=&task=shop%2F85'
async function open(page: Page) {
  const button = page.locator('.board-panel .task-needs-review')
  await expect(async () => {
    await page.goto('about:blank')
    await page.goto(OPEN)
    await expect(button).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 25_000 })
  return page.locator('.board-panel .task-needs')
}
async function desktopShot(page: Page, file: string) {
  const phone = page.viewportSize()!
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: file })
  await page.setViewportSize(phone)
}

test('a failed review: send it back first, its findings shown, then Approve anyway', async ({ page }, testInfo) => {
  const banner = await open(page)
  const actions = banner.locator('.task-needs-actions button')
  await expect(actions.first()).toHaveText('Send the review back to the agent')
  await expect(banner.locator('.task-needs-anyway')).toHaveText('Approve anyway')
  await expect(banner.locator('.task-needs-findings li')).toHaveText([
    'CriticalThe coupon code is written to the server log in clear',
    'MajorNo test covers an expired coupon',
    'MinorThe empty cart message is not translated',
  ])
  await expect(banner.locator('.task-needs-findings-more')).toHaveText('+1 more in Task')
  await expect(banner).not.toContainText('An old warning in the build output')
  // Each finding stays on one line, the banner within the screen.
  for (const li of await banner.locator('.task-needs-findings li').all()) expect(await li.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(26)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `.shots/review-send-back-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/review-send-back-desktop.png')

  await banner.locator('.task-needs-review').click()
  await expect.poll(() => fs.existsSync(path.join(root, 'sent')) && fs.readFileSync(path.join(root, 'sent'), 'utf8')).toBe('review -- shop/85')
})

test('a failed review, with a legacy French preference', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  const banner = await open(page)
  await expect(banner.locator('.task-needs-actions button').first()).toHaveText('Send the review back to the agent')
  await expect(banner.locator('.task-needs-anyway')).toHaveText('Approve anyway')
  await expect(banner.locator('.task-needs-findings-head')).toHaveText('Review findings')
  await expect(banner.locator('.task-needs-findings li').first()).toHaveText('CriticalThe coupon code is written to the server log in clear')
  await page.screenshot({ path: `.shots/review-send-back-fr-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/review-send-back-fr-desktop.png')
})
