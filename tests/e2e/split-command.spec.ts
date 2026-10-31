// "Split right" then a shell command, from the "New agent" sheet: the command
// goes to the pane just created, even when wherdr's pane list has not seen it
// yet. No "Pane created, but the command did not start" toast.
import { expect, test } from './test'
import { OMP_CHAT_PANE, fakeHerdr } from './scenario.mjs'

test.skip(({ isMobile }) => !isMobile, 'phone flow: the Options bottom sheet')

// The new pane shows up in Herdr's snapshots only after this long, so the
// server gets the pane id before its pane list has it.
const LAG_MS = 900
let created: string | null = null

test.afterEach(async () => {
  await fakeHerdr('e2e.split_lag', { ms: 0 })
  // Shared fake session: the pane goes away again for the next specs.
  if (created) await fakeHerdr('e2e.hide_pane', { pane_id: created, hidden: true })
  created = null
})

test('a split with a shell command opens the pane with no error toast', async ({ page }, info) => {
  await fakeHerdr('e2e.split_lag', { ms: LAG_MS })
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()

  await page.getByRole('button', { name: 'Options' }).click()
  await page.locator('.hw-sheet').getByText('Split right').click()
  const sheet = page.getByRole('dialog').filter({ hasText: 'Start in a new pane' })
  await expect(sheet).toBeVisible()
  await sheet.locator('[data-kind="shell"]').click()
  await sheet.locator('#newPrompt').fill('echo split-ok')

  // The /api/agents answer: the command was started in the new pane.
  const started = page.waitForResponse(r => r.url().endsWith('/api/agents'))
  await sheet.getByRole('button', { name: 'Launch' }).click()
  const res = await started
  expect(res.status()).toBe(200)
  const body = await res.json()
  created = body.pane_id
  expect(created).toMatch(/^w3:p\d+$/)

  // The tab opens on the new pane; no error toast.
  await expect(page).toHaveURL(new RegExp(`[?&]pane=${created!.replace(':', '(:|%3A)')}$`))
  await expect(page.locator('.hw-toast-error')).toHaveCount(0)
  await expect(page.getByText(/did not start/)).toHaveCount(0)

  const { writes } = await fakeHerdr('e2e.update_starts', { pane_id: created }) as { writes: { text?: string, keys?: string[] }[] }
  expect(writes).toContainEqual(expect.objectContaining({ text: 'echo split-ok' }))
  await expect(page.locator('.hw-toast-error')).toHaveCount(0)
  await page.screenshot({ path: `.shots/split-command-${info.project.name}.png` })
})
