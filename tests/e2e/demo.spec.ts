import { test, expect } from '@playwright/test'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'

// The browser demo (`npm run build:demo`, wherdr.dev/demo/): its static files
// served under /demo/, then home → board → task sheet → Tasks to review → Notes,
// with the made-up projects of app/demo/projects.ts. Skipped without the build
// (CI's e2e job builds the server app only; site.yml runs it before deploying).
const ROOT = '.output-demo/public'
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
let server: Server
let base = ''

test.skip(!existsSync(ROOT), 'no demo build')
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    let file = path.startsWith('/demo/') ? join(ROOT, path.slice(6)) : ''
    if (!file || !existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/demo/`
})
test.afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

const shot = (page: import('@playwright/test').Page, name: string) => page.screenshot({ path: `.shots/demo-${name}-${test.info().project.name}.png` })
// Every screenshot of the task loaded (the demo's own made-up images).
const shotsLoaded = (page: import('@playwright/test').Page) => expect.poll(() => page.getByTestId('shot').locator('img').evaluateAll(imgs => imgs.length > 0 && imgs.every(i => (i as HTMLImageElement).naturalWidth > 0))).toBe(true)

test('demo: home, board, task sheet, Tasks to review and Notes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await expect(page.getByTestId('alfred')).toBeVisible()
  await expect(page.getByTestId('review-count')).toHaveText('2')
  await shot(page, 'home')

  await page.getByTestId('home-board').click()
  const card = page.locator('#board [data-task="WEB-7"]')
  await expect(page.locator('[data-lane="your-turn"] [data-task="WEB-8"]')).toBeVisible()
  await expect(page.locator('#board [data-task="WEB-6"]')).toBeVisible()
  await shot(page, 'board')

  await card.click()
  await expect(page.getByTestId('task-sheet')).toContainText('Appearance')
  await shotsLoaded(page)
  await shot(page, 'task')
  await page.locator('[data-tab="plan"]').click()
  await expect(page.getByTestId('task-plan')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.goto(base)
  await page.getByTestId('review-open').click()
  await expect(page.getByTestId('review-item')).toHaveAttribute('data-task', 'WEB-7')
  await shotsLoaded(page)
  await shot(page, 'review')
  await page.getByTestId('review-approve').click()
  await expect(page.locator('[data-testid="review-item"][data-task="WEB-8"]')).toBeVisible()
  await expect(page.getByTestId('review-item')).toHaveCount(1)
  await shot(page, 'question')
  await page.getByTestId('review-choice').filter({ hasText: 'Two months free' }).click()
  await expect(page.getByTestId('review-done')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tasks-to-review')).toHaveCount(0, { timeout: 15_000 })

  await page.getByTestId('alfred-open').click()
  // In the header on a computer, in the ⋯ menu on a phone.
  await expect(page.getByTestId('agent-notes').or(page.getByRole('button', { name: 'Options' })).first()).toBeVisible()
  if (await page.getByTestId('agent-notes').isVisible()) await page.getByTestId('agent-notes').click()
  else {
    await page.getByRole('button', { name: 'Options' }).click()
    await page.getByRole('menuitem', { name: 'Notes' }).or(page.getByRole('button', { name: 'Notes' })).first().click()
  }
  await expect(page.getByTestId('note').filter({ hasText: 'Billing page redesign' })).toBeVisible()
  await page.getByRole('link', { name: 'plan' }).first().click()
  await expect(page.getByTestId('note-file')).toContainText('Open questions')
  await shot(page, 'notes')
  expect(errors).toEqual([])
})
