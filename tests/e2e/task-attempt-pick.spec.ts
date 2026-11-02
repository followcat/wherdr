import { expect, test } from './test'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const details = JSON.parse(readFileSync(new URL('../recordings/herdr-projects-1.2.16/details-pick.json', import.meta.url), 'utf8'))
test.describe('English interface', () => {
  const language = 'en'
  test(`human chooses an attempt with explicit confirmation, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const row = { id: 'demo/11', repo: 'demo', repoKey: 'DEMO', n: 11, state: 'blocked', kind: 'permission', stage: 'pick', title: 'Prepare the lunar garden', msg: 'Pick one of 2', app: '', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'needs' }
    const sent: unknown[] = []
    let fail = true
    let picked = false
    let reads = 0
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: picked ? 'picked' : 'pick-fixture', machines: ['', 'remote'].map(machine => ({ machine, status: 'ready', version: '1.2.16', tasks: [{ ...row, ...(picked && machine ? { stage: 'reviewing', state: 'working', group: 'working' } : {}), title: machine ? row.title : 'A different local garden' }] })) } })
      if (url.pathname === '/api/tasks/details') {
        reads++
        return route.fulfill({ json: { ...details, ...row, stage: picked ? 'reviewing' : 'pick', pane: null, limits: undefined, attempts: details.attempts, comparison: details.comparison } })
      }
      if (url.pathname === '/api/tasks/pick') {
        sent.push(route.request().postDataJSON())
        if (fail) { fail = false; return route.fulfill({ status: 502, json: { error: 'Attempt A cannot be chosen now' } }) }
        picked = true
        return route.fulfill({ json: { ok: true, msg: 'Attempt A chosen' } })
      }
      return route.fulfill({ json: { machines: [], version: 'empty' } })
    })
    await page.goto('/#/board?machine=remote&task=demo%2F11')
    const bannerChoice = page.locator('.task-needs').getByRole('button', { name: 'Choose an attempt', exact: true })
    await expect(page.locator('.task-needs')).toBeVisible()
    if (await bannerChoice.isVisible()) await bannerChoice.click()
    const sheet = page.locator('.task-sheet:visible')
    const keep = 'Keep A'
    const confirm = 'Keep A and close the others'
    await expect(page.locator('.task-needs')).toContainText('Choose an attempt')
    await expect(sheet.locator('.task-attempts')).toContainText('Picker recommends B')
    await expect(sheet.getByRole('button', { name: 'Keep C', exact: true })).toBeDisabled()
    expect(sent).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/task-attempt-${language}-phone.png`, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/task-attempt-${language}-desktop.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await sheet.getByRole('button', { name: keep, exact: true }).click()
    await expect(page.getByRole('button', { name: confirm, exact: true })).toBeVisible()
    await page.screenshot({ path: `.shots/task-attempt-${language}-confirm-phone.png`, fullPage: true })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(sent).toEqual([])
    await sheet.getByRole('button', { name: keep, exact: true }).click()
    await page.getByRole('button', { name: confirm, exact: true }).click()
    await expect(sheet.locator('.task-sheet-error')).toContainText('Attempt A cannot be chosen now')
    const before = reads
    await sheet.getByRole('button', { name: keep, exact: true }).click()
    await page.getByRole('button', { name: confirm, exact: true }).click()
    await expect(sheet.locator('.task-attempts')).toHaveCount(0)
    expect(reads).toBeGreaterThan(before)
    expect(sent).toEqual(Array(2).fill({ machine: 'remote', id: 'demo/11', letter: 'A', confirmed: true }))
  })
})
