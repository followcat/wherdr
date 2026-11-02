import { readFileSync } from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const show = (name: string | null, agent = 'omp', status = 'idle') =>
  fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: name ? fx(name) : null, agent, status })

test.afterEach(async () => { await show(null) })

// Fixture recognition is covered by tests/nativeScreenParity.test.ts,
// "all fixtures retain origin/main native recognition"; rendering variants by
// tests/components/NativeScreenCards.test.ts. Keep one built-app card journey.
test('a native question keeps its card and the effort screen keeps the composer', async ({ page }, info) => {
  await show('claude-ask-long.txt', 'claude', 'blocked')
  await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.choices-list')).toBeVisible()
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
  await page.screenshot({ path: `.shots/native-question-${info.project.name}.png` })
  // AgentView must keep the composer for this recognized kind=other screen;
  // parser parity and ChoicesPanel mounts cannot prove this rendering rule.
  await show('claude-effort-medium.txt', 'claude', 'idle')
  await expect(page.locator('.choices-list')).toHaveCount(0)
  await expect(page.locator('.composer')).toBeVisible()
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
})

test('Claude usage keeps the immediate loading sheet and native settings tabs', async ({ page }) => {
  await show('claude-idle.txt', 'claude')
  // The previous case ended on a blocked Codex question. Wait for the server
  // to publish Claude's idle field before a fresh page can receive that state;
  // otherwise /usage is sent through the previous question's /api/input route.
  await expect.poll(async () => {
    const state = await (await page.request.get('/api/state')).json()
    const current = state.panes.find((p: { id: string }) => p.id === pane)
    return { agent: current?.agent, prompt: current?.prompt ?? null, interaction: current?.interaction }
  }).toEqual({ agent: 'claude', prompt: null, interaction: 'input' })
  await page.goto(`/#/a/${pane}`)
  const field = page.locator('.prompt').locator('textarea, [contenteditable="true"]').first()
  await field.fill('/usage')
  await page.route('**/api/prompt', async route => {
    const response = await route.fetch()
    await show('claude-settings-usage.ansi', 'claude')
    await route.fulfill({ response })
  })
  // Hold the first result read: the original built-in loading state must open
  // before any screen response. It used to be delayed by the fallback change.
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  await page.route('**/api/screen?*', async route => { await held; await route.continue() })
  await page.locator('.slash-menu .slash-item', { hasText: '/usage' }).first().click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.hw-sheet .spinner')).toBeVisible()
  release()
  await expect(page.locator('.cmd-tabs')).toBeVisible()
  await expect(page.locator('.cmd-tabs [role="tab"]')).toHaveText(['Status', 'Config', 'Usage', 'Stats'])
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
  const result = await (await page.request.get(`/api/screen?pane=${encodeURIComponent(pane)}`)).json()
  expect(result.interaction).toBe('native')
  expect(result.tabs).toEqual(['Status', 'Config', 'Usage', 'Stats'])
})
