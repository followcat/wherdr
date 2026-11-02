import { test, expect, type Page } from './test'

// A keyed machine-list replacement can briefly leave the old, hidden card in
// the DOM. Select the visible fixture pane, rather than text in both lists.
const homeTask = (page: Page) => page.locator('#home .project-tree .card[data-pane="w1:p1"]:visible', { hasText: 'DEMO-9' })

const task = { id: 'demo/9', repo: 'demo', n: 9, state: 'working', kind: '', stage: 'working', title: 'Demo task', msg: '', app: 'claude', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'working' }

test.beforeEach(async ({ page }) => {
  await page.route('**/api/tasks/links**', r => r.fulfill({ json: { version: 'back', machines: [{ machine: '', repos: [{ repo: 'demo', root: '/project', branch: 'main', behind: 0 }], coordinators: [], tasks: [{ ...task, key: 'DEMO-9', panes: [{ id: 'w1:p1', role: 'worker' }], workspace: 'w1', since: Date.now() }] }] } }))
  await page.route(/\/api\/tasks(\?.*)?$/, r => r.fulfill({ json: { version: 'back', machines: [{ machine: '', status: 'ready', version: '1.2.1', at: Date.now(), tasks: [task] }] } }))
  await page.route('**/api/tasks/details**', r => r.fulfill({ json: { ...task, pane: null, agent: 'claude' } }))
})

for (const origin of ['home', 'board']) {
  // Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
  test.describe('browser back', () => {
    test(`${origin}: task returns with browser back`, { tag: '@webkit-phone' }, async ({ page }, info) => {
      await page.goto(origin === 'home' ? '/' : '/#/board')
      let boardScroll = 0
      if (origin === 'home') await homeTask(page).click()
      else {
        await expect(page.locator('.task-card[data-task="demo/9"]')).toHaveCount(1)
        await page.locator('.board-seg-btn.working').click()
        await page.locator('.board-grid').evaluate(el => { (el as HTMLElement).style.paddingBottom = '1200px'; el.scrollTop = 50 })
        await page.locator('.task-card-open').scrollIntoViewIfNeeded()
        boardScroll = await page.locator('.board-grid').evaluate(el => el.scrollTop)
        await page.locator('.task-card-open').click()
      }
      await expect(page.locator('.board-panel')).toBeVisible()
      await page.goBack()
      await expect(page.locator('.board-panel')).toHaveCount(0)
      await expect(page.locator(origin === 'home' ? '#home' : '.board-view')).toBeVisible()
      if (origin === 'board') {
        await expect(page.locator('.board-seg-btn.working')).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => page.locator('.board-grid').evaluate(el => el.scrollTop)).toBe(boardScroll)
      }
      await expect(page).toHaveURL(origin === 'home' ? /\/#?\/?$/ : /#\/board$/)
      await page.screenshot({ path: `.shots/mobile-back-after-${origin}-${info.project.name}.png` })
      // Forward reopens exactly one detail; another back returns without a loop.
      await page.goForward()
      await expect(page.locator('.board-panel')).toBeVisible()
      await page.locator('.board-panel-back').click()
      await expect(page.locator('.board-panel')).toHaveCount(0)
    })
  })
}

// Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
test.describe('browser back', () => {
  test(`home: chat returns with browser back`, { tag: '@webkit-phone' }, async ({ page }) => {
    await page.goto('/')
    const card = page.locator('#home .card[data-pane]').filter({ hasNotText: 'DEMO-9' }).first()
    await expect(card).toBeVisible()
    await card.click()
    await expect(page).toHaveURL(/#\/[at]\//)
    await page.goBack()
    await expect(page.locator('#home')).toBeVisible()
    await expect(page).toHaveURL(/\/#?\/?$/)
    await page.goForward()
    await expect(page).toHaveURL(/#\/[at]\//)
    await page.getByRole('button', { name: 'Back', exact: true }).first().click()
    await expect(page.locator('#home')).toBeVisible()
  })
})

for (const machine of ['', 'machine=&']) {
  // Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
  test.describe('browser back', () => {
    test(`cold task link ${machine ? 'with machine' : 'without machine'} defaults to Home with browser back`, { tag: '@webkit-phone' }, async ({ page }, info) => {
      await page.goto(`/#/board?${machine}task=demo%2F9`)
      await expect(page.locator('.board-panel')).toBeVisible()
      await expect.poll(() => page.evaluate(() => history.state.back)).toBe('/')
      expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('machine')).toBe(Boolean(machine))
      await page.goBack()
      await expect(page.locator('#home')).toBeVisible()
      await expect(page).toHaveURL(/\/#?\/?$/)
      if (!machine) await page.screenshot({ path: `.shots/mobile-back-direct-without-machine-${info.project.name}.png` })
      await page.goForward()
      await expect(page.locator('.board-panel')).toBeVisible()
      await page.goBack()
      await expect(page.locator('#home')).toBeVisible()
    })
  })
}

test('desktop keeps the Board beside the task', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await homeTask(page).click()
  await expect(page.locator('#home')).toBeVisible()
  await expect(page.locator('#board')).toBeVisible()
  await expect(page.locator('.board-panel')).toBeVisible()
  await page.screenshot({ path: `.shots/mobile-back-desktop-${info.project.name}.png`, scale: 'css' })
})

// Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
test.describe('browser back', () => {
  test(`Board: coordinator returns with browser back`, { tag: '@webkit-phone' }, async ({ page }) => {
    await page.goto('/#/board')
    await page.locator('.board-top-coord').click()
    await expect(page.locator('.board-panel[data-kind="coordinator"]')).toBeVisible()
    await page.goBack()
    await expect(page.locator('.board-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/#\/board$/)
  })
})

// Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
test.describe('browser back', () => {
  // The sheet's "Open the chat" switches the open task to its conversation: the same
  // detail, so one back still leaves it rather than revisiting the task first.
  test(`Board: a task switched to its chat returns with one browser back`, { tag: '@webkit-phone' }, async ({ page }) => {
    await page.goto('/#/board')
    await page.locator('.board-seg-btn.working').click()
    await page.locator('.task-card-open').click()
    await expect(page.locator('.board-panel')).toBeVisible()
    await page.locator('.board-panel-sheet').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Open the chat' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL(/view=chat/)
    await page.goBack()
    await expect(page.locator('.board-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/#\/board$/)
  })
})

// A link without `machine` resolves to the one card with that id, local or on another
// machine; the route keeps no machine. Switching that task to its chat is still the
// same detail: one back returns to Home, not to the task.
for (const machine of ['', 'host-a']) {
  // Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
  test.describe('browser back', () => {
    test(`a machine-less link to a ${machine ? 'remote' : 'local'} task switched to its chat returns Home with one browser back`, { tag: '@webkit-phone' }, async ({ page }) => {
      if (machine) {
        await page.route(/\/api\/tasks(\?.*)?$/, r => r.fulfill({ json: { version: 'back', machines: [{ machine, status: 'ready', version: '1.2.1', at: Date.now(), tasks: [task] }] } }))
      }
      await page.goto('/')
      await expect(page.locator('#home')).toBeVisible()
      await page.evaluate(() => { location.hash = '#/board?task=demo%2F9' })
      await expect(page.locator('.board-panel')).toBeVisible()
      if (machine) await expect(page.locator('.board-panel-machine')).toHaveText(machine)
      expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('machine')).toBe(false)
      await page.locator('.board-panel-sheet').click()
      await page.getByRole('dialog').getByRole('button', { name: 'Open the chat' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page).toHaveURL(/view=chat/)
      await page.goBack()
      await expect(page.locator('.board-panel')).toHaveCount(0)
      await expect(page.locator('#home')).toBeVisible()
      await expect(page).toHaveURL(/\/#?\/?$/)
    })
  })
}

test('Home keeps its active machine and scroll position', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.goto('/')
  const machine = page.locator('[data-bar-id=""]')
  await machine.click()
  await expect(machine).toHaveAttribute('aria-pressed', 'true')
  const card = homeTask(page)
  await expect(card).toHaveCount(1)
  await expect(card).toBeVisible()
  const scroll = page.locator('#home .scroll')
  // Picking a machine slides the Home content; wait until the leaving copy is gone.
  await expect(scroll).toHaveCount(1)
  await scroll.evaluate(el => { (el as HTMLElement).style.paddingBottom = '1200px'; el.scrollTop = 50 })
  await card.scrollIntoViewIfNeeded()
  const before = await scroll.evaluate(el => el.scrollTop)
  expect(before).toBeGreaterThan(0)
  await card.click()
  await expect(page.locator('.board-panel')).toBeVisible()
  await page.goBack()
  await expect(page.locator('#home')).toBeVisible()
  await expect(page.locator('[data-bar-id=""]')).toHaveAttribute('aria-pressed', 'true')
  await expect(scroll).toHaveCount(1)
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(before)
})

test('a notification in the open app returns to its previous screen', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.goto('/')
  await expect(homeTask(page)).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
    type: 'navigate', url: `${location.origin}/#/board?machine=&task=demo%2F9`,
  } })))
  await expect(page.locator('.board-panel')).toBeVisible()
  await page.goBack()
  await expect(page.locator('#home')).toBeVisible()
})

// The w1:p1 conversation once its pane is loaded, not the "—" header shown
// before the state arrives: the phone identity names its space ("acme-api"),
// the computer header shows it.
const chatOpen = (page: Page) => page.locator('#agent .agent-top').getByRole('button', { name: /acme-api/ })
  .or(page.locator('#agent .agent-head', { hasText: 'acme-api' }))

test('a cold chat link keeps Home underneath it across reload', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.goto('/#/a/w1%3Ap1')
  await expect(chatOpen(page)).toBeVisible()
  await page.reload()
  await expect(chatOpen(page)).toBeVisible()
  await page.goBack()
  await expect(page.locator('#home')).toBeVisible()
  await page.goForward()
  await expect(chatOpen(page)).toBeVisible()
})

test('a task found by search returns to the screen hosting search', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.route(/\/api\/search\?/, r => r.fulfill({ json: { hits: [], limited: false, tasks: [{ machine: '', id: task.id, key: 'DEMO-9', repo: 'demo', title: task.title, stage: 'working', group: 'working', field: 'id' }] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Search agents and conversations', exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Search agents and conversations' }).fill('DEMO-9')
  await page.getByRole('group', { name: 'Tasks' }).getByRole('option').first().click()
  await expect(page.locator('.board-panel')).toBeVisible()
  await page.goBack()
  await expect(page.locator('#home')).toBeVisible()
})

// Header variants: tests/components/ViewBack.test.ts, 'header back traverses each internal predecessor'.
test.describe('browser back', () => {
  test(`a machine-less task link with a cached Board returns using browser back`, { tag: '@webkit-phone' }, async ({ page }) => {
    await page.goto('/#/board')
    await expect(page.locator('.task-card[data-task="demo/9"]')).toHaveCount(1)
    await page.locator('.board-seg-btn.working').click()
    await expect(page.locator('.task-card[data-task="demo/9"]')).toBeVisible()
    await page.evaluate(() => { location.hash = '#/' })
    await expect(page.locator('#home')).toBeVisible()
    // This time the route watcher resolves a card from the kept Board, rather
    // than waiting for the first load watcher to find it.
    await page.evaluate(() => { location.hash = '#/board?task=demo%2F9' })
    await expect(page.locator('.board-panel')).toBeVisible()
    await expect.poll(() => page.evaluate(() => history.state.back)).toBe('/')
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('machine')).toBe(false)
    await page.goBack()
    await expect(page.locator('#home')).toBeVisible()
    await page.goForward()
    await expect(page.locator('.board-panel')).toBeVisible()
    await page.goBack()
    await expect(page.locator('#home')).toBeVisible()
  })
})
