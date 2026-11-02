import { expect, test } from './test'
import fs from 'node:fs/promises'

test.describe('English interface', () => {
  const language = 'en'
  test(`read task settings and their provenance, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const row = { id: 'demo/11', repo: 'demo', repoKey: 'DEMO', n: 11, state: 'idle', kind: '', stage: 'todo', title: 'Prepare the lunar garden', msg: '', app: '', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'todo' }
    let reads = 0
    let release: (() => void) | undefined
    let fail = true
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'settings-fixture', machines: [{ machine: 'remote', status: 'ready', version: '1.2.21', tasks: [row] }] } })
      if (url.pathname === '/api/tasks/details') return route.fulfill({ json: { ...row, pane: null, description: 'A garden task' } })
      if (url.pathname === '/api/tasks/settings') {
        reads++
        expect(url.searchParams.get('machine')).toBe('remote')
        expect(url.searchParams.get('id')).toBe('demo/11')
        await gate
        if (fail) return route.fulfill({ status: 502, json: { error: 'CLI unavailable' } })
        return route.fulfill({ json: { settings: [
          { name: 'worker.agent', kind: 'work', value: 'codex', place: 'repo', from: 'your entry for demo', note: '' },
          { name: 'worker.instructions', kind: 'work', value: 'Read the project conventions.\n' + 'LongInstructionsWithoutSpaces'.repeat(12), place: 'file', from: "the repo's file", note: 'Combined instructions' },
          { name: 'merge.by', kind: 'work', value: 'you', place: 'task', from: 'this task', note: 'Task override' },
          { name: 'merge.pr', kind: 'work', value: false, place: 'builtin', from: 'built in', note: '' },
          { name: 'limit.tokens', kind: 'work', value: null, place: '', from: '', note: '' },
        ], problems: ['A setting from the repository file was ignored'] } })
      }
      return route.fulfill({ json: { agent: null, agents: [] } })
    })
    await page.goto('/#/board?machine=remote&task=demo%2F11')
    const settingsTab = page.locator('.board-panel-tabs').getByRole('button', { name: 'Settings', exact: true })
    await expect(settingsTab).toBeVisible()
    expect(reads).toBe(0)
    await settingsTab.click()
    const settings = page.locator('.task-settings:visible')
    await expect(settings).toContainText('Loading')
    release!()
    await expect(settings).toContainText('CLI unavailable')
    fail = false
    await settings.getByRole('button', { name: 'Retry' }).click()
    await expect(settings).toContainText('your entry for demo')
    await expect(settings).toContainText('Task override')
    await expect(settings).toContainText('false')
    await expect(settings).toContainText('Not provided')
    await expect(settings.getByRole('alert')).toContainText('A setting from the repository file was ignored')
    expect(await settings.locator('input,select,textarea').count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/task-settings-${language}-phone.png`, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/task-settings-${language}-desktop.png`, fullPage: true })
    await page.locator('.board-panel-tabs').getByRole('button', { name: 'Task', exact: true }).click()
    await settingsTab.click()
    expect(reads).toBe(2)
  })
})
