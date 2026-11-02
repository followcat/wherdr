import { expect, test } from './test'

// Agent list header: at the minimum sidebar width the buttons must stay inside the
// row. No plugin button there: plugin actions are in the machine row's "…" menu.
for (const width of [null, 280]) {
  test.describe('English interface', () => {
    const lang = 'en'
    test(`header buttons fit (sidebar ${width ?? 'default'}, ${lang})`, async ({ page }) => {
      await page.addInitScript(([w, l]) => {
        // No service worker in the tests: resolve the push lookup at once.
        Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => null } }) })
        if (w) localStorage.setItem('listWidth', String(w))
        localStorage.setItem('herdrLanguage', String(l))
      }, [width, lang] as const)
      await page.route('**/api/push/quiet', route => route.fulfill({ json: { global: { until: null }, device: null } }))
      await page.route('**/api/plugins/actions**', route => route.fulfill({
        json: { actions: [
          { plugin: 'demo', pluginName: 'Demo', id: 'run', title: 'Demo: Run', label: 'Run', description: null, agent: false, machine: true, confirm: false, inHerdr: false },
          { plugin: 'demo', pluginName: 'Demo', id: 'board', title: 'Demo: Board', label: 'Board', description: null, agent: false, machine: true, confirm: false, inHerdr: true },
        ] },
      }))
      await page.goto('/')
      const row = page.locator('.home-title-row')
      await expect(page.locator('.home-version')).toBeVisible()
      await expect(page.locator('.solo-machine-options')).toBeVisible()
      await expect(row.locator('.home-actions [aria-label="Plugin actions"], .home-actions [aria-label="Actions des plugins"]')).toHaveCount(0)
      const box = (await row.boundingBox())!
      const buttons = row.locator('.home-actions button, .home-actions a')
      const n = await buttons.count()
      expect(n).toBeGreaterThanOrEqual(2)
      for (let i = 0; i < n; i++) {
        const b = (await buttons.nth(i).boundingBox())!
        expect(b.x).toBeGreaterThanOrEqual(box.x - 7)
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 7)
      }
      const scrolls = await page.locator('.home-top').evaluate(el => el.scrollWidth > el.clientWidth)
      expect(scrolls).toBe(false)
      // The sidebar itself clips nothing: the last button ends inside it.
      const side = (await page.locator('.home-top').boundingBox())!
      const last = (await buttons.nth(n - 1).boundingBox())!
      expect(last.x + last.width).toBeLessThanOrEqual(side.x + side.width)
      // Folded buttons stay reachable through "…".
      if (await row.locator('.space-menu').count()) {
        await row.locator('.space-menu').click()
        await expect(page.getByText(/Settings/).last()).toBeVisible()
        await page.keyboard.press('Escape')
      }
      // Plugin actions: machine row "…" › Plugin actions; Herdr-side ones say so.
      await page.locator('.solo-machine-options').click()
      await page.getByText('Plugin actions').last().click()
      await expect(page.getByText('Board').last()).toBeVisible()
      await expect(page.getByText(/Opens in Herdr/).last()).toBeVisible()
    })
  })
}

test('the eyebrow shows both versions and opens Settings › About', async ({ page }) => {
  await page.goto('/')
  const link = page.locator('.home-version')
  // x.y.z, or a pre-release such as 2.0.0-dev or 2.0.0-rc.1.
  await expect(link).toHaveText(/^wherdr \d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)? · herdr /)
  await link.click()
  await expect(page).toHaveURL(/section=about/)
})

test('quiet mode: a line in the list opens the notification settings without turning quiet off', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => null } }) })
  })
  const writes: unknown[] = []
  await page.route('**/api/push/quiet', (route) => {
    const body = route.request().postDataJSON() as { on?: boolean } | null
    if (body && 'on' in body) writes.push(body)
    return route.fulfill({ json: { global: { until: null }, device: null } })
  })
  await page.goto('/')
  const hint = page.getByRole('link', { name: 'Notifications silenced — open settings' })
  await expect(hint).toHaveCount(1)
  await expect(hint).toBeVisible()
  // Outside the header: the header has no bell.
  await expect(page.locator('.home-top .home-quiet, .home-top [aria-label="Notifications silenced — open settings"]')).toHaveCount(0)
  await hint.click()
  await expect(page).toHaveURL(/section=notifications/)
  await expect(page.locator('.quiet-toggle').first()).toBeVisible()
  expect(writes).toEqual([])
})

test('the header keeps its shape when quiet mode starts or ends', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => null } }) })
  })
  let quiet = false
  await page.route('**/api/push/quiet', route => route.fulfill({ json: { global: quiet ? { until: null } : null, device: null } }))
  const header = async () => page.locator('.home-actions').evaluate(el => [...el.querySelectorAll('button, a')].map(b => b.getAttribute('aria-label')))
  await page.goto('/')
  await expect(page.locator('.home-version')).toBeVisible()
  await expect(page.locator('.home-quiet')).toHaveCount(0)
  const off = await header()
  quiet = true
  await page.reload()
  await expect(page.locator('.home-quiet')).toBeVisible()
  expect(await header()).toEqual(off)
})

test('collapsed list: the rail keeps its buttons and still shows quiet mode', { tag: '@chromium-desktop' }, async ({ page }, info) => {
  test.skip(!info.project.name.includes('desktop'), 'the rail is a computer layout')
  await page.addInitScript(() => {
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => null } }) })
    localStorage.setItem('listCollapsed', '1')
  })
  let quiet = false
  await page.route('**/api/push/quiet', route => route.fulfill({ json: { global: quiet ? { until: null } : null, device: null } }))
  const buttons = async () => page.locator('.home-rail').evaluate(el => [...el.querySelectorAll('button, a')].filter(b => !b.classList.contains('rail-quiet')).map(b => b.getAttribute('aria-label')))
  await page.goto('/')
  await expect(page.locator('.home-rail .rail-stats')).toBeVisible()
  await expect(page.locator('.rail-quiet')).toHaveCount(0)
  const off = await buttons()
  quiet = true
  await page.reload()
  const mark = page.getByRole('link', { name: 'Notifications silenced — open settings' })
  await expect(mark).toBeVisible()
  // Below the counters, not among the rail's actions.
  const stats = (await page.locator('.home-rail .rail-stats').boundingBox())!
  expect((await mark.boundingBox())!.y).toBeGreaterThan(stats.y + stats.height - 1)
  expect(await buttons()).toEqual(off)
  await mark.click()
  await expect(page).toHaveURL(/section=notifications/)
})
