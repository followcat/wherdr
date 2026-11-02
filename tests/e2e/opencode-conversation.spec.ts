import { expect, test } from './test'
import { OMP_CHAT_PANE, fakeHerdr, gradientPng } from './scenario.mjs'
import { opencodeMessage } from '../helpers/opencode-fixture.mjs'

const pane = OMP_CHAT_PANE
const rows = [
  ...Array.from({ length: 300 }, (_, id) => opencodeMessage(id, id % 2 ? 'assistant' : 'user',
    id === 0 ? 'Earliest OpenCode request: café anchor' : `OpenCode history message ${id}.\n\n${'A readable example paragraph. '.repeat(4)}`)),
  { ...opencodeMessage(300, 'assistant', ''), content: [{ type: 'tool', id: 'reading-check', name: 'bash',
    state: { status: 'completed', input: { command: 'echo reading-check' }, content: [{ type: 'text', text: 'Tool result: reading-check' }] }, time: { created: 1700000300000, completed: 1700000300500 } }] },
  { ...opencodeMessage(301, 'user', 'Describe the sample image'), files: [{ mime: 'image/png', data: gradientPng(40, 30).toString('base64'), source: { type: 'inline' } }] },
  opencodeMessage(302, 'assistant', '## OpenCode reading ready\n\nThis is the **current reply**.'),
]
test.beforeEach(async () => { await fakeHerdr('e2e.opencode', { pane_id: pane, rows, revert: null, fail: 0 }) })
test.afterEach(async () => { await fakeHerdr('e2e.opencode', { pane_id: pane, reset: true }) })

test('OpenCode reads HTTP history, tools and images without attaching or writing to the terminal', async ({ page }) => {
  const writes: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/(?:send|keys|choose|prompt)/.test(r.url())) writes.push(r.url()) })
  await page.goto(`/#/a/${pane}`)
  const chat = page.locator('.chat')
  await expect(chat.getByRole('heading', { name: 'OpenCode reading ready' })).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(false)
  await expect.poll(async () => (await fakeHerdr('e2e.opencode', { pane_id: pane }) as { streams: number }).streams).toBe(1)
  await chat.getByRole('button', { name: /echo reading-check/ }).click()
  await expect(chat.locator('.tool-result')).toHaveText('Tool result: reading-check')
  const thumb = chat.locator('img').first()
  await expect.poll(() => thumb.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  expect(await (await page.request.get((await thumb.getAttribute('src'))!)).body()).toEqual(gradientPng(40, 30))
  const fixture = await fakeHerdr('e2e.opencode', { pane_id: pane }) as { requests: { method: string }[], connections: number }
  expect(fixture.requests.every(r => r.method === 'GET')).toBe(true)
  expect(fixture.connections).toBe(1)
  expect(writes).toEqual([])
  await page.screenshot({ path: '.shots/opencode-conversation-phone.png' })
})

test('OpenCode follows opaque pages and jumps from global search to a stable message reference', async ({ page }) => {
  const result = await (await page.request.get(`/api/search?q=${encodeURIComponent('cafe anchor')}`)).json()
  // Wait for the fake pane's new agent kind to reach state polling.
  let hit = result.hits.find((h: { pane: string, agent: string }) => h.pane === pane && h.agent === 'opencode')
  await expect.poll(async () => {
    const response = await (await page.request.get('/api/search?q=cafe%20anchor')).json()
    hit = response.hits.find((h: { pane: string, agent: string }) => h.pane === pane && h.agent === 'opencode')
    return hit?.ref
  }).toBe('oc:msg_00000:u')
  const query = new URLSearchParams({ q: 'cafe', hit: String(hit.offset), ref: hit.ref, role: hit.role, ts: hit.ts || '', prefix: hit.text })
  await page.goto(`/#/a/${pane}?${query}`)
  await expect(page.getByText('Earliest OpenCode request: café anchor', { exact: true })).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  await page.screenshot({ path: '.shots/opencode-history-search-phone.png' })
})

test('OpenCode preserves a reading anchor on append and discards pages after revert', async ({ page }) => {
  await page.goto(`/#/a/${pane}`)
  const chat = page.locator('.chat')
  await expect(chat.getByRole('heading', { name: 'OpenCode reading ready' })).toBeVisible()
  const bounds = (await chat.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, -500)
  await expect.poll(() => chat.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(350)
  const anchor = await chat.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const node = [...el.querySelectorAll<HTMLElement>('[data-hit-key]')].find(n => {
      const r = n.getBoundingClientRect(); return r.top > bounds.top + 20 && r.bottom < bounds.bottom - 20
    })!
    return { key: node.dataset.hitKey!, y: node.getBoundingClientRect().top }
  })
  await fakeHerdr('e2e.opencode', { pane_id: pane, rows: [...rows, opencodeMessage(303, 'assistant', 'Incremental OpenCode reply')] })
  await expect(chat.getByText('Incremental OpenCode reply', { exact: true })).toBeAttached()
  const y = await chat.locator('[data-hit-key]').evaluateAll((nodes, key) => nodes.find(n => (n as HTMLElement).dataset.hitKey === key)!.getBoundingClientRect().top, anchor.key)
  expect(Math.abs(y - anchor.y)).toBeLessThan(3)
  const focused = await page.evaluate(() => document.activeElement?.tagName)
  await fakeHerdr('e2e.opencode', { pane_id: pane, rows: [rows[0], opencodeMessage(304, 'assistant', 'Replacement OpenCode branch')], revert: { messageID: rows[1]!.id }, event: 'session.revert.committed' })
  await expect(chat.getByText('Replacement OpenCode branch', { exact: true })).toBeVisible()
  await expect(chat.getByRole('heading', { name: 'OpenCode reading ready' })).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focused)
})

test('OpenCode keeps cached reading across failures and recovers from credential rotation and restart', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${pane}`)
  const heading = page.getByRole('heading', { name: 'OpenCode reading ready' })
  await expect(heading).toBeVisible()
  await fakeHerdr('e2e.opencode', { pane_id: pane, fail: 503, disconnect: true })
  await expect.poll(async () => (await page.request.get(`/api/chat?pane=${pane}`)).status()).toBeGreaterThanOrEqual(400)
  await expect(heading).toBeVisible()
  await fakeHerdr('e2e.opencode', { pane_id: pane, fail: 0, rotate: true, restart: true, rows: [...rows, opencodeMessage(303, 'assistant', 'Recovered OpenCode reply')] })
  await expect(page.getByText('Recovered OpenCode reply', { exact: true })).toBeVisible()
  await expect(heading).toBeVisible()
  await page.getByRole('tab', { name: 'Terminal' }).or(page.getByRole('button', { name: 'Terminal', exact: true })).click()
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  await page.getByRole('tab', { name: 'Conversation' }).or(page.getByRole('button', { name: 'Terminal', exact: true })).click()
  await expect(heading).toBeVisible()
})
