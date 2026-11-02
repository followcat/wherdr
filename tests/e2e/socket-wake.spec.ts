import { expect, test } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

// Observe real browser sockets; silence a channel while preserving OPEN.
test('every visible wake probes the terminal; a healthy wake burst keeps both sockets', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('terminalRenderer', 'html')
    const qa = { attempts: { events: 0, term: 0 }, pings: { events: 0, term: 0 }, silent: '' }
    Object.assign(window, { socketQA: qa })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      channel: 'events' | 'term'
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.channel = String(url).includes('/ws/term') ? 'term' : 'events'
        qa.attempts[this.channel]++
        this.addEventListener('message', e => {
          if (qa.silent === this.channel) e.stopImmediatePropagation()
        })
      }
      override send(data: string) {
        if (JSON.parse(data).type === 'ping') qa.pings[this.channel]++
        if (qa.silent !== this.channel) super.send(data)
      }
    }
  })
  const stats = () => page.evaluate(() => (window as unknown as {
    socketQA: { attempts: { events: number, term: number }, pings: { events: number, term: number }, silent: string }
  }).socketQA)
  const wake = (events: string[]) => page.evaluate(events => {
    for (const name of events) window.dispatchEvent(new Event(name))
  }, events)
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  const initial = await stats()
  await wake(['pageshow', 'focus', 'online'])
  await expect.poll(async () => (await stats()).pings).toEqual({ events: initial.pings.events + 1, term: initial.pings.term + 1 })
  await page.waitForTimeout(1800)
  expect((await stats()).attempts).toEqual(initial.attempts)
  for (const signal of ['pageshow', 'online', 'focus']) {
    const before = await stats()
    await wake([signal])
    await expect.poll(async () => (await stats()).pings.term).toBe(before.pings.term + 1)
    await page.waitForTimeout(100)
  }
  await page.evaluate(() => { (window as unknown as { socketQA: { silent: string } }).socketQA.silent = 'term' })
  const before = await stats()
  await wake(['pageshow', 'focus', 'online'])
  await expect.poll(async () => (await stats()).attempts.term).toBe(before.attempts.term + 1)
  await page.evaluate(() => { (window as unknown as { socketQA: { silent: string } }).socketQA.silent = '' })
  await wake(['online'])
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  expect((await stats()).attempts.events).toBe(initial.attempts.events)
})
