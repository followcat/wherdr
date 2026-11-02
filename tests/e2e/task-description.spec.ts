import { expect, test } from './test'
import fs from 'node:fs/promises'

test.describe('English interface', () => {
  const language = 'en'
  test(`edit task description explicitly, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const row = { id: 'demo/11', repo: 'demo', repoKey: 'DEMO', n: 11, state: 'idle', kind: '', stage: 'todo', title: 'Prepare the lunar garden', msg: '', app: '', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'todo' }
    let description = 'A garden task\n\nKeep these lines.\n'
    const draft = "\n  It's a garden; $(literal) & `data`\n\nKeep these internal lines.\n\n"
    const stored = draft.replace(/\r/g, '').trim()
    let writes = 0
    let refuse = true
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'description-fixture', machines: [{ machine: 'remote', status: 'ready', version: '1.2.21', tasks: [row] }] } })
      if (url.pathname === '/api/tasks/details') return route.fulfill({ json: { ...row, pane: null, description } })
      if (url.pathname === '/api/tasks/describe') {
        writes++
        expect(route.request().postDataJSON()).toEqual({ machine: 'remote', id: row.id, text: draft })
        if (refuse) return route.fulfill({ status: 502, json: { error: 'CLI refused the description' } })
        description = stored
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ json: { agent: null, agents: [], settings: [], problems: [] } })
    })
    await page.goto('/#/board?machine=remote&task=demo%2F11')
    const block = page.locator('.task-description:visible')
    await block.getByRole('button', { name: 'Edit description' }).click()
    await expect(block.locator('textarea')).toHaveValue(description)
    await block.locator('textarea').fill('discard')
    await block.getByRole('button', { name: 'Cancel' }).click()
    expect(writes).toBe(0)
    await block.getByRole('button', { name: 'Edit description' }).click()
    await expect(block.locator('textarea')).toHaveValue(description)
    await block.locator('textarea').fill(draft)
    const save = block.getByRole('button', { name: 'Save', exact: true })
    await save.click()
    await expect(block.getByRole('alert')).toContainText('CLI refused')
    await expect(block.locator('textarea')).toHaveValue(draft)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/task-description-${language}-phone.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const phoneViewport = page.viewportSize()!
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/task-description-${language}-desktop.png`, fullPage: true })
    refuse = false
    await save.click()
    await expect(block.locator('textarea')).toHaveCount(0)
    await expect.poll(() => block.locator('.task-sheet-text').evaluate(el => el.textContent)).toBe(stored)
    await page.screenshot({ path: `.shots/task-description-${language}-saved-desktop.png`, fullPage: true })
    await page.setViewportSize(phoneViewport)
    await page.screenshot({ path: `.shots/task-description-${language}-saved-phone.png`, fullPage: true })
    await block.getByRole('button', { name: 'Edit description' }).click()
    await expect(block.locator('textarea')).toHaveValue(stored)
    expect(writes).toBe(2)
  })
})
