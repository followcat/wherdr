import { expect, test } from './test'

for (const grouping of ['machine', 'state']) {
  test(`individual agents preserve shells and persist in ${grouping} grouping`, async ({ page }) => {
    const base = await (await page.request.get('/api/state')).json()
    const keep = new Set(['w6', 'w9'])
    const state = { ...base,
      workspaces: base.workspaces.filter((w: { id: string }) => keep.has(w.id)),
      tabs: base.tabs.filter((t: { workspace: string }) => keep.has(t.workspace)),
      panes: base.panes.filter((p: { workspace: string }) => keep.has(p.workspace)).map((p: { id: string }) => ({ ...p,
        agent: p.id === 'w6:p1' ? null : 'omp', label: p.id === 'w9:p1' ? 'Zulu agent' : p.id === 'w9:p2' ? 'Alpha agent' : 'Plain shell', status: 'idle', prompt: null, menu: null, screen: null,
      })),
    }
    await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
    await page.route('**/api/tasks/links**', route => route.fulfill({ json: { version: 'individual-fixture', machines: [] } }))
    await page.addInitScript(grouping => {
      localStorage.setItem('homeGrouping', grouping)
      localStorage.setItem('showShells', '1')
    }, grouping)
    await page.goto('/')
    await expect(page.locator('.space-card[data-space="w9"]')).toHaveCount(1)
    await page.goto('/#/settings?section=appearance')
    const setting = page.getByRole('switch', { name: 'Individual agents', exact: true })
    await expect(setting).not.toBeChecked()
    await setting.check()
    await page.goto('/')
    await expect(page.locator('.space-card[data-space="w9"]')).toHaveCount(0)
    await expect(page.locator('.card[data-pane="w9:p1"]')).toContainText('Zulu agent')
    await expect(page.locator('.card[data-pane="w9:p2"]')).toContainText('Alpha agent')
    await expect(page.locator('.card[data-pane="w6:p1"]')).toBeVisible()
    await page.reload()
    await expect(page.locator('.card[data-pane="w9:p2"]')).toBeVisible()
    await page.locator('.card[data-pane="w9:p2"]').click()
    await expect(page).toHaveURL(/#\/a\/w9:p2/)
    await page.goto('/#/settings?section=appearance')
    await page.getByRole('switch', { name: 'Individual agents', exact: true }).uncheck()
    await page.goto('/')
    await expect(page.locator('.space-card[data-space="w9"]')).toHaveCount(1)
  })
}
