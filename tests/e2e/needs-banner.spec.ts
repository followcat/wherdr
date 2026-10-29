import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_ASK_PANE, SOCK_FILE, fakeHerdr } from './scenario.mjs'

// WHR-69: the "Needs you" banner on one line, its action following the kind
// of wait (question, permission, sign-in), See ↓ to the message that asks,
// short links; the Board card's message on one line with its PR beside the
// title. All data is fictional.
const PR = 'https://github.com/example/shop/pull/484'
const QUESTION = `The checkout tests fail only on the old payment provider since ${PR} was merged. Keep the old provider behind a flag, or drop it and update the docs? (keep / drop)`
const task = { id: 'shop/69', title: 'Retire the old payment provider', stage: 'asks', state: 'blocked', kind: 'question', app: 'claude', msg: QUESTION, pr: '' }

const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const taskDir = path.join(home, '.herdr-projects/data/tasks/shop/69')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-needs-'))
fs.mkdirSync(path.join(root, 'bin'))
const write = (row: Record<string, unknown>) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([row]))
  fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { ...row, description: 'Remove the old provider.' } }))
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ ...row, link: { pane: CLAUDE_ASK_PANE } }))
}
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
case "$1" in
  list) cat '${root}/list.json' ;;
  details) cat '${root}/details.json' ;;
  tell) for a in "$@"; do last="$a"; done; printf '%s' "$last" > '${root}/told'; echo sent ;;
  coordinator) echo '{"state":"none","pane":""}' ;;
  show) echo '{"settings":[],"problems":[]}' ;;
  *) echo ok ;;
esac
`, { mode: 0o755 })
const plugin = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.1', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }

const cwd = path.join(home, 'projects/shop')
const sid = '00000000-0000-4000-8000-000000000069'
const transcript = path.join(home, '.claude/projects', cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`)

// Its conversation: the agent's question, then many lines after it so that
// See ↓ has to scroll back up to it.
function writeTranscript(question = QUESTION) {
  const base = { isSidechain: false, cwd, sessionId: sid }
  let t = Date.now() - 120_000
  const at = () => new Date(t += 1000).toISOString()
  const user = (text: string) => ({ ...base, type: 'user', timestamp: at(), message: { role: 'user', content: text } })
  const ai = (text: string) => ({ ...base, type: 'assistant', timestamp: at(), message: { model: 'claude-opus-4-1', role: 'assistant', content: [{ type: 'text', text }] } })
  const lines = [
    user('Retire the old payment provider.'),
    ai(question),
    ai(Array.from({ length: 40 }, (_, i) => `- Checked file ${i + 1} of the checkout module.`).join('\n')),
  ]
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

test.beforeEach(async () => {
  write(task)
  fs.rmSync(path.join(root, 'told'), { force: true })
  writeTranscript()
  await fakeHerdr('e2e.update_session', { pane_id: CLAUDE_ASK_PANE, session: sid })
  await fakeHerdr('e2e.plugins', { plugins: [plugin] })
})
test.afterEach(async () => {
  await fakeHerdr('e2e.plugins', { plugins: [] })
  await fakeHerdr('e2e.update_session', { pane_id: CLAUDE_ASK_PANE, session: undefined })
  fs.rmSync(taskDir, { recursive: true, force: true })
  fs.rmSync(transcript, { force: true })
})
// The server reuses this board's list for REUSE_MS (5 s): the next spec
// file must not see it.
test.afterAll(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  await new Promise(r => setTimeout(r, 5500))
})

const OPEN = '/#/board?machine=&task=shop%2F69'
// The server reuses a board's list for a few seconds (REUSE_MS): open the
// task again until the row just written shows.
async function shows(page: Page, text: string, where = '.task-needs-type') {
  const got = page.locator(`.board-panel .task-needs ${where}`)
  await expect(async () => {
    await page.goto('about:blank')
    await page.goto(OPEN)
    await expect(got).toHaveText(text, { timeout: 2000 })
  }).toPass({ timeout: 25_000 })
}

// The element a tap on the middle of this link reaches is the link itself.
const top = (l: import('@playwright/test').Locator) => l.evaluate((a) => {
  const r = a.getBoundingClientRect()
  return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === a
})

async function desktopShot(page: Page, file: string) {
  const phone = page.viewportSize()!
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: file })
  await page.setViewportSize(phone)
}

test('Board card: the wait on one line, its pull request beside the title', async ({ page }, testInfo) => {
  await page.goto('/#/board')
  const card = page.locator('.task-card', { hasText: 'Retire the old payment provider' })
  const line = card.locator('.task-card-msg')
  await expect(line.locator('.task-needs-type')).toHaveText('Question')
  await expect(line).toContainText('since PR #484 was merged')
  expect(await line.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(20)
  const pr = card.locator('.task-card-title a.task-card-pr')
  await expect(pr).toHaveText('PR #484')
  await expect(pr).toHaveAttribute('href', PR)
  expect(await top(pr)).toBe(true)
  await page.screenshot({ path: `.shots/needs-card-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/needs-card-desktop.png')
  await card.click()
  await expect(page.locator('.board-panel .task-needs')).toBeVisible()
})

test('Board card: any link of its message is a link, above the card', async ({ page }) => {
  write({ ...task, msg: 'Use https://example.com/settings or keep it?' })
  const link = page.locator('.task-card-msg-text a[href="https://example.com/settings"]')
  await expect(async () => {
    await page.goto('about:blank')
    await page.goto('/#/board')
    await expect(link).toHaveText('example.com/settings', { timeout: 2000 })
  }).toPass({ timeout: 25_000 })
  await expect(link).toHaveAttribute('target', '_blank')
  expect(await top(link)).toBe(true)
})

test('a question: one line, its answers as buttons, See ↓ to its message', async ({ page }, testInfo) => {
  await page.goto(OPEN)
  const banner = page.locator('.board-panel .task-needs')
  await expect(banner.locator('.task-needs-type')).toHaveText('Question')
  const text = banner.locator('.task-needs-text')
  await expect(text.locator('a')).toHaveText('PR #484')
  // One line, folded; its button unfolds it.
  const oneLine = await text.evaluate(el => el.getBoundingClientRect().height)
  expect(oneLine).toBeLessThan(22)
  await expect(banner.getByRole('button', { name: 'Open terminal' })).toHaveCount(0)
  await page.screenshot({ path: `.shots/needs-question-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/needs-question-desktop.png')
  await banner.getByRole('button', { name: 'Show all' }).click()
  expect(await text.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(oneLine * 1.5)
  await page.screenshot({ path: `.shots/needs-question-open-${testInfo.project.name}.png` })
  await banner.getByRole('button', { name: 'Show less' }).click()

  // See ↓: the conversation's message that asks, in view and lit up.
  await expect(page.locator('.board-panel .chat').getByText('Checked file 40 of the checkout module.')).toBeVisible()
  await banner.getByRole('button', { name: 'See ↓' }).click()
  const asked = page.locator('.board-panel .msg-ai.msg-lit')
  await expect(asked).toContainText('Keep the old provider behind a flag')
  await expect(asked).toBeInViewport()
  await page.screenshot({ path: `.shots/needs-see-${testInfo.project.name}.png` })

  // One tap answers.
  await banner.locator('.task-needs-choice', { hasText: 'drop' }).click()
  await expect.poll(() => fs.existsSync(path.join(root, 'told')) && fs.readFileSync(path.join(root, 'told'), 'utf8')).toBe('drop')
})

test('See ↓ finds a question that starts with a link', async ({ page }) => {
  const asked = `${PR} — Keep or drop the old provider?`
  write({ ...task, msg: asked })
  writeTranscript(asked)
  await shows(page, 'PR #484 — Keep or drop the old provider?', '.task-needs-text')
  await expect(page.locator('.board-panel .chat').getByText('Checked file 40 of the checkout module.')).toBeVisible()
  await page.locator('.board-panel .task-needs').getByRole('button', { name: 'See ↓' }).click()
  const lit = page.locator('.board-panel .msg-ai.msg-lit')
  await expect(lit).toContainText('Keep or drop the old provider?')
  await expect(lit).not.toContainText('Checked file')
})

test('a question with no answers: Reply… goes to the field', async ({ page }) => {
  write({ ...task, msg: 'Should the old settings file be removed' })
  await shows(page, 'Should the old settings file be removed', '.task-needs-text')
  const panel = page.locator('.board-panel')
  await panel.locator('.board-panel-agent-bar').getByRole('button', { name: 'Terminal', exact: true }).click()
  await panel.locator('.task-needs').getByRole('button', { name: 'Reply…' }).click()
  await expect(panel.locator('.board-panel-tabs').getByRole('button', { name: 'Agent', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.composer textarea')).toBeFocused()
})

test('a permission: Allow, Always allow, Refuse; a sign-in: Open terminal (French)', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  write({ ...task, kind: 'permission', msg: 'Need your OK to delete the test data of the staging shop (yes / always / no)' })
  const banner = page.locator('.board-panel .task-needs')
  await shows(page, 'Permission')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Autoriser', 'Toujours autoriser', 'Refuser'])
  await page.screenshot({ path: `.shots/needs-permission-fr-${testInfo.project.name}.png` })
  await desktopShot(page, '.shots/needs-permission-fr-desktop.png')
  await banner.getByRole('button', { name: 'Refuser' }).click()
  await expect.poll(() => fs.existsSync(path.join(root, 'told')) && fs.readFileSync(path.join(root, 'told'), 'utf8')).toBe('Refusé : ne le fais pas.')

  // One of its numbered answers, it is offered too.
  write({ ...task, kind: 'permission', msg: 'Lancer le nettoyage ?\n1) Autoriser une fois\n2) Toujours autoriser\n3) Refuser' })
  await shows(page, 'Lancer le nettoyage ? 1) Autoriser une fois 2) Toujours autoriser 3) Refuser', '.task-needs-text')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Autoriser', 'Toujours autoriser', 'Refuser'])

  // Said to the human as something they can do, it is offered too.
  write({ ...task, kind: 'permission', msg: 'Lancer le script de nettoyage ? Tu peux aussi toujours autoriser ce script.' })
  await shows(page, 'Lancer le script de nettoyage ? Tu peux aussi toujours autoriser ce script.', '.task-needs-text')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Autoriser', 'Toujours autoriser', 'Refuser'])

  // A sentence that only uses the word offers no permanent permission.
  write({ ...task, kind: 'permission', msg: 'Ce script supprime toujours les données de test. Autoriser cette seule exécution ?' })
  await shows(page, 'Ce script supprime toujours les données de test. Autoriser cette seule exécution ?', '.task-needs-text')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Autoriser', 'Refuser'])
  write({ ...task, kind: 'permission', msg: 'Our policy is to always allow read-only commands. May I delete the staging data for this run only?' })
  await shows(page, 'Our policy is to always allow read-only commands. May I delete the staging data for this run only?', '.task-needs-text')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Autoriser', 'Refuser'])

  write({ ...task, kind: 'auth', msg: 'Need a GitHub login to open the PR' })
  await shows(page, 'Connexion')
  await expect(banner.locator('.task-needs-actions button')).toHaveText(['Ouvrir le terminal'])
  await page.screenshot({ path: `.shots/needs-auth-fr-${testInfo.project.name}.png` })
  await banner.getByRole('button', { name: 'Ouvrir le terminal' }).click()
  await expect(page.locator('.board-panel #term')).toBeVisible()
})
