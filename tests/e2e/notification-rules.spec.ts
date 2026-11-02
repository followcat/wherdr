import fs from 'node:fs/promises'
import { test, expect, type Page } from './test'
import { BASE_URL } from './scenario.mjs'

const policy = {
  version: 2, default: { events: [], subagents: false }, exceptions: [
    { kind: 'conversation', machine: '', id: 'w1:p1', label: 'Example agent', events: ['needs-you', 'finished'], subagents: false, until: null },
    { kind: 'coordinator', machine: '', id: 'default/top/', label: 'Coordinator', events: [], subagents: false, until: Date.now() + 3600000 },
  ],
}
const stored = async (page: Page) => {
  const r = await (await page.request.get('/api/settings')).json()
  return r.settings.notificationRules ? JSON.parse(r.settings.notificationRules) : null
}
// The agent's "…" menu: a sheet on a phone, a dropdown on a computer.
const notificationsItem = (page: Page) => page.getByRole('menuitem', { name: 'Notifications', exact: true })
  .or(page.getByRole('button', { name: 'Notifications', exact: true }))
const seed = async (page: Page, value: object = policy) => {
  await page.request.post('/api/settings', { headers: { Origin: BASE_URL }, data: { settings: { notificationRules: JSON.stringify(value) } } })
}

test('the default and exceptions sync across devices, customize, and remove all', async ({ page, browser }) => {
  await seed(page)
  await page.goto('/#/settings?section=notifications')
  const rules = page.getByTestId('notification-rules')
  await expect(rules).toBeVisible()
  const cards = rules.getByTestId('notification-exception')
  await expect(cards).toHaveCount(2)
  await expect(rules.getByRole('combobox', { name: 'Default level', exact: true })).toHaveValue('muted')
  const agent = cards.filter({ hasText: 'Conversation' })
  await expect(agent).toContainText('Louder than the default (Muted)')
  await agent.getByText('Customize', { exact: true }).click()
  await expect(agent.getByRole('checkbox', { name: 'Needs you', exact: true })).toBeChecked()
  await agent.getByRole('checkbox', { name: 'New message', exact: true }).check()
  await expect.poll(async () => (await stored(page))?.exceptions.find((e: { id: string }) => e.id === 'w1:p1')?.events).toContain('message')

  const other = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize(), serviceWorkers: 'block' })
  try {
    const b = await other.newPage()
    await b.goto('/#/settings?section=notifications')
    const second = b.getByTestId('notification-rules')
    await expect(second.getByTestId('notification-exception').filter({ hasText: 'Conversation' }).getByRole('combobox')).toHaveValue('custom')
    await second.getByRole('combobox', { name: 'Default level', exact: true }).selectOption('all')
    await expect(rules.getByRole('combobox', { name: 'Default level', exact: true })).toHaveValue('all')
    await rules.getByRole('button', { name: 'Remove all exceptions', exact: true }).click()
    await expect(second.getByTestId('notification-exception')).toHaveCount(0)
    await expect.poll(async () => (await stored(page))?.exceptions).toEqual([])
  } finally { await other.close() }
})

test('old machine/project/conversation rules become a default and exceptions', async ({ page }) => {
  await seed(page, { defaults: [], muteSubagents: true, rules: [
    { scope: 'machine', machine: '', id: '', label: 'Development', mode: 'muted', events: [], until: null },
    { scope: 'project', machine: '', id: 'example', label: 'Example', mode: 'on', events: ['message'], until: null },
    { scope: 'conversation', machine: '', id: 'w1:p1', label: 'Example agent', mode: 'on', events: ['needs-you', 'finished'], until: null },
  ] })
  await page.goto('/#/settings?section=notifications')
  const rules = page.getByTestId('notification-rules')
  await expect(rules.getByRole('combobox', { name: 'Default level', exact: true })).toHaveValue('muted')
  await expect(rules.getByTestId('notification-exception')).toHaveCount(1)
  await expect(rules.getByTestId('notification-exception')).toContainText('Louder than the default (Muted)')
})

test('a conversation menu sets its exception, mutes for a while and follows the default again', async ({ page }) => {
  await seed(page, { version: 2, default: { events: ['needs-you', 'finished'], subagents: false }, exceptions: [] })
  await page.goto('/#/a/w1:p1')
  // The menu is built from the loaded conversation: retry until it is there.
  const open = async () => {
    await expect(async () => {
      await page.keyboard.press('Escape')
      await page.locator('#agent').getByRole('button', { name: 'Options', exact: true }).click()
      await notificationsItem(page).click({ timeout: 2000 })
    }).toPass({ timeout: 15000 })
  }
  await open()
  await expect(page.getByRole('button', { name: /^Follow the default \(Needs you \+ finished\)/ })).toBeVisible()
  await page.getByRole('button', { name: /^Needs you$/ }).click()
  await expect.poll(async () => (await stored(page))?.exceptions[0]?.events).toEqual(['needs-you'])
  await open()
  await page.getByRole('button', { name: 'Mute for 8 hours', exact: true }).click()
  await expect.poll(async () => (await stored(page))?.exceptions[0]?.until).toBeGreaterThan(Date.now() + 7 * 3600000)
  expect((await stored(page)).exceptions[0].events).toEqual(['needs-you'])
  await open()
  await page.getByRole('button', { name: /^Follow the default/ }).click()
  await expect.poll(async () => (await stored(page))?.exceptions).toEqual([])
})

test('the exception picker lists coordinators by machine, never task agents', async ({ page }) => {
  await page.route('**/api/tasks/links*', route => route.fulfill({ json: { version: 'example', machines: [{ machine: '', tasks: [],
    coordinators: [{ level: 'top', session: 'default', pane: 'w1:p2', workspace: 'w1' }, { level: 'machine', session: 'default', pane: 'w1:p3', workspace: 'w1' }],
  }] } }))
  await seed(page, { version: 2, default: { events: [], subagents: false }, exceptions: [] })
  await page.goto('/#/settings?section=notifications')
  await page.getByRole('button', { name: 'Add an exception', exact: true }).click()
  const picker = page.getByTestId('notification-picker')
  await picker.getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect.poll(async () => (await stored(page))?.exceptions).toEqual([
    expect.objectContaining({ kind: 'coordinator', id: 'default/top/', events: ['needs-you', 'finished'] }),
  ])
})

test('an ended timed mute leaves the coordinator addable again, and a migrated task rule is dropped', async ({ page }) => {
  await page.route('**/api/tasks/links*', route => route.fulfill({ json: { version: 'example', machines: [{ machine: '',
    coordinators: [{ level: 'top', session: 'default', pane: 'w1:p2', workspace: 'w1' }],
    tasks: [{ id: 'example/1', repo: 'example', n: 1, key: 'APP-1', title: 'Example', panes: [{ id: 'w1:p1', role: 'worker' }], workspace: 'w1', stage: 'working', progress: null, msg: '', since: null }],
  }] } }))
  await seed(page, { version: 2, default: { events: [], subagents: false }, exceptions: [
    { kind: 'coordinator', machine: '', id: 'default/top/', label: 'Coordinator', events: null, subagents: false, until: Date.now() - 60000 },
    { kind: 'conversation', machine: '', id: 'w1:p1', label: 'Worker', events: ['message'], subagents: false, until: null },
  ] })
  await page.goto('/#/settings?section=notifications')
  await expect(page.getByTestId('notification-exception')).toHaveCount(0)
  await expect.poll(async () => (await stored(page))?.exceptions).toEqual([])
  await page.getByRole('button', { name: 'Add an exception', exact: true }).click()
  await page.getByTestId('notification-picker').getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect.poll(async () => (await stored(page))?.exceptions).toEqual([expect.objectContaining({ id: 'default/top/', events: ['needs-you', 'finished'], until: null })])
})

test('viewing heartbeat requires visibility and recent activity', async ({ page }) => {
  const viewing: { pane: string | null, visible: boolean }[] = []
  page.on('websocket', ws => ws.on('framesent', frame => {
    try { const m = JSON.parse(String(frame.payload)); if (m.type === 'viewing') viewing.push(m) } catch { /* other websocket */ }
  }))
  await page.goto('/#/a/w1:p1')
  await page.bringToFront()
  await page.locator('#agent').click({ position: { x: 10, y: 100 } })
  await expect.poll(() => viewing.some(v => v.pane === 'w1:p1' && v.visible)).toBe(true)
  await page.clock.install()
  await page.clock.fastForward(131000)
  await expect.poll(() => viewing.at(-1)?.visible).toBe(false)
  // A real interaction renews presence again.
  await page.mouse.click(10, 100)
  await expect.poll(() => viewing.at(-1)?.visible).toBe(true)
  // Headless Chromium keeps all tabs visible. Exercise the browser's
  // Page Visibility event with its hidden state rather than tab ordering.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => viewing.at(-1)?.visible).toBe(false)
})

test('notifications screenshots on phone and desktop, with no horizontal overflow', async ({ page, browser }) => {
  test.setTimeout(60000)
  await seed(page)
  await fs.mkdir('.shots', { recursive: true })
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.goto('/#/settings?section=notifications')
  await expect(page.getByTestId('notification-rules')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '.shots/notifications-mobile.png', fullPage: true })
  await page.getByTestId('notification-exception').last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.shots/notifications-mobile-rules.png', fullPage: true })
  const desktop = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  try {
    const p = await desktop.newPage()
    await p.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
    await p.goto('/#/settings?section=notifications')
    await expect(p.getByTestId('notification-rules')).toBeVisible()
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await p.screenshot({ path: '.shots/notifications-desktop.png', fullPage: true })
  } finally { await desktop.close() }
  await page.goto('/#/a/w1:p1')
  await expect(async () => {
    await page.keyboard.press('Escape')
    await page.locator('#agent').getByRole('button', { name: 'Options', exact: true }).click()
    await notificationsItem(page).click({ timeout: 2000 })
  }).toPass({ timeout: 15000 })
  await expect(page.getByRole('button', { name: 'Mute for 1 hour', exact: true })).toBeVisible()
  await page.screenshot({ path: '.shots/notifications-menu-mobile.png' })
})

for (const desktop of [false, true]) {
  test(`agent row notification menu on ${desktop ? 'desktop' : 'phone'}`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 }, isMobile: !desktop, hasTouch: !desktop, serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      await seed(page, { version: 2, default: { events: ['needs-you', 'finished'], subagents: false }, exceptions: [] })
      await page.goto('/#/')
      const row = page.locator('.card[data-pane="w1:p1"]')
      await expect(row).toBeVisible()
      const originalClass = await row.getAttribute('class')
      const open = async () => {
        if (desktop) await row.click({ button: 'right' })
        else {
          await row.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, clientX: 30, clientY: 30 })
          await page.waitForTimeout(750)
          await row.dispatchEvent('pointerup', { pointerType: 'touch' })
        }
      }
      const action = (name: string) => page.getByRole('menuitem', { name, exact: true }).or(page.getByRole('button', { name, exact: true }))
      await open()
      await action('Mute notifications').click()
      await page.getByRole('button', { name: 'Muted', exact: true }).click()
      await expect.poll(async () => (await stored(page))?.exceptions.find((e: { id: string }) => e.id === 'w1:p1')?.events).toEqual([])
      await expect(row).toHaveAttribute('class', originalClass!)
      await expect(page.locator('.card [class*="bell"]')).toHaveCount(0)
      await fs.mkdir('.shots', { recursive: true })
      await page.screenshot({ path: `.shots/notification-rows-${desktop ? 'desktop' : 'phone'}.png` })
      await open()
      await action('Unmute notifications').click()
      await page.screenshot({ path: `.shots/notification-row-menu-${desktop ? 'desktop' : 'phone'}.png` })
      await page.getByRole('button', { name: 'Needs you + finished', exact: true }).click()
      await expect.poll(async () => (await stored(page))?.exceptions.find((e: { id: string }) => e.id === 'w1:p1')?.events).toEqual(['needs-you', 'finished'])
      await open()
      await expect(action('Mute notifications')).toBeVisible()
    } finally { await context.close() }
  })
}
