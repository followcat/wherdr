import { expect, test, type Page } from '@playwright/test'
import { startCore, STREAM, type Call } from './core'
import { COLD_HISTORY, MAX_HISTORY } from '../../shared/terminalHistory'

// Keeping a terminal across the Conversation/Terminal toggle, and fetching its
// deep history only when the reader scrolls back to the top.
//
// The fake core answers an attach with the *last* `history` lines of a known
// 5000-line transcript, as the core fills a request from the most recent
// scrollback: the cold paint's first line is the deep paint's line
// MAX_HISTORY - COLD_HISTORY + 1, which is what makes "the same line, older
// text above it" checkable.
const SCREEN = ['acme-shop screen row 01', 'acme-shop screen row 02', 'screen ready']
// A row wider than the phone's ~54 columns: the rendered row is clipped, so
// assertions read the line's short prefix, never the padding.
const line = (n: number) => `history line ${String(n).padStart(4, '0')} ${'.'.repeat(56)}`
const tag = (n: number) => `history line ${String(n).padStart(4, '0')}`

function paint(attach: Call): string {
  const want = Math.min(MAX_HISTORY, Math.max(0, Number(attach.params?.history) || 0))
  const first = MAX_HISTORY - want + 1
  const history = Array.from({ length: want }, (_, i) => line(first + i)).join('\r\n')
  return (history ? history + '\r\n' : '') + SCREEN.join('\r\n')
}

async function openTerminal(page: Page) {
  await page.getByRole('button', { name: /review-agent/ }).first().click()
  await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
  await expect(page.locator('.xterm')).toBeVisible()
}

const tick = (page: Page, ms = 120) => page.clock.runFor(ms)
const attaches = (core: Awaited<ReturnType<typeof startCore>>) => core.framed.filter(c => c.method === 'terminal.attach')
async function expectRows(page: Page, re: RegExp) {
  await expect.poll(async () => { await tick(page, 80); return await page.locator('.xterm-rows').textContent() }).toMatch(re)
}
const firstRow = (page: Page) => page.locator('.xterm-rows').evaluate(el => (el.firstElementChild as HTMLElement | null)?.innerText || '')
const viewportY = async (page: Page) => {
  const rowH = await page.locator('.xterm-rows > div').first().evaluate(el => el.getBoundingClientRect().height || 1)
  return Math.round(await page.locator('.xterm-viewport').evaluate(el => el.scrollTop) / rowH)
}

test('a toggle keeps the parked terminal, and the deep history comes when the top is reached', async ({ page }) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: paint })
  try {
    await page.clock.install()
    // The DOM renderer keeps the visible rows as text, which the assertions
    // read; installed before the app opens, like core-reveal.spec.ts.
    await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
    await core.open(page)
    await openTerminal(page)
    // Exactly one attach: the cold one, asking for a few screens only.
    await expect.poll(() => attaches(core).length).toBe(1)
    expect(attaches(core)[0]!.params.history).toBe(COLD_HISTORY)
    await expectRows(page, /screen ready/)
    await expect.poll(async () => { await tick(page, 100); return await page.locator('#termWrap .term-loading').count() }).toBe(0)
    // The cold paint's oldest line: the tail of the transcript.
    const reading = tag(MAX_HISTORY - COLD_HISTORY + 1)

    // The phone header's one mode button toggles back to the conversation, and
    // a second tap shows the terminal again: the parked xterm is adopted, with
    // no new attach.
    await page.locator('.mode-btn').click()
    await expect(page.locator('.xterm')).toHaveCount(0)
    await page.locator('.mode-btn').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await tick(page, 200)
    expect(attaches(core).length).toBe(1)
    // The adopted view is back on the same buffer, without a reveal cover.
    await expect(page.locator('#termWrap .term-loading')).toHaveCount(0)
    await expectRows(page, /screen ready/)

    // Reaching the top asks once for the deep history, on the same socket.
    await page.locator('.xterm-viewport').evaluate(el => { el.scrollTop = 0 })
    await expect.poll(() => attaches(core).length).toBe(2)
    expect(attaches(core)[1]!.params.history).toBe(MAX_HISTORY)
    expect(attaches(core)[1]!.params.terminal).toBe(attaches(core)[0]!.params.terminal)
    // The strip shows while it loads, then the paint is revealed.
    await expect.poll(async () => { await tick(page, 20); return page.locator('#termWrap .term-earlier').count() }).toBeGreaterThan(0)
    await expect.poll(async () => { await tick(page, 200); return await page.locator('#termWrap .term-loading').count() }).toBe(0)
    await expect(page.locator('#termWrap .term-earlier')).toHaveCount(0)
    // The same line is under the window's top edge, with older text above it.
    await expect.poll(async () => { await tick(page, 100); return firstRow(page) }).toContain(reading)
    expect(await viewportY(page)).toBeGreaterThan(0)
    // The old channel was detached before the new attach, and the deep paint's
    // credit came back for its bytes (the attach channels are 3 and 4 here).
    const attached = core.served.filter(s => s.method === 'terminal.attach').map(s => (s.result as { channel: number }).channel)
    expect(attached.length).toBeGreaterThanOrEqual(2)
    expect(core.inbound.filter(f => f.channel === attached[0] && f.kind === STREAM.close).length).toBeGreaterThan(0)
    await expect.poll(() => core.inbound.filter(f => f.channel === attached[1] && f.kind === STREAM.credit)
      .reduce((n, f) => n + f.data.readUInt32LE(0), 0)).toBeGreaterThan(COLD_HISTORY * 60)

    // One deep fetch per xterm: scrolling to the top again asks for nothing.
    await tick(page, 150)
    await page.locator('.xterm-viewport').evaluate(el => { el.scrollTop = 0 })
    await tick(page, 200)
    expect(attaches(core).length).toBe(2)
  } finally {
    await core.stop()
  }
})
