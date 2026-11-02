import { test, expect } from './test'

// Two registered devices: one delivered, one whose subscription expired (410).
const ok = { id: 'aaaaaaaaaaaaaaaa', provider: 'google', lang: 'en', addedAt: '2026-05-01T09:00:00.000Z', last: { at: '2026-05-02T10:15:00.000Z', status: 'ok' }, current: true }
const expired = { id: 'bbbbbbbbbbbbbbbb', provider: 'apple', lang: 'en', addedAt: '2026-04-01T09:00:00.000Z', last: { at: '2026-05-02T10:15:00.000Z', status: 'expired', code: 410 }, current: false }

test('settings list each push device with its own last result and remove an expired one', async ({ page }) => {
  let devices = [ok, expired]
  const removed: string[] = []
  await page.route('**/api/push/devices', async (route) => {
    const body = route.request().postDataJSON() as { remove?: string }
    if (body.remove) {
      removed.push(body.remove)
      devices = devices.filter(d => d.id !== body.remove)
    }
    await route.fulfill({ json: { devices } })
  })
  await page.goto('/#/settings?section=notifications')
  const list = page.getByTestId('push-devices')
  await expect(list).toBeVisible()
  const rows = list.getByTestId('push-device')
  await expect(rows).toHaveCount(2)
  // The success on one device does not hide the failure on the other.
  const good = rows.filter({ hasText: 'Chrome or Android' })
  await expect(good).toContainText('This device')
  await expect(good).toContainText('Delivered')
  await expect(good.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  const bad = rows.filter({ hasText: 'Apple' })
  await expect(bad).toContainText('Expired (410)')
  await list.scrollIntoViewIfNeeded()
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/push-devices-${test.info().project.name}.png` })
  await bad.getByRole('button', { name: 'Remove' }).click()
  await expect(rows).toHaveCount(1)
  expect(removed).toEqual([expired.id])
})
