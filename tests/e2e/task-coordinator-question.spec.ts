import { expect, test } from './test'
import fs from 'node:fs/promises'

// Fictional boards, including the same task id on two machines.
test.describe('English interface', () => {
  const language = 'en'
  test(`ask a task's coordinator without starting it, ${language}`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const row = { id: 'demo/11', repo: 'demo', repoKey: 'DEMO', n: 11, state: 'idle', kind: '', stage: 'todo', title: 'Prepare the lunar garden', msg: '', app: '', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'todo' }
    const sent: unknown[] = []
    const actions: string[] = []
    let fail = true
    await page.route('**/api/tasks**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'question-fixture', machines: ['', 'remote'].map(machine => ({ machine, status: 'ready', version: '1.2.1', tasks: [{ ...row, title: machine ? row.title : 'A different local garden' }] })) } })
      if (url.pathname === '/api/tasks/details') return route.fulfill({ json: { ...row, pane: null, description: 'Choose the plants before starting the garden.', failure: '', plan: '', agent: '' } })
      if (url.pathname === '/api/tasks/start') return route.fulfill({ json: { agent: null, agents: ['claude'] } })
      if (url.pathname === '/api/tasks/question') {
        sent.push(route.request().postDataJSON())
        if (fail) { fail = false; return route.fulfill({ status: 502, json: { error: 'Coordinator unavailable' } }) }
        return route.fulfill({ json: { ok: true } })
      }
      if (url.pathname === '/api/tasks/coordinator') return route.fulfill({ json: { pane: null, state: 'none', error: '', name: '', queued: null } })
      if (route.request().method() === 'POST') actions.push(url.pathname)
      return route.fulfill({ json: { machines: [], version: 'empty' } })
    })
    await page.goto('/#/board?machine=remote&task=demo%2F11')
    const sheet = page.locator('.task-sheet:visible')
    const ask = 'Ask the coordinator'
    await sheet.getByRole('button', { name: ask, exact: true }).click()
    await sheet.getByRole('textbox').fill('Quelles plantes faut-il pour cette tâche ?')
    const submit = sheet.getByRole('button', { name: 'Send question', exact: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await sheet.getByRole('textbox').blur()
    await sheet.getByRole('textbox').evaluate(el => {
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) parent.scrollTop = 0
    })
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/task-question-${language}-phone.png`, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/task-question-${language}-desktop.png`, fullPage: true })
    await submit.click()
    await expect(sheet.locator('.task-sheet-error')).toBeVisible()
    await expect(sheet.getByRole('textbox')).not.toBeDisabled()
    await expect(sheet.getByRole('textbox')).not.toHaveValue('')
    const request = page.waitForRequest(r => r.url().includes('/api/tasks/coordinator?'))
    await submit.click()
    const opened = new URL((await request).url())
    expect(opened.searchParams.get('machine')).toBe('remote')
    expect(opened.searchParams.get('kind')).toBe('project')
    expect(opened.searchParams.get('repo')).toBe('demo')
    expect(sent).toEqual([expect.objectContaining({ machine: 'remote', id: 'demo/11', text: 'Quelles plantes faut-il pour cette tâche ?' }), expect.objectContaining({ machine: 'remote', id: 'demo/11', text: 'Quelles plantes faut-il pour cette tâche ?' })])
    expect(actions).toEqual([])
    await expect(page.locator('.board-panel')).toContainText('coordinator')
  })
})
