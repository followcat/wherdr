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

// /ws/term frames this page sends: typed JSON packets (want-resize intents,
// control requests) — distinct from the core RESIZE frames counted elsewhere.
function watchSent(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.endsWith('/ws/term')) return
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      try { sent.push(JSON.parse(payload)) } catch { /* keepalive bytes */ }
    })
  })
  return sent
}

test('computer chrome: device-local interface scale, widths and terminal font', async ({ browser }, testInfo) => {
  // A real fine-pointer desktop at 1440×900 — the computer layout this
  // device-local setting governs; the phone layout must stay untouched.
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page = await desk.newPage()
    const sent = watchSent(page)
    const core = await startCore()
    const cssVar = (name: string) => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
    const termFont = () => page.locator('.xterm-rows').evaluate(el => ({
      font: parseFloat(getComputedStyle(el).fontSize),
      row: (el.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height || 0,
    }))
    const chatWidth = () => page.locator('.chat-list').evaluate(el => el.getBoundingClientRect().width)
    const termWidth = () => page.locator('.xterm').evaluate(el => el.getBoundingClientRect().width)
    const resizes = () => sent.filter(m => m.type === 'terminal.resize') as { cols: number, rows: number }[]
    const showTerm = async () => {
      // Desk toggles the view with .view-toggle ("Show terminal" only when the
      // conversation is up); .mode-btn only exists in the phone chrome.
      const toggle = page.getByRole('button', { name: 'Show terminal' })
      if (await toggle.count()) await toggle.click()
      await expect(page.locator('.xterm')).toBeVisible()
    }
    const openAgent = async () => {
      await core.open(page, '/')
      await page.getByRole('button', { name: /review-agent/ }).first().click()
      await expect(page.locator('.agent-head')).toBeVisible()
      // The view choice persists per pane: restore the conversation when the
      // agent opens on its terminal.
      const toggle = page.getByRole('button', { name: 'Show conversation' })
      if (await toggle.count()) await toggle.click()
      await expect(page.locator('.chat-list')).toBeVisible()
    }
    const openAppearance = async () => {
      await core.open(page, '/#/settings?section=appearance')
      await expect(page.locator('.settings-group').filter({ hasText: 'Interface size' })).toBeVisible()
    }
    try {
      await page.addInitScript(() => { localStorage.setItem('terminalRenderer', 'html') })
      await openAgent()

      // Large is the device default on a computer: dataset applied, the side
      // rail defaults to 300 px, and the reading column stretches to its
      // 1500 px cap (the 1440 − 300 pane leaves 1140, so 1092 rendered).
      await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'lg')
      expect(await cssVar('--side')).toBe('300px')
      expect(await cssVar('--read')).toContain('1500')
      expect(await chatWidth()).toBe(1092)

      // The terminal is built with the scaled font (12 × 1.15 → 14): bigger
      // cells, but the terminal host still obeys terminalPixelWidth — Normal
      // stays a 760 px column, only the reading column grew.
      await showTerm()
      const fLg = await termFont()
      expect(fLg.font).toBe(14)
      expect(await termWidth()).toBe(760)
      await page.screenshot({ path: testInfo.outputPath('07-scale-lg-1440.png') })

      // Settings → Appearance → Interface size → Standard, persisted across a
      // reload (localStorage only, no settings API in the journey).
      await openAppearance()
      await page.locator('.settings-group').filter({ hasText: 'Interface size' })
        .getByRole('radio', { name: /standard/i }).click()
      await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'md')
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'md')
      expect(await cssVar('--side')).toBe('340px')
      await page.screenshot({ path: testInfo.outputPath('07-scale-settings-1440.png') })

      // Back on the agent: base font, the 760 px reading column, smaller
      // cells — the construction honored the persisted Standard choice.
      await openAgent()
      expect(await chatWidth()).toBe(760)
      await showTerm()
      const fMd = await termFont()
      expect(fMd.font).toBe(12)
      expect(fMd.row).toBeLessThan(fLg.row)
      await page.screenshot({ path: testInfo.outputPath('07-scale-md-1440.png') })

      // Full width wins over the Large reading-column cap — the declaration
      // itself changes hands, and the terminal host follows it to the pane.
      await openAppearance()
      await page.locator('.settings-group').filter({ hasText: 'Interface size' })
        .getByRole('radio', { name: /large/i }).click()
      await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'lg')
      await page.locator('.settings-group').filter({ hasText: 'Content width' })
        .getByRole('radio', { name: /full width/i }).click()
      await expect(page.locator('html')).toHaveAttribute('data-content-width', 'full')
      expect(await cssVar('--read')).toContain('calc(100% - 48px)')
      await openAgent()
      await showTerm()
      expect(await termWidth()).toBeGreaterThan(900)
      await page.screenshot({ path: testInfo.outputPath('07-scale-full-1440.png') })

      // Watching through a scale flip, same mounted controller: another
      // viewer's size event puts this client on the observe lease, then a
      // desk→phone→desk viewport transition refits its font live (14→12→14).
      // The remote grid stays the owner's (banner + overflowing 200-col grid
      // stand), nothing on the wire asks for control or feeds input, and the
      // only resize packets are local want-resize intents the server drops —
      // core sees no RESIZE frame.
      core.event('{"method":"event","params":{"type":"size","data":{"cols":200,"rows":60}}}\n')
      const banner = page.locator('.term-banner').filter({ hasText: 'Shown at the size of another screen.' })
      await expect(banner).toBeVisible()
      await expect(banner.getByRole('button', { name: 'Fit to this screen' })).toBeVisible()
      await expect.poll(() => page.locator('.xterm').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      sent.length = 0
      const coreResize0 = core.inbound.filter(f => f.kind === STREAM.resize).length
      const blocked = () => sent.filter(m => ['take.control', 'terminal.input', 'keys', 'paste'].includes(String(m.type)))
      await page.setViewportSize({ width: 500, height: 600 })
      await expect.poll(async () => (await termFont()).font).toBe(12)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(async () => (await termFont()).font).toBe(14)
      const want = resizes().at(-1)
      expect(want, 'the refit still publishes its local want-resize').toBeTruthy()
      expect(want!.cols).not.toBe(200)
      expect(blocked()).toEqual([])
      expect(core.inbound.filter(f => f.kind === STREAM.resize).length).toBe(coreResize0)
      await expect(banner).toBeVisible()
      await expect.poll(() => page.locator('.xterm').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    } finally {
      await core.stop()
    }
  } finally {
    await desk.close()
  }

  // iPhone 13: the device default is still Large in storage but nothing in
  // the phone layout reads it — no settings entry, base terminal font.
  const phone = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page2 = await phone.newPage()
    const core2 = await startCore()
    try {
      await page2.addInitScript(() => { localStorage.setItem('terminalRenderer', 'html') })
      await core2.open(page2, '/#/settings?section=appearance')
      await expect(page2.locator('.settings-group').filter({ hasText: 'Interface size' })).toHaveCount(0)
      await core2.open(page2)
      await page2.getByRole('button', { name: /review-agent/ }).first().click()
      const modeBtn = page2.locator('.mode-btn')
      if (await modeBtn.getAttribute('aria-pressed') !== 'true') await modeBtn.tap()
      await expect(page2.locator('.xterm')).toBeVisible()
      await expect(page2.locator('.xterm-rows')).toBeAttached()
      const font = await page2.locator('.xterm-rows').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      expect(font).toBe(12)
      await page2.screenshot({ path: testInfo.outputPath('07-scale-iphone.png') })
    } finally {
      await core2.stop()
    }
  } finally {
    await phone.close()
  }
})
