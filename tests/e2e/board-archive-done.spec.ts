import { expect, test } from './test'
import fs from 'node:fs/promises'

const lang = 'en'
test(`archive completed repo tasks with explicit consent, ${lang}`, async ({ page }) => {
  await page.addInitScript(language => localStorage.setItem('herdrLanguage', language), lang)
  const writes: unknown[] = []
  let archived = false
  let reads = 0
  await page.route('**/api/tasks**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/tasks') {
      reads++
      return route.fulfill({ json: { version: String(reads), machines: [{ machine: '', status: 'ready', version: '1.2.26', tasks: ['done', 'working', 'todo'].map((group, i) => ({ id: `demo/${i + 1}`, repo: 'demo', n: i + 1, title: `${group} task`, state: group === 'working' ? 'working' : 'idle', stage: group, group })) }] } })
    }
    if (url.pathname === '/api/tasks/archive-done') {
      writes.push(route.request().postDataJSON())
      archived = true
      return route.fulfill({ json: { code: 0, stdout: 'Archived 0 tasks. Kept 1 pinned task.', stderr: '' } })
    }
    return route.fulfill({ json: { machines: [], agents: [] } })
  })
  await page.goto('/#/board')
  const action = 'Archive completed tasks'
  const options = page.getByRole('button', { name: 'Repository options: demo', exact: true })
  await options.click()
  await page.getByRole('button', { name: action, exact: true }).click()
  const confirm = page.locator('.confirm')
  await expect(confirm).toContainText('demo')
  await expect(confirm).toContainText('Completed tasks currently known: 1')
  expect(writes).toEqual([])
  await fs.mkdir('.shots', { recursive: true })
  await page.screenshot({ path: `.shots/archive-done-${lang}-phone.png`, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: `.shots/archive-done-${lang}-desktop.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(writes).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await options.click()
  await page.getByRole('button', { name: action, exact: true }).click()
  const before = reads
  await confirm.getByRole('button', { name: action, exact: true }).click()
  await expect(page.locator('.screen')).toContainText('Kept 1 pinned task.')
  expect(writes).toEqual([{ machine: '', repo: 'demo' }])
  expect(archived).toBe(true)
  await expect.poll(() => reads).toBeGreaterThan(before)
})
