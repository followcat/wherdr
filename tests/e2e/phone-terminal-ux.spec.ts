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
      // On a computer the card list is a persistent sidebar — mounted on
      // Settings too — so click it straight instead of detouring through
      // goto('/'). Then wait on the actual target: its route, its header.
      await page.locator('#home .card[data-pane]').filter({ hasText: 'review-agent' }).click()
      await expect(page).toHaveURL(/#\/a\//)
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
      await core.open(page)
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

// Task08: hardware Alt+arrows step the rendered sidebar cards (↑/↓) and the
// current space's tab chips (←/→), taken at the window before a focused xterm
// or a non-empty composer could see them — computer layout only. The desktop
// keybar's Alt+arrow has no trusted KeyboardEvent: it stays the literal agent
// chord, and Ctrl+arrows keep reaching the program.
test('computer chrome: hardware Alt steps cards and tab chips, virtual Alt stays a chord', async ({ browser }, testInfo) => {
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page = await desk.newPage()
    const promptPosts: string[] = []
    const interruptPosts: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (r.method() === 'POST' && path === '/api/prompt') promptPosts.push(r.url())
      if (r.method() === 'POST' && path === '/api/interrupt') interruptPosts.push(r.url())
    })
    // One row per agent pane: three cards, the first two sharing one space
    // (distinct herdr.tab labels give the two-chip strip), ops in its own.
    const core = await startCore(() => undefined, undefined, {
      terminals: [
        { address: 'host-a/t7', name: 'review-agent', cwd: '/home/user/acme-shop', labels: { 'herdr.space': 'acme-space', 'herdr.tab': 'tab-a' } },
        { address: 'host-a/t8', name: 'build-agent', cwd: '/home/user/acme-shop', labels: { 'herdr.space': 'acme-space', 'herdr.tab': 'tab-b' } },
        { address: 'host-a/t9', name: 'ops-agent', cwd: '/home/user/ops', labels: { 'herdr.space': 'ops-space', 'herdr.tab': 'tab-a' } },
      ],
    })
    const keyCalls = () => core.framed.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)
    const dataFrames = () => core.inbound.filter(f => f.kind === STREAM.data)
    const cardPanes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#home .card[data-pane]')].map(e => e.dataset.pane!))
    const selPane = () => page.evaluate(() => document.querySelector<HTMLElement>('#home .card.sel')?.dataset.pane ?? null)
    try {
      await page.addInitScript(() => { localStorage.setItem('terminalRenderer', 'html') })
      await core.open(page, '/')
      const cards = page.locator('#home .card[data-pane]')
      await expect(cards).toHaveCount(3)
      await cards.first().click()
      await expect(page.locator('.agent-head')).toContainText('review-agent')
      const chips = page.locator('.space-tabs .tab-chip[data-tab]')
      await expect(chips).toHaveCount(2)
      await expect(chips.first()).toHaveAttribute('aria-current', 'page')
      const tabA = page.url()
      const order = await cardPanes()
      const xtermFocused = () => page.evaluate(() => Boolean(document.activeElement?.closest('.xterm')))

      // Alt+→ steps the tab chips through the route even with xterm focused.
      await page.getByRole('button', { name: 'Show terminal' }).click()
      await expect(page.locator('.xterm')).toBeVisible()
      await page.locator('.xterm').click()
      await expect.poll(xtermFocused).toBe(true)
      await page.keyboard.press('Alt+ArrowRight')
      await expect(chips.nth(1)).toHaveAttribute('aria-current', 'page')
      expect(page.url()).not.toBe(tabA)

      // Back to the first chip; a second Alt+← has nowhere to step: a test-only
      // later capture listener proves the trusted key was consumed (the
      // browser's Back never sees it) and the route does not move.
      await page.keyboard.press('Alt+ArrowLeft')
      await expect(chips.first()).toHaveAttribute('aria-current', 'page')
      await page.evaluate(() => {
        (window as unknown as { rec: { trusted?: boolean, prevented?: boolean } }).rec = {}
        window.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            (window as unknown as { rec: { trusted?: boolean, prevented?: boolean } }).rec = { trusted: e.isTrusted, prevented: e.defaultPrevented }
          }
        }, true)
      })
      await page.keyboard.press('Alt+ArrowLeft')
      const rec = await page.evaluate(() => (window as unknown as { rec: { trusted?: boolean, prevented?: boolean } }).rec)
      expect(rec.trusted).toBe(true)
      expect(rec.prevented).toBe(true)
      expect(page.url()).toBe(tabA)
      await expect(chips.first()).toHaveAttribute('aria-current', 'page')

      // Alt+↓ steps the rendered cards in DOM order (derived, not assumed);
      // Alt+↑ steps back. No key reaches the agent in any of these steps.
      expect(await selPane()).toBe(order[0])
      await page.keyboard.press('Alt+ArrowDown')
      await expect.poll(selPane).toBe(order[1])
      expect(page.url()).toContain(order[1]!)
      await expect(page.locator('.agent-head')).toContainText('build-agent')
      await page.keyboard.press('Alt+ArrowDown')
      await expect.poll(selPane).toBe(order[2])
      expect(page.url()).toContain(order[2]!)
      await expect(page.locator('.agent-head')).toContainText('ops-agent')
      await page.keyboard.press('Alt+ArrowUp')
      await expect.poll(selPane).toBe(order[1])
      expect(page.url()).toContain(order[1]!)
      await page.keyboard.press('Alt+ArrowUp')
      await expect.poll(selPane).toBe(order[0])
      await expect(page.locator('.agent-head')).toContainText('review-agent')
      expect(keyCalls()).toEqual([])
      expect(dataFrames()).toEqual([])

      // A non-empty composer keeps the chord: navigation fires and the draft
      // text survives the round trip.
      await page.getByRole('button', { name: 'Show conversation' }).click()
      const field = page.locator('.composer textarea')
      await field.click()
      await field.fill('draft one')
      await page.keyboard.press('Alt+ArrowDown')
      await expect(page.locator('.agent-head')).toContainText('build-agent')
      await page.keyboard.press('Alt+ArrowUp')
      await expect(page.locator('.agent-head')).toContainText('review-agent')
      expect(await field.inputValue()).toBe('draft one')
      expect(keyCalls()).toEqual([])
      expect(dataFrames()).toEqual([])
      expect(promptPosts).toEqual([])
      expect(interruptPosts).toEqual([])

      // The desktop keybar's Alt+→ is a click, not a trusted key: the agent
      // gets the accepted named chord, the app does not navigate.
      await page.getByRole('button', { name: 'Show terminal' }).click()
      await expect(page.locator('.xterm')).toBeVisible()
      const keybar = page.locator('.keybar')
      await expect(keybar).toBeVisible()
      await keybar.getByRole('button', { name: 'Alt', exact: true }).click()
      await keybar.getByRole('button', { name: '→', exact: true }).click()
      await expect.poll(keyCalls).toEqual([['alt+right']])
      expect(page.url()).toBe(tabA)
      expect(dataFrames()).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('08-altnav-1440.png') })

      // Ctrl+arrows are not the app's: the program gets the CSI sequence.
      await page.locator('.xterm').click()
      await expect.poll(xtermFocused).toBe(true)
      await page.keyboard.press('Control+ArrowRight')
      await expect.poll(() => dataFrames().some(f => f.data.includes(Buffer.from('\x1b[1;5C')))).toBe(true)
    } finally {
      await core.stop()
    }
  } finally {
    await desk.close()
  }
})

test('coarse tablet: a viewport-only blip keeps a proven hardware edit', async ({ browser }, testInfo) => {
  // iPad-class coarse pointer, one window: 744×1000 → 744×800 → 744×1000 in
  // the same orientation. layout() sees an open/close pair, but a viewport
  // change is not input — a proven hardware edit must stay focused.
  const tablet = await browser.newContext({ viewport: { width: 744, height: 1000 }, hasTouch: true, isMobile: true, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page = await tablet.newPage()
    const promptPosts: string[] = []
    const interruptPosts: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (r.method() === 'POST' && path === '/api/prompt') promptPosts.push(r.url())
      if (r.method() === 'POST' && path === '/api/interrupt') interruptPosts.push(r.url())
    })
    const core = await startCore()
    const keyCalls = () => core.framed.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)
    const dataFrames = () => core.inbound.filter(f => f.kind === STREAM.data)
    try {
      await page.addInitScript(() => { localStorage.setItem('terminalRenderer', 'html') })
      await core.open(page)
      await page.locator('#home .card[data-pane]').click()
      await expect(page.locator('.agent-head')).toContainText('review-agent')
      const ta = page.locator('.composer textarea')
      await expect(ta).toBeVisible()
      // A tap focuses the field (the soft keyboard a real iPad opens here is a
      // device boundary — headless resize cannot claim it).
      await ta.tap()
      await expect(ta).toBeFocused()
      // A key only hardware sends: the real keydown listener proves it.
      await page.keyboard.press('Control+b')
      // The exact blip: the body's kb class proves the real layout() ran.
      const kbClass = () => page.evaluate(() => document.body.classList.contains('kb'))
      const focused = () => page.evaluate(() => document.activeElement === document.querySelector('.composer textarea'))
      await page.setViewportSize({ width: 744, height: 800 })
      await expect.poll(kbClass).toBe(true)
      await page.setViewportSize({ width: 744, height: 1000 })
      await expect.poll(kbClass).toBe(false)
      // The edit survives: still focused, and typing lands once in the draft.
      await expect.poll(focused).toBe(true)
      await page.keyboard.type('kept')
      await expect(ta).toHaveValue('kept')
      // Viewport bookkeeping never talks to the agent.
      expect(keyCalls()).toEqual([])
      expect(dataFrames()).toEqual([])
      expect(promptPosts).toEqual([])
      expect(interruptPosts).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('fix01-hwkb-ipad.png') })
    } finally {
      await core.stop()
    }
  } finally {
    await tablet.close()
  }
})

test('coarse tablet: fresh focus survives a pending composition-close release', async ({ browser }, testInfo) => {
  // Same iPad-class coarse context as the blip test. One JS task commits the
  // composition and issues a fresh programmatic focus (real focus events),
  // then awaits a real frame — the deferred release scheduled at compend runs
  // inside that frame and must not blur the newer request. Deterministic: the
  // stale callback runs before the awaited RAF resolves. The IME sequence is
  // SYNTHETIC and the re-focus is programmatic (both labeled): headless has
  // no real CJK input method.
  const tablet = await browser.newContext({ viewport: { width: 744, height: 1000 }, hasTouch: true, isMobile: true, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  try {
    const page = await tablet.newPage()
    const promptPosts: string[] = []
    const interruptPosts: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (r.method() === 'POST' && path === '/api/prompt') promptPosts.push(r.url())
      if (r.method() === 'POST' && path === '/api/interrupt') interruptPosts.push(r.url())
    })
    const core = await startCore()
    const keyCalls = () => core.framed.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)
    const dataFrames = () => core.inbound.filter(f => f.kind === STREAM.data)
    try {
      await page.addInitScript(() => { localStorage.setItem('terminalRenderer', 'html') })
      await core.open(page)
      await page.locator('#home .card[data-pane]').click()
      await expect(page.locator('.agent-head')).toContainText('review-agent')
      const ta = page.locator('.composer textarea')
      await expect(ta).toBeVisible()
      await ta.tap()
      await expect(ta).toBeFocused()
      // Synthetic IME: the composition opens on the focused field.
      await ta.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '好' }))
      })
      // The real layout() path closes the soft keyboard mid-composition; the
      // close is remembered instead of blurring the composition.
      const kbClass = () => page.evaluate(() => document.body.classList.contains('kb'))
      await page.setViewportSize({ width: 744, height: 800 })
      await expect.poll(kbClass).toBe(true)
      await page.setViewportSize({ width: 744, height: 1000 })
      await expect.poll(kbClass).toBe(false)
      // Synthetic IME + programmatic focus, ONE task ahead of the pending
      // frame: compend+input insert the candidate, blur()/focus() issue real
      // focus events — a new edit request — then one real frame elapses, in
      // which the stale release callback must not blur the newer focus.
      const keptFocus = await ta.evaluate(async (el) => {
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '好' }))
        ;(el as HTMLTextAreaElement).value = 'draft 好'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.blur()
        el.focus()
        ;(el as HTMLTextAreaElement).setSelectionRange((el as HTMLTextAreaElement).value.length, (el as HTMLTextAreaElement).value.length)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        return document.activeElement === el
      })
      // Without session invalidation the queued release blurs the fresh focus.
      expect(keptFocus).toBe(true)
      await expect(ta).toHaveValue('draft 好')
      // Native typing after the survived request lands exactly once.
      await page.keyboard.type('kept')
      await expect(ta).toHaveValue('draft 好kept')
      // Focus bookkeeping never talks to the agent.
      expect(keyCalls()).toEqual([])
      expect(dataFrames()).toEqual([])
      expect(promptPosts).toEqual([])
      expect(interruptPosts).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('fix02-focus-session.png') })
    } finally {
      await core.stop()
    }
  } finally {
    await tablet.close()
  }
})
