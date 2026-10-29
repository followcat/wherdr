import fs from 'node:fs/promises'
import { expect, test } from './test'
import { OMP_CHAT_PANE, CLAUDE_PANE } from './scenario.mjs'

for (const [width, lang] of [[390, 'en'], [1440, 'en'], [390, 'fr']] as const) {
  test(`Agent switches views and accepts legacy destinations at ${width}px (${lang})`, async ({ page }) => {
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    const terminal = 'Terminal'
    const conversation = 'Conversation'
    const taskLabel = lang === 'fr' ? 'Tâche' : 'Task'
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const task = { id: 'demo/9', repo: 'demo', n: 9, title: 'Improve navigation', group: 'working', stage: 'working', state: 'working', app: 'omp', msg: '' }
    await page.route(/\/api\/tasks(\?.*)?$/, route => route.fulfill({ json: { version: 'agent-tab', machines: [{ machine: '', status: 'ready', version: '1.2.21', tasks: [task] }] } }))
    await page.route('**/api/tasks/details**', route => route.fulfill({ json: { ...task, pane: OMP_CHAT_PANE, reviewer: { pane: CLAUDE_PANE } } }))
    await page.goto('/#/board?machine=&task=demo%2F9&view=chat')
    const panel = page.locator('.board-panel[data-kind="task"]')
    const tabs = panel.locator('.board-panel-tabs')
    await expect(tabs.locator('button')).toHaveText([taskLabel, 'Agent', lang === 'fr' ? 'Relecteur' : 'Reviewer', lang === 'fr' ? 'Réglages' : 'Settings'])
    const bar = panel.locator('.board-panel-agent-bar')
    await expect(bar.getByRole('button', { name: terminal, exact: true })).toBeVisible()
    await bar.getByRole('button', { name: terminal, exact: true }).click()
    await expect(bar.getByRole('button', { name: conversation, exact: true })).toBeVisible()
    await expect(panel.locator('.xterm')).toBeVisible()
    await tabs.getByRole('button', { name: taskLabel, exact: true }).click()
    await tabs.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(bar.getByRole('button', { name: conversation, exact: true })).toBeVisible()
    await bar.getByRole('button', { name: conversation, exact: true }).click()
    await expect(bar.getByRole('button', { name: terminal, exact: true })).toBeVisible()
    await page.goto('/#/board?machine=&task=demo%2F9&tab=term')
    await expect(bar.getByRole('button', { name: conversation, exact: true })).toBeVisible()
    await page.goto('/#/board?machine=&task=demo%2F9&tab=chat')
    await expect(bar.getByRole('button', { name: terminal, exact: true })).toBeVisible()
    expect(await tabs.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/board-agent-${width}-${lang}.png` })
  })
}
