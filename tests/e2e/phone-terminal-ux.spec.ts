import { devices, expect, test, type Page } from '@playwright/test'
import { startCore, STREAM } from './core'

// Phone chrome journey (fake herdr-core, tests/e2e/core.ts): the composer at
// rest vs while the field or one of its controls holds the focus, the deferred
// collapse of an outside press, the one-row virtual keybar, the phone header's
// identity and its sheets — all on real browser focus/pointer events.
// The IME step and the WebKit sheet swipe are synthetic (no OS/engine claim);
// real soft-keyboard and IME behavior stays a physical-device boundary.
// Header variants (lone vs several panes) stay in PhoneIdentity.test.ts.

type Core = Awaited<ReturnType<typeof startCore>>

async function openConversation(page: Page, core: Core) {
  await page.addInitScript(() => {
    localStorage.setItem('terminalRenderer', 'html')
    localStorage.setItem('smoothTouchScrolling', '1')
  })
  await core.open(page)
  await page.getByRole('button', { name: /review-agent/ }).first().click()
  await expect(page.locator('.chat')).toBeVisible()
  await expect(page.locator('.composer .prompt')).toBeVisible()
}

// A downward swipe on the sheet: a real CDP gesture on Chromium, the same
// touch path synthesized on WebKit (labeled synthetic there).
async function swipeSheetDown(page: Page, browserName: string) {
  const sheet = page.locator('.hw-sheet')
  const box = (await sheet.boundingBox())!
  const x0 = box.x + box.width / 2
  const y0 = box.y + 8
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
    for (let i = 1; i <= 4; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0, y: y0 + i * 45 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    return
  }
  await sheet.locator('.hw-sheet-handle').evaluate((el, { x0, y0 }) => {
    const fire = (type: string, y: number) => {
      let ev: Event
      try {
        const t = new Touch({ identifier: 0, target: el, clientX: x0, clientY: y })
        ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] })
      } catch {
        // WebKit cannot construct Touch: the same event with the lists set.
        ev = new Event(type, { bubbles: true, cancelable: true })
        const ts = [{ clientX: x0, clientY: y }]
        Object.defineProperties(ev, { touches: { value: type === 'touchend' ? [] : ts }, changedTouches: { value: ts } })
      }
      el.dispatchEvent(ev)
    }
    fire('touchstart', y0)
    for (let i = 1; i <= 4; i++) fire('touchmove', y0 + i * 45)
    fire('touchend', y0 + 180)
  }, { x0, y0 })
}

test('phone chrome: composer focus, deferred collapse, keybar and sheets', async ({ page, browser }, testInfo) => {
  const promptPosts: string[] = []
  const interruptPosts: string[] = []
  page.on('request', r => {
    const path = new URL(r.url()).pathname
    if (r.method() === 'POST' && path === '/api/prompt') promptPosts.push(r.url())
    if (r.method() === 'POST' && path === '/api/interrupt') interruptPosts.push(r.url())
  })
  // A genuinely long neutral name (the fixture keeps the review-agent prefix):
  // the real ellipsis path must show, not a name that happens to fit.
  const paneName = 'review-agent-terminal-with-a-deliberately-long-name'
  const core = await startCore(() => undefined, undefined, { terminal: { name: paneName } })
  try {
    await openConversation(page, core)

    // Header: the phone identity is exactly a 44 px target, between Back and
    // the actions without overlap; a lone pane shows no 1/1 position.
    const identity = page.locator('.phone-identity')
    await expect(identity).toBeVisible()
    const title = identity.locator('.phone-identity-title')
    await expect(title).toHaveText(paneName)
    await expect(identity.locator('.phone-identity-meta .pill')).toBeVisible()
    await expect(identity.locator('.phone-identity-position')).toHaveCount(0)
    const idBox = (await identity.boundingBox())!
    expect(idBox.height).toBe(44)
    const back = page.locator('#btnBack')
    const backBox = await back.boundingBox()
    expect(backBox!.height).toBe(44)
    expect(idBox.x).toBeGreaterThanOrEqual(backBox!.x + backBox!.width - 0.5)
    const actionsBox = (await page.locator('.agent-actions').boundingBox())!
    expect(idBox.x + idBox.width).toBeLessThanOrEqual(actionsBox.x + 0.5)

    // The long name ellipsizes inside the identity's bounds: overflowing text,
    // nowrap + hidden + ellipsis, and the clipped box still inside its cell.
    const titleBox = (await title.boundingBox())!
    expect(titleBox.x).toBeGreaterThanOrEqual(idBox.x)
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(idBox.x + idBox.width + 0.5)
    const titleMetrics = await title.evaluate((el) => {
      const s = getComputedStyle(el)
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: s.overflowX, textOverflow: s.textOverflow, whiteSpace: s.whiteSpace }
    })
    expect(titleMetrics.scrollWidth).toBeGreaterThan(titleMetrics.clientWidth)
    expect(titleMetrics.overflowX).toBe('hidden')
    expect(titleMetrics.textOverflow).toBe('ellipsis')
    expect(titleMetrics.whiteSpace).toBe('nowrap')

    // At rest: one compact row — +, field and send share the same line.
    const prompt = page.locator('.composer .prompt')
    await expect(prompt).not.toHaveClass(/expanded/)
    const rowYs: number[] = []
    for (const sel of ['.prompt-plus', '.prompt-input', '.prompt-send']) rowYs.push((await prompt.locator(sel).boundingBox())!.y)
    expect(Math.max(...rowYs) - Math.min(...rowYs)).toBeLessThanOrEqual(2)

    // Focus expands (the footer toolbar drops below the field).
    await prompt.locator('textarea').tap()
    await expect(prompt).toHaveClass(/expanded/)

    // A real focus move to a control of the prompt keeps it expanded.
    const plus = prompt.locator('button.prompt-plus')
    await plus.evaluate(el => (el as HTMLElement).focus())
    await expect(prompt).toHaveClass(/expanded/)
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).className)).toContain('prompt-plus')

    // The + menu is a sheet; a downward swipe on it closes it.
    await plus.tap()
    const sheet = page.locator('.hw-sheet')
    await expect(sheet).toBeVisible()
    await swipeSheetDown(page, browser.browserType().name())
    await expect(sheet).toHaveCount(0)

    // Reopened, the same sheet dismisses on Escape.
    await plus.tap()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // Outside press: the field blurs but the composer keeps its size until the
    // finger leaves — the pressed message cannot move mid-tap.
    await prompt.locator('textarea').tap()
    await expect(prompt).toHaveClass(/expanded/)
    const openBox = await prompt.boundingBox()
    const chatBox = await page.locator('.chat').boundingBox()
    await page.mouse.move(chatBox!.x + 40, chatBox!.y + 40)
    await page.mouse.down()
    await expect(prompt).toHaveClass(/expanded/)
    const heldBox = await prompt.boundingBox()
    expect(heldBox!.height).toBe(openBox!.height)
    await page.mouse.up()
    await expect(prompt).not.toHaveClass(/expanded/, { timeout: 4000 })

    // A draft keeps the composer open on its own; synthetic composition events
    // (no real IME engine) commit the candidate text once, with no send.
    await prompt.locator('textarea').tap()
    await prompt.locator('textarea').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '字' }))
      ;(el as HTMLTextAreaElement).value = '你好'
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '字' }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(prompt).toHaveClass(/expanded/)
    expect(await prompt.locator('textarea').inputValue()).toBe('你好')
    await page.screenshot({ path: testInfo.outputPath('06-ux-expanded.png') })

    // Terminal mode: the phone header toggle keeps its name and presses on.
    const modeBtn = page.locator('.mode-btn')
    await expect(modeBtn).toHaveAttribute('aria-label', 'Terminal')
    await modeBtn.tap()
    await expect(modeBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.xterm')).toBeVisible()

    // The virtual keybar is one scrollable row of keys; a tap sends exactly
    // that key on the terminal channel.
    const toggle = page.locator('.phone-keybar-toggle')
    await expect(toggle).toBeVisible()
    await toggle.click()
    const strip = page.locator('.vk-strip')
    await expect(strip).toBeVisible()
    const ys = await strip.locator('button[data-key]').evaluateAll(btns => btns.map(b => b.getBoundingClientRect().y))
    expect(new Set(ys.map(y => Math.round(y))).size).toBe(1)
    await strip.locator('button[data-key="esc"]').click()
    const keyCalls = () => core.framed.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)
    await expect.poll(keyCalls).toEqual([['esc']])
    // The key went as a keys call, never as raw DATA or an interrupt.
    expect(core.inbound.filter(f => f.kind === STREAM.data)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('06-ux-keybar.png') })

    // Back to the conversation: same toggle, pressed off; the draft survived.
    await modeBtn.tap()
    await expect(modeBtn).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.composer .prompt textarea')).toHaveValue('你好')
    expect(promptPosts).toEqual([])
    expect(interruptPosts).toEqual([])

    // The identity sheet: an outside press dismisses, then its handle.
    await identity.tap()
    await expect(sheet).toBeVisible()
    await page.mouse.click(20, 120)
    await expect(sheet).toHaveCount(0)
    await identity.tap()
    await expect(sheet).toBeVisible()
    await sheet.locator('.hw-sheet-handle').tap()
    await expect(sheet).toHaveCount(0)
  } finally {
    await core.stop()
  }

  // Fine-pointer desktop context (a real one, not the resized iPhone): the same
  // pane renders the desktop chrome; a layout reference for tasks 07/08.
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page2 = await desk.newPage()
    const core2 = await startCore()
    try {
      await core2.open(page2)
      await page2.getByRole('button', { name: /review-agent/ }).first().click()
      await expect(page2.locator('.agent-head')).toBeVisible()
      await expect(page2.locator('.phone-identity')).toHaveCount(0)
      await expect(page2.locator('.composer .prompt')).toBeVisible()
      await page2.screenshot({ path: testInfo.outputPath('06-ux-1440.png') })
    } finally {
      await core2.stop()
    }
  } finally {
    await desk.close()
  }
})
