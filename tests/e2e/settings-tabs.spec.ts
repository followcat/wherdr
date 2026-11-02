import { readFileSync } from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'
const capture = (name: string, width: number) => readFileSync(new URL(`../baselines/claude-config/${name.replace('{w}', String(width))}.ansi`, import.meta.url), 'utf8')
const show = (text: string | null, transitions = {}, agent = 'claude') => fakeHerdr('e2e.interaction_screen', { pane_id: pane, text, agent, status: text ? 'blocked' : 'idle', transitions })

async function openConfig(page: any, text: string, transitions = {}) {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: readFileSync(new URL('../fixtures/claude-idle.txt', import.meta.url), 'utf8'), agent: 'claude', status: 'idle' })
  await expect.poll(async () => {
    const s = await (await page.request.get('/api/state')).json()
    const p = s.panes.find((p: any) => p.id === pane)
    return { agent: p?.agent, interaction: p?.interaction }
  }).toEqual({ agent: 'claude', interaction: 'input' })
  await page.goto(`/#/a/${pane}`)
  await page.route('**/api/prompt', async (route: any) => {
    const response = await route.fetch()
    await show(text, transitions)
    await route.fulfill({ response })
  })
  const field = page.locator('.prompt').locator('textarea, [contenteditable="true"]').first()
  await field.fill('/config')
  await page.locator('.slash-menu .slash-item', { hasText: '/config' }).first().click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Config', exact: true })).toHaveAttribute('aria-selected', 'true')
}

test.afterEach(async () => { await show(null, {}, 'omp') })

test('real Config captures switch tabs, including from a scrolled setting list', async ({ page }, info) => {
  const width = info.project.name.includes('phone') ? 80 : 120
  const fx = (name: string) => capture(name, width)
  const frame = (name: string, transitions: object = {}) => ({ text: fx(name), transitions })
  const stats = frame('stats-{w}')
  const usage = frame('usage-{w}', { right: stats })
  const tabs = frame('config-{w}-tabs', { right: usage, left: frame('status-{w}') })
  await openConfig(page, fx('config-{w}-open'), { up: tabs })
  // Fake visible ANSI reads preserve exactly the captured styling.
  const read = await fakeHerdr('pane.read', { pane_id: pane, source: 'visible', format: 'ansi' })
  expect(read.read.text).toBe(fx('config-{w}-open'))
  await page.getByRole('tab', { name: 'Stats', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Stats', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toEqual(['up', 'right', 'right'])
  // Every source and destination tab: tests/settingsTabNavigation.test.ts (real frames, real handler).
  await show(fx('config-{w}-bottom'), { up: frame('config-{w}-bottom-up', { up: frame('config-{w}-middle', { up: frame('config-{w}-disabled', { up: frame('config-{w}-open', { up: tabs }) }) }) }) })
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Usage', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.hw-sheet .screen')).toContainText('Total cost:')
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toEqual(['up', 'up', 'up', 'up', 'up', 'right'])
  await page.screenshot({ path: `.shots/config-real-${info.project.name}.png` })
})

test('a failed tab switch stays visible and can be retried', async ({ page }, info) => {
  const width = info.project.name.includes('phone') ? 80 : 120
  await openConfig(page, capture('config-{w}-tabs', width))
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  await expect(page.locator('.hw-sheet .screen')).toContainText('Could not switch settings tabs.')
  await expect(page.getByRole('tab', { name: 'Config', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toEqual(['right'])
  await page.screenshot({ path: `.shots/config-failure-${info.project.name}.png` })
  await show(capture('config-{w}-tabs', width), { right: capture('usage-{w}', width) })
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Usage', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.hw-sheet .screen')).toContainText('Total cost:')
})
