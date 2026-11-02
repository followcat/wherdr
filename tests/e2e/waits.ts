// Waits the e2e tests skip rather than sit through.
//
// The server reuses each machine's list for a few seconds (REUSE_MS in
// server/utils/projectsTasks.ts). A Board opened right after the test before
// may first show that test's list, and this test's list only at its next poll,
// 15 s later. Waiting here until the server serves this test's list (a few
// seconds at most) lets the Board open on it at once.
import { expect, type Page } from './test'

type Row = { id: string, title?: string, stage?: string, msg?: string }

export async function boardServes(page: Page, has: (rows: Row[]) => boolean) {
  await expect.poll(async () => {
    const board = await (await page.request.get('/api/tasks')).json() as { machines: { tasks: Row[] }[] }
    return has(board.machines.flatMap(m => m.tasks))
  }, { intervals: [200] }).toBe(true)
}

// An action's toast (2.6 s, 4.2 s for an error) covers the taps under it on a
// phone. With the fake clock installed (page.clock.install, before the page
// opens; time still flows), the test moves past it instead of waiting.
export async function skipToast(page: Page) {
  const toast = page.locator('.hw-toast-title')
  await expect(toast).toBeVisible()
  await page.clock.fastForward(5000)
  await expect(toast).toHaveCount(0)
}
