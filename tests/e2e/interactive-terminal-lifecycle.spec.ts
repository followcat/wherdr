// Regressions reproduced by the independent t-0325 review.
import { readFileSync } from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const show = (text: string | null, agent = 'codex', status = 'idle') =>
  fakeHerdr('e2e.interaction_screen', { pane_id: pane, text, agent, status })
const interaction = async (page: import('@playwright/test').Page) => {
  const state = await (await page.request.get('/api/state')).json()
  return state.panes.find((p: { id: string }) => p.id === pane)?.interaction
}
const shot = async (page: import('@playwright/test').Page, name: string, project: string) => {
  await page.addStyleTag({ content: '.agent-meta .where { visibility: hidden !important; }' })
  await page.screenshot({ path: `.shots/review0325-${name}-${project}.png` })
}

test.afterEach(async () => { await show(null, 'omp') })

test('the fallback closes when the agent starts working, and the composer returns', async ({ page }, info) => {
  await page.clock.install()
  await show(fx('codex-usage-menu.txt'))
  await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.interactive-terminal')).toBeVisible()
  await show('• Working (12s • esc to interrupt)', 'codex', 'working')
  await expect.poll(() => interaction(page)).toBe('working')
  await page.goto('/#/')
  await page.goto(`/#/a/${pane}`)
  await page.clock.fastForward(2500)
  await shot(page, 'working', info.project.name)
  expect(await fakeHerdr('e2e.pane_size', { pane_id: pane })).toMatchObject({ attached: false })
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
  await expect(page.locator('.composer')).toBeVisible()
})

// Native approvals (including quoted terminal exceptions) and closed shell
// classification moved to tests/nativeScreenParity.test.ts "quoted menus do
// not steal native approvals" and "a closed Claude shell stays unknown".
// The choose route is exercised by tests/review0346.test.ts
// "answers a native approval below a quoted menu" for every Codex case.

test('a starting unknown Codex discovers a trust card drawn after its first empty read', async ({ page }) => {
  await page.clock.install()
  await show('', 'codex', 'unknown')
  await page.goto(`/#/a/${pane}`)
  await expect.poll(() => interaction(page)).toBe('unknown')
  await page.clock.fastForward(2000)
  await show(fx('codex-trust.txt'), 'codex', 'unknown')
  await expect.poll(() => interaction(page)).toBe('native')
  await expect(page.locator('.choices')).toBeVisible()
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
})
