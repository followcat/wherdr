import { expect, test } from './test'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const recorded = JSON.parse(readFileSync(new URL('../recordings/herdr-projects-1.2.16/show-board.json', import.meta.url), 'utf8'))

test.describe('English interface', () => {
  const language = 'en'
  test(`board capacity reset requires confirmation, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    let value = 1
    let own = true
    const writes: unknown[] = []
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'settings-fixture', machines: [{ machine: 'remote', status: 'ready', version: '1.2.21', tasks: [] }] } })
      if (url.pathname === '/api/tasks/board-settings') {
        if (route.request().method() === 'POST') {
          writes.push(route.request().postDataJSON())
          value = 4
          own = false
        }
        return route.fulfill({ json: { repo: '', agents: ['codex'], settings: recorded.settings.map((row: { name: string }) => row.name === 'board.agents'
          ? { ...row, value, own, place: own ? 'you' : 'builtin', from: own ? 'you' : 'built in' }
          : row), problems: [], msg: 'Saved' } })
      }
      return route.fulfill({ json: { machines: [], agent: null, agents: [] } })
    })
    await page.goto('/#/board?settings=remote')
    const panel = page.locator('.board-settings')
    const row = panel.locator('[data-setting="board.agents"]')
    await expect(row.locator('.bs-value')).toHaveText('1')
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/board-settings-${language}-phone.png`, fullPage: true })
    await row.locator('.bs-reset').click()
    const confirm = page.locator('.confirm')
    await expect(confirm).toContainText('tasks in the queue may start at once')
    expect(writes).toEqual([])
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirm).not.toBeVisible()
    expect(writes).toEqual([])
    await expect(row.locator('.bs-value')).toHaveText('1')
    await row.locator('.bs-reset').click()
    await confirm.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(row.locator('.bs-value')).toHaveText('4')
    expect(writes).toEqual([{ machine: 'remote', name: 'board.agents', repo: '', unset: true }])
    await expect(row.locator('.bs-reset')).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(panel).toHaveClass(/desk/)
    await page.screenshot({ path: `.shots/board-settings-${language}-desktop.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

test.describe('English interface', () => {
  const language = 'en'
  test(`repository checks reset warns about inherited none, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    let own = true
    const writes: unknown[] = []
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'settings-fixture', machines: [{ machine: 'remote', status: 'ready', version: '1.2.21', tasks: [
        { id: 'demo/11', repo: 'demo', n: 11, state: 'idle', stage: 'todo', title: 'Prepare the garden', group: 'todo' },
      ] }] } })
      if (url.pathname === '/api/tasks/board-settings') {
        if (route.request().method() === 'POST') {
          writes.push(route.request().postDataJSON())
          own = false
        }
        const repo = route.request().method() === 'POST' ? route.request().postDataJSON().repo : url.searchParams.get('repo') || ''
        return route.fulfill({ json: { repo, agents: ['codex'], settings: [
          { name: 'merge.checks', kind: 'work', value: repo && own ? 'github' : 'none', own: Boolean(repo && own), place: repo && own ? 'repo' : 'you', from: repo && own ? 'your entry for demo' : 'you', note: '' },
        ], problems: [], msg: 'Saved' } })
      }
      return route.fulfill({ json: { machines: [], agent: null, agents: [] } })
    })
    await page.goto('/#/board?machine=remote')
    await page.locator('.board-repo-settings').click()
    const row = page.locator('.board-settings [data-setting="merge.checks"]')
    await expect(row.locator('.bs-value')).toHaveText('github')
    await row.locator('.bs-reset').click()
    const confirm = page.locator('.confirm')
    await expect(confirm).toContainText('If that value is none')
    await expect(confirm).toContainText('without waiting for their GitHub checks')
    await expect(confirm).toContainText('demo')
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/board-settings-inherited-checks-${language}-phone.png`, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/board-settings-inherited-checks-${language}-desktop.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(writes).toEqual([])
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirm).not.toBeVisible()
    expect(writes).toEqual([])
    await expect(row.locator('.bs-value')).toHaveText('github')
    await row.locator('.bs-reset').click()
    await confirm.getByRole('button', { name: 'Go back', exact: true }).click()
    // Inherited values disappear from the repository's differences view.
    await expect(row).toHaveCount(0)
    expect(writes).toEqual([{ machine: 'remote', name: 'merge.checks', repo: 'demo', unset: true }])
    await page.locator('.board-settings-diff input').uncheck()
    await expect(row.locator('.bs-value')).toHaveText('none')
    await expect(row.locator('.bs-reset')).toHaveCount(0)
  })
})
