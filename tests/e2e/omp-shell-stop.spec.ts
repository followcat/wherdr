import { expect, test } from './test'
import { OMP_SHELL_PANE } from './scenario.mjs'

// omp writes nothing for a "!" command cancelled before its first prompt: the
// message must not come back as "Queued · sending…" once the run is gone.
test('Stop cancels an omp "!" command and the message does not go back to the queue', async ({ page }) => {
  await page.clock.install()
  await page.goto(`/#/a/${OMP_SHELL_PANE}`)
  const field = page.locator('.prompt').locator('textarea, [contenteditable="true"]').first()
  await expect(field).toBeEditable()
  await field.fill('! sleep 30')
  const sent = page.waitForResponse(r => r.url().endsWith('/api/prompt') && r.request().method() === 'POST')
  await page.locator('.prompt-send').click()
  expect((await sent).ok()).toBe(true)

  const stop = page.getByRole('button', { name: 'Cancel the command' })
  await expect(stop).toBeVisible()
  await expect(page.locator('.queued-tag.running')).toBeVisible()
  const cancelled = page.waitForResponse(r => r.url().endsWith('/api/interrupt') && r.request().method() === 'POST')
  await stop.click()
  const response = await cancelled
  expect(response.ok()).toBe(true)
  expect(await response.json()).toMatchObject({ stopped: true, shell: true, esc: 1 })
  await expect(page.locator('.hw-toast-title', { hasText: 'Command cancelled' })).toBeVisible()
  await expect(stop).toHaveCount(0)
  // Observe actual conversation polls: a fixed sleep can finish before even
  // one response on a slow machine. Nothing returns to the queue in between.
  for (let poll = 0; poll < 3; poll++) {
    const next = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chat' && new URL(r.url()).searchParams.get('pane') === OMP_SHELL_PANE)
    await page.clock.fastForward(2000)
    const update = await next
    expect(update.ok()).toBe(true)
    await update.finished()
    await expect(page.locator('.msg-pending')).toHaveCount(0)
    await expect(page.locator('.queued-tag')).toHaveCount(0)
  }
})
