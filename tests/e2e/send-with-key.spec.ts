import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

// Codex mid-turn: its field takes the typed text and Tab queues it for the
// turn's end — the verified terminator of shared/submitKeys.ts.
const working = `codex

  Working on it…

› Ask Codex to do anything

  GPT-6-Sol medium · ~/dev/sandbox`
const emptied = `codex

  Working on it…

› Ask Codex to do anything

  GPT-6-Sol medium · ~/dev/sandbox`

async function setup() {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: working, agent: 'codex', status: 'working', transitions: { tab: emptied } })
}

test.afterEach(async () => {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null, agent: 'omp', status: 'idle' })
})

test('keybar Tab on a draft sends it with Tab to a working Codex', { tag: '@webkit-phone' }, async ({ page }) => {
  await setup()
  await page.goto(`/#/a/${pane}`)
  const field = page.locator('.prompt').locator('textarea, [contenteditable="true"]').first()
  await field.fill('Summarize the diff.')
  await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
  const tab = page.locator('.vk-tab')
  // The draft's terminator is annotated on its key, not hidden behind a menu.
  await expect(tab).toHaveClass(/send-with/)
  const promptSent = page.waitForRequest(r => r.url().endsWith('/api/prompt'))
  await tab.click()
  expect((await promptSent).postDataJSON().submit_key).toBe('tab')
  // The server ends the typed text with the key itself.
  await expect.poll(async () => (await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toContain('tab')
})

test('keybar Tab without a draft stays the literal terminal key', { tag: '@webkit-phone' }, async ({ page }) => {
  await setup()
  await page.goto(`/#/a/${pane}`)
  await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
  const tab = page.locator('.vk-tab')
  await expect(tab).not.toHaveClass(/send-with/)
  let prompts = 0
  page.on('request', r => { if (r.url().endsWith('/api/prompt')) prompts++ })
  await tab.click()
  // The key reaches the pane's field itself (WebSocket or /api/input), never
  // as a message: no prompt is sent for an empty draft.
  await expect.poll(async () => (await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toContain('tab')
  expect(prompts).toBe(0)
})
