import { expect, test } from './test'
import { OMP_CHAT_PANE, fakeHerdr, gradientPng } from './scenario.mjs'
import { devinMessage } from '../helpers/devin-fixture.mjs'

const pane = OMP_CHAT_PANE
const image = { type: 'image', mimeType: 'image/png', data: gradientPng(40, 30).toString('base64') }
const rows = [
  ...Array.from({ length: 300 }, (_, id) => ({ id, parent: id ? id - 1 : null,
    message: devinMessage(id % 2 ? 'assistant' : 'user', id === 0 ? 'Earliest Devin request: café anchor' : `Devin history message ${id}.\n\n${'A readable example paragraph. '.repeat(4)}`),
  })),
  { id: 300, parent: 299, message: devinMessage('assistant', '', { tool_calls: [{ id: 'reading-check', name: 'exec', arguments: { command: 'echo reading-check' } }] }) },
  { id: 301, parent: 300, message: devinMessage('tool', 'Tool result: reading-check', { tool_call_id: 'reading-check' }) },
  { id: 302, parent: 301, message: devinMessage('user', 'Describe the sample image', { metadata: { is_user_input: true, extensions: { 'chisel/acp-content-blocks': [image] } } }) },
  { id: 303, parent: 302, message: devinMessage('assistant', '## Devin reading ready\n\nThis is the **current reply**.') },
  { id: 304, parent: 301, message: devinMessage('assistant', 'Abandoned branch must stay hidden') },
]

test.beforeEach(async () => { await fakeHerdr('e2e.devin', { pane_id: pane, rows, head: 303 }) })
test.afterEach(async () => { await fakeHerdr('e2e.devin', { pane_id: pane, reset: true }) })

test('Devin reads real SQLite messages, tool results and images without attaching the terminal', async ({ page }) => {
  const writes: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/(?:send|keys|choose|prompt)/.test(r.url())) writes.push(r.url()) })
  await page.goto(`/#/a/${pane}`)
  const chat = page.locator('.chat')
  await expect(chat.getByRole('heading', { name: 'Devin reading ready' })).toBeVisible()
  await expect(chat).not.toContainText('Abandoned branch')
  await expect(page.locator('.xterm')).toHaveCount(0)
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(false)
  await chat.getByRole('button', { name: /echo reading-check/ }).click()
  await expect(chat.locator('.tool-result')).toHaveText('Tool result: reading-check')
  const thumb = chat.locator('img').first()
  await expect(thumb).toBeVisible()
  await expect.poll(() => thumb.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  const src = await thumb.getAttribute('src')
  const response = await page.request.get(src!)
  expect(response.headers()['content-type']).toContain('image/png')
  expect(await response.body()).toEqual(gradientPng(40, 30))
  await page.screenshot({ path: '.shots/devin-conversation-phone.png' })
  expect(writes).toEqual([])
})

test('Devin loads earlier history and finds an older main-chain message', async ({ page }) => {
  await page.goto(`/#/a/${pane}`)
  const chat = page.locator('.chat')
  await expect(chat.getByText('current reply', { exact: true })).toBeVisible()
  const body = await page.request.get(`/api/search?q=${encodeURIComponent('cafe anchor')}`)
  const result = (await body.json()).hits.find((h: { pane: string }) => h.pane === pane)
  expect(result?.text).toContain('Earliest Devin request')
  await page.goto(`/#/a/${pane}?q=cafe&hit=${result.offset}&role=user&ts=${encodeURIComponent(result.ts || '')}&prefix=${encodeURIComponent('Earliest Devin request')}`)
  await expect(chat.getByText('Earliest Devin request: café anchor', { exact: true })).toBeVisible()
  await expect(chat).not.toContainText('Abandoned branch')
  await expect(page.locator('.xterm')).toHaveCount(0)
  await page.screenshot({ path: '.shots/devin-history-search-phone.png' })
})

test('Devin keeps the reading position on updates and replaces a rewound main chain', async ({ page }) => {
  await page.goto(`/#/a/${pane}`)
  const chat = page.locator('.chat')
  await expect(chat.getByRole('heading', { name: 'Devin reading ready' })).toBeVisible()
  const box = (await chat.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -500)
  await expect.poll(() => chat.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(350)
  const anchor = await chat.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const node = [...el.querySelectorAll<HTMLElement>('[data-hit-key]')].find(n => {
      const r = n.getBoundingClientRect()
      return r.top > bounds.top + 20 && r.bottom < bounds.bottom - 20
    })!
    return { key: node.dataset.hitKey!, y: node.getBoundingClientRect().top }
  })
  await fakeHerdr('e2e.devin', { pane_id: pane, rows: [{ id: 305, parent: 303, message: devinMessage('assistant', 'Incremental Devin reply') }], head: 305 })
  await expect(chat.getByText('Incremental Devin reply', { exact: true })).toBeAttached()
  const y = await chat.locator('[data-hit-key]').evaluateAll((nodes, key) => nodes.find(n => (n as HTMLElement).dataset.hitKey === key)!.getBoundingClientRect().top, anchor.key)
  expect(Math.abs(y - anchor.y)).toBeLessThan(3)
  await fakeHerdr('e2e.devin', { pane_id: pane, rows: [{ id: 306, parent: 0, message: devinMessage('assistant', 'Replacement Devin branch') }], head: 306 })
  await expect(chat.getByText('Replacement Devin branch', { exact: true })).toBeVisible()
  await expect(chat.getByRole('heading', { name: 'Devin reading ready' })).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
})

test('Devin switches to its terminal and returns to the conversation without losing history', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${pane}`)
  await expect(page.getByRole('heading', { name: 'Devin reading ready' })).toBeVisible()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(true)
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Devin reading ready' })).toBeVisible()
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(false)
  await expect(page.locator('.xterm')).toHaveCount(0)
})
