import { expect, test } from './test'
import fs from 'node:fs/promises'

test.describe('English interface', () => {
  const language = 'en'
  test(`machine groups: filter, edit, drag and persist (${language})`, { tag: '@webkit-phone' }, async ({ page }, info) => {
    await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
    const base = await (await page.request.get('/api/state')).json()
    const keys = ['', 'laptop', 'buildbox']
    const machineFor = new Map(base.workspaces.map((w: { id: string }, i: number) => [w.id, keys[i % 3]]))
    const state = { ...base,
      machines: keys.map((key, i) => ({ key, label: ['Server', 'Laptop', 'Buildbox'][i], local: !key, status: 'online', error: null, session: 'default' })),
      workspaces: base.workspaces.map((w: { id: string }) => ({ ...w, machine: machineFor.get(w.id) })),
      tabs: base.tabs?.map((t: { workspace: string }) => ({ ...t, machine: machineFor.get(t.workspace) })),
      panes: base.panes.map((p: { workspace: string }) => ({ ...p, machine: machineFor.get(p.workspace) })),
    }
    await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
    await page.addInitScript(language => {
      if (localStorage.getItem('groupsFixture')) return
      localStorage.setItem('groupsFixture', '1')
      localStorage.setItem('herdrLanguage', language)
      localStorage.setItem('machineGroups', JSON.stringify([{ id: '*group:home', name: 'Home', machines: ['laptop', ''] }]))
    }, language)
    await page.goto('/')
    const group = page.locator('.machine-bar-item', { hasText: 'Home' })
    await expect(group).toBeVisible()
    await expect(group.locator('.machine-bar-count')).not.toHaveText('0')
    await group.click()
    await expect(page.locator('section.machine').nth(0)).toHaveAttribute('data-machine', 'laptop')
    await expect(page.locator('section.machine').nth(1)).toHaveAttribute('data-machine', 'local')
    await expect(page.locator('section.machine')).toHaveCount(2)
    await page.evaluate(() => document.fonts.ready)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/groups-home-${language}-${info.project.name}.png` })
    await page.goto('/#/settings?section=appearance')
    const prefs = page.locator('.machine-bar-settings')
    await prefs.locator('.machine-group-list button').click()
    await prefs.locator('.machine-group-name input').fill('Studio')
    const handle = prefs.locator('[data-bar-id="laptop"] .bar-pref-grip')
    const target = prefs.locator('[data-bar-id=""]')
    await handle.scrollIntoViewIfNeeded()
    const a = (await handle.boundingBox())!
    const b = (await target.boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2, b.y + b.height + 3, { steps: 8 })
    await page.mouse.up()
    await expect(prefs.locator('.bar-pref-row').first()).toHaveAttribute('data-bar-id', '')
    await prefs.locator('[data-bar-id="buildbox"] input').check()
    await page.screenshot({ path: `.shots/groups-editor-${language}-${info.project.name}.png` })
    await prefs.locator('.save-machine-group').click()
    await expect(prefs.locator('.machine-group-list')).toContainText('Studio')
    await page.screenshot({ path: `.shots/groups-settings-${language}-${info.project.name}.png` })
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('machineGroups')!)[0])).toMatchObject({ name: 'Studio', machines: ['', 'laptop', 'buildbox'] })
    // Leave init-time fixtures behind before verifying a real reload.
    await page.goto('/')
    await expect(page.locator('.machine-bar-item', { hasText: 'Studio' })).toBeVisible()
  })
})
