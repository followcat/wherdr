import { test, expect, devices } from '@playwright/test'
import { fixture, startCore, type Call } from './core'
import { AGENT_CENSUS_SCRIPT, CMD_FILES_SCRIPT, CMD_HEADERS_SCRIPT, HOME, WORK, U1, U2, POST, POST2, b64, H, S, T, F, filesWire, hdrs } from '../cmdCoreFixture'
import { STAT_SCRIPT } from '../../server/utils/fsx'
import { at, J, modelChange, user, assistant, results } from '../cmdParserFixture'

// v3 journey on one core agent (CI on pull requests to v3): the home loads from the
// fake core, the agent opens, a file attached from the conversation is put on its
// machine, the phone key bar's navigation keys reach core by the names terminal.keys
// accepts (home, pageup…, not v2 Herdr's CSI bytes), and the terminal attaches.
// Merges the former core-attach and core-keybar specs: same agent, same opening steps.
// Also runs on webkit-phone (playwright.config.ts): the events WebSocket must open and
// deliver a state frame there, since iOS Safari can reject a handshake Chromium accepts.
test('core smoke: home, conversation attach and key bar, terminal attach', async ({ page }) => {
  const terminal = fixture.inventory.terminals[0]!
  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [{ ...terminal, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }] }
    : call.method === 'doc.get' ? { value: call.params.on ? null : { spaces: [{ id: 'sp1', name: 'Demo', folder: '/workspace/demo', tabs: [{ id: 'tbA', name: 'Main' }] }] }, version: 1 }
    : call.method === 'terminal.put' ? { path: `/remote/${call.params.name}` }
    : call.method === 'terminal.keys' ? { status: null, turn: 0 }
    : undefined)
  // Agents in the latest state frame of /ws/events (pongs and settings messages have no panes).
  let eventsPanes = -1
  page.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.endsWith('/ws/events')) return
    ws.on('framereceived', ({ payload }) => {
      try {
        const data = JSON.parse(String(payload))
        if (Array.isArray(data?.panes)) eventsPanes = data.panes.length
      } catch { /* not JSON */ }
    })
  })
  try {
    await core.open(page)
    await expect.poll(() => eventsPanes, { message: '/ws/events opens and sends a state frame with the agent' }).toBeGreaterThan(0)
    await expect(page.locator('.home-version')).toHaveText(/^wherdr v3 · herdr-core$/i)
    await page.getByRole('button', { name: /review-agent/ }).first().click()
    await expect(page).toHaveURL(/#\/(a|t)\//)
    await expect(page.locator('.agent-top')).toBeVisible()
    const toChat = page.getByRole('button', { name: 'Conversation', exact: true })
    if (await toChat.count() && await toChat.getAttribute('aria-pressed') === 'false') await toChat.click()

    // '+' → file: the path lands in the message, on the agent's own pane.
    await page.getByTestId('attach-any').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect.poll(() => core.calls.filter(c => c.method === 'terminal.put').map(c => c.params.terminal)).toContain(terminal.address)
    await expect(page.getByText('notes.txt')).toBeVisible()
    expect(page.url()).toMatch(/s[0-9a-z]+:p/)
    await expect(page.getByText('Invalid pane')).toHaveCount(0)

    // Key bar from the conversation (no terminal attached): one key proves the chain
    // button → /api/input → terminal.keys. Every key's name is checked lower, in
    // tests/keybarKeys.test.ts and tests/core-input.test.ts.
    await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
    const bar = page.getByRole('group', { name: 'Terminal function keys', exact: true })
    const response = page.waitForResponse(r => r.url().endsWith('/api/input') && r.request().method() === 'POST')
    await bar.getByRole('button', { name: 'PgUp', exact: true }).click()
    expect((await response).status()).toBe(200)
    expect(core.calls.filter(c => c.method === 'terminal.keys').map(c => c.params.keys)).toEqual([['pageup']])

    // The terminal view attaches the live terminal.
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').map(c => c.params.terminal)).toContain(terminal.address)
    await expect(page.locator('.xterm')).toBeVisible()
  } finally {
    await core.stop()
  }
})

// Command Code journey on the fake core: a live cmd process before any
// eligible transcript write is "no conversation yet"; the first persisted
// file opens the right conversation (text, tools, an inline PNG that really
// decodes); older navigation, a global-search hit, an Enter-only multiline
// send on the full remote address; a newer /clear file takes over; live
// same-cwd peers make it unavailable again. Every census/discovery/header/
// stat/read answer below is a synthetic wire — the scripts are never run.
const CMD_TERM = {
  address: 'host-a/t7', name: 'Command Code', cwd: WORK, state: 'live', template: 'command-code',
  labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' },
  argv: ['cmdc'], created_ms: 0, screen: 'exact', cols: 80, rows: 24, status: null,
}
const CMD_DIR = '-w-proj'
const PHRASE = 'zephyr-breadcrumb-42'
// A neutral 160x100 checker PNG generated once with ordinary zlib encoding:
// sized like a real reply image so its thumbnail proves rendered bounds, not
// a 1x1 speck, and the tap opens the existing viewer on real bytes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABCElEQVR42u3bMQ0AIAxFwUpBBDJwicMqQEMnkvYS5jf8W0vse0ovc5We/t9+GAgwAMAAAOsD1gesD1gfMGADAQYAGABgfcD6gPUBjwU2aO8+YMAAAAMArA9YH7A+YH3AgA0EGABgAID1AesD1gc8F9igLjoAAAYAWB+wPmB9wPqAARsIMADAAADrA9YHrA8YsIH8Dzaoiw4AgPUB6wPWB6wPGDAAwAAA6wPWB6wPWB8wYAMBBuB/MDAXHfqA9QHrAwZsIMAAAAMArA9YH7A+YH3AgA0EGABgff+D9V106APWBwzYQIABAAYAWB+wPmB9wIANBBgAYACA9QHr+x+s76JDHzBgAzXpP87KiH8WVQQmAAAAAElFTkSuQmCC'

test('command code journey: selection, rendering, search, send, /clear, peers', async ({ page, browser }, testInfo) => {
  const files = new Map<string, { body: Buffer, mtime: string, ino: number }>()
  const procs = [S(4242, { comm: 'cmdc', argv: ['cmdc'] })]
  const stat = (p: string) => { const f = files.get(p); return f ? `${f.body.length} ${f.mtime} ${f.ino} regular file` : 'x' }
  const enc = (x: string | Buffer) => ({ code: 0, stdout: Buffer.from(x).toString('base64'), stderr: '' })

  // The first Command Code file: one ~3MiB ignored record between the early
  // messages and 123 later ones. The 2 MiB tail window opens inside it,
  // aligns to the line after it, holds >=120 items and reports a positive
  // start — so "Load earlier messages" has a real page and the unique phrase
  // in pair 3 only exists above the tail.
  const s1: unknown[] = [
    { type: 'session', version: 3, id: U1, timestamp: at(0), cwd: WORK },
    modelChange(1),
  ]
  for (let i = 0; i < 4; i++) {
    s1.push(user(`u${i}`, i === 3 ? `Question ${i} about ${PHRASE}.` : `Question ${i} about the import fix.`, 10 + i * 2))
    s1.push(assistant(`a${i}`, `Answer ${i}: the import fix holds.`, 11 + i * 2))
  }
  s1.push({ type: 'padding', pad: 'x'.repeat(3 * 1024 * 1024) })
  for (let i = 4; i < 64; i++) {
    s1.push(user(`u${i}`, `Question ${i} about the import fix.`, 10 + i * 2))
    s1.push(assistant(`a${i}`, `Answer ${i}: the import fix holds.`, 11 + i * 2))
  }
  s1.push(
    user('u-shot', 'Read the screenshot I left.', 300),
    assistant('a-shot', [{ type: 'tool_use', id: 'shot-1', name: 'read_file', input: { file_path: `${WORK}/shot.png` } }], 301),
    results('r-shot', [{ tool_use_id: 'shot-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }], 302),
    assistant('a-final', 'The screenshot is rendered inline.', 303),
  )
  const s2 = [
    { type: 'session', version: 3, id: U2, timestamp: at(400), cwd: WORK },
    user('u2a', 'Fresh session after /clear.', 401),
    assistant('a2a', 'Second session starts here.', 402),
  ]
  const resume = [
    user('u3a', 'Pick the first session back up.', 500),
    assistant('a3a', 'Resumed the first session.', 501),
  ]

  const exec = (c: Call) => {
    const a = c.params?.argv
    if (!Array.isArray(a) || a[0] !== 'sh' || a[1] !== '-c') return { code: 2, stdout: '', stderr: b64('fake core: unsupported argv') }
    const script = String(a[2]); const args = a.slice(4).map(String)
    if (script === 'printf %s "$HOME"') return enc(HOME)
    if (script === AGENT_CENSUS_SCRIPT) return enc(H + procs.join('') + T(procs.length, procs.length, 0, 0))
    if (script === CMD_FILES_SCRIPT) return enc(filesWire([...files.keys()].map(p => [p, stat(p)])))
    if (script === CMD_HEADERS_SCRIPT) {
      // The header record carries the stored file's own prefix: the producer's
      // `head -c 16385` bound, and the same stat the listing reported.
      const tbl: Record<string, { st: string, body: string }> = {}
      for (const [p, f] of files) tbl[p] = { st: stat(p), body: f.body.subarray(0, 16385).toString('utf8') }
      return enc(hdrs(tbl)(args))
    }
    if (script === STAT_SCRIPT) return enc(args.map(stat).join('\n') + '\n')
    if (script.startsWith('limit=$1')) {
      // Producer: `head -c "$limit"` — the caller's maxBytes+1 IS the limit.
      const ps = args.slice(1)
      return enc(ps.map(stat).join('\n') + '\n' + ps.map(p => (files.get(p)?.body.subarray(0, Number(args[0])) ?? Buffer.alloc(0)).toString('base64')).join('\n'))
    }
    if (script.includes('tail -c +"$2"')) {
      const f = files.get(args[0]!)
      return f ? enc(f.body.subarray(Number(args[1]) - 1, Number(args[1]) - 1 + Number(args[2]))) : { code: 44, stdout: '', stderr: b64('missing') }
    }
    if (script.includes('cat "$1"')) {
      const f = files.get(args[0]!)
      return f ? enc(f.body) : { code: 44, stdout: '', stderr: b64('missing') }
    }
    return { code: 2, stdout: '', stderr: b64(`fake core: unhandled exec ${script.slice(0, 60)}`) }
  }

  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [CMD_TERM] }
    : call.method === 'events.subscribe' ? { channel: 2, seq: 1, terminals: [CMD_TERM] }
    : call.method === 'doc.get' ? { value: call.params.on ? null : { spaces: [{ id: 'sp1', name: 'Demo', folder: WORK, tabs: [{ id: 'tbA', name: 'Main' }] }] }, version: 1 }
    : call.method === 'terminal.get' && call.params.terminal === CMD_TERM.address ? { state: 'live', pid: 4242, argv: ['cmdc'], foreground: { pid: 4242 } }
    : call.method === 'terminal.send' ? { started: false }
    : call.method === 'machine.exec' ? exec(call)
    : undefined)

  // One idle chat poll is 6s of page clock; the server's own evidence cache
  // (1s real) can hold one stale reply, so each phase poll ticks the client.
  const chat = page.locator('.chat-list')
  const pollText = async (want: string) => expect.poll(async () => {
    await page.clock.runFor(7000)
    return (await chat.textContent()) ?? ''
  }, { timeout: 20_000 }).toContain(want)

  try {
    await page.clock.install()
    await core.open(page)
    await expect(page.getByRole('button', { name: /Command Code/ }).first()).toBeVisible()
    await page.getByRole('button', { name: /Command Code/ }).first().click()
    const toChat = page.getByRole('button', { name: 'Conversation', exact: true })
    if (await toChat.count() && await toChat.getAttribute('aria-pressed') === 'false') await toChat.click()

    // Process is live but nothing eligible persisted yet.
    await expect(page.locator('.chat-empty')).toContainText('No conversation for this agent yet.')
    await page.screenshot({ path: testInfo.outputPath('cmd-unavailable.png') })

    // Isolation: the spawned server's HOME lives under its owned data root —
    // the local machine reads no host quota or agent config (it used to show
    // the host's own quota on the desktop shot).
    const quotas = await (await page.request.get(`${core.url}/api/quotas`)).json() as { claude: unknown, codex: unknown }
    expect(quotas.claude).toBeNull()
    expect(quotas.codex).toBeNull()
    expect(JSON.stringify(quotas)).not.toContain('"used"')

    // First persisted assistant write opens the conversation.
    files.set(F(CMD_DIR, U1), { body: Buffer.from(J(...s1) + '\n'), mtime: POST, ino: 42 })
    await pollText('The screenshot is rendered inline.')
    await expect(chat).toContainText('Answer 63: the import fix holds.')
    const thumb = page.locator('.tool-thumbs img').first()
    await expect(thumb).toBeVisible()
    // The byte actually decodes: poll until the browser reports a size —
    // visibility alone can beat the decode. Rendered at a touchable size.
    await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    const tbox = (await thumb.boundingBox())!
    expect(tbox.width).toBeGreaterThanOrEqual(44)
    expect(tbox.height).toBeGreaterThanOrEqual(44)
    // The tap opens the existing viewer on the served bytes; its own close
    // control dismisses it again.
    await thumb.click()
    const lightbox = page.getByRole('dialog', { name: 'Image', exact: true })
    await expect(lightbox).toBeVisible()
    await expect.poll(() => lightbox.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await lightbox.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(lightbox).toBeHidden()
    // Phone layout: 44px agent header, no horizontal overflow.
    expect((await page.locator('.agent-top').boundingBox())!.height).toBeCloseTo(44, 0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
    await page.screenshot({ path: testInfo.outputPath('cmd-conversation.png') })

    // Older page: the early phrase is above the tail — absent until history
    // scrolls up. "Load earlier" proves the page exists; one scroll to the
    // top is the existing navigation — the near-top listener issues a real
    // `before` read.
    await expect(chat).not.toContainText(PHRASE)
    await expect.poll(async () => {
      await page.clock.runFor(1000)
      return page.getByRole('button', { name: 'Load earlier messages' }).isVisible()
    }).toBe(true)
    const beforeRes = page.waitForResponse(r => r.url().includes('/api/chat') && new URL(r.url()).searchParams.has('before'))
    await page.locator('.chat').evaluate((el: HTMLElement) => { el.scrollTop = 0 })
    await beforeRes
    await pollText(PHRASE)
    await expect(page.locator('.chat-note')).toContainText('Start of conversation')

    // Multiline send: exactly one terminal.send to the full remote address,
    // started:false reported honestly, no terminal.get status probe, no Enter.
    await page.getByRole('textbox', { name: /Message to Command Code/ }).fill('fix the\nimport bug')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => core.calls.filter(c => c.method === 'terminal.send').map(c => c.params))
      .toEqual([{ terminal: 'host-a/t7', text: 'fix the\nimport bug' }])
    expect(core.calls.filter(c => c.method === 'terminal.keys' && c.params?.keys?.includes?.('enter'))).toEqual([])

    // Global search lands inside the conversation on the hit's older slice.
    await page.goto(`${core.url}/#/`)
    await page.getByRole('button', { name: 'Search agents and conversations' }).first().click()
    await page.getByRole('combobox', { name: 'Search agents and conversations' }).fill(PHRASE)
    await page.clock.runFor(300)
    await page.getByRole('option', { name: new RegExp(PHRASE) }).click()
    await expect(page).toHaveURL(/#\/a\//)
    await expect(page.locator('.search-count')).toHaveText('1/1')
    await pollText(PHRASE)
    // The option must land with the hit itself inside the .chat viewport —
    // loaded DOM text is not proof of the smooth-scroll outcome. Geometry
    // polls while virtual time advances so the existing scroll settles.
    const hitMsg = chat.getByText(`Question 3 about ${PHRASE}.`, { exact: true })
    await expect(hitMsg).toHaveCount(1)
    const chatBox = page.locator('.chat')
    await expect.poll(async () => {
      await page.clock.runFor(400)
      const [h, c] = await Promise.all([hitMsg.boundingBox(), chatBox.boundingBox()])
      return h != null && c != null && h.y >= c.y && h.y + h.height <= c.y + c.height
    }, { timeout: 20_000 }).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('cmd-search.png') })

    // Desktop 1440x900: a fresh context on the installed desktop profile of
    // this engine — non-mobile, untouch, 1x scale — not the phone project's.
    const desk = await browser.newContext({
      ...(browser.browserType().name() === 'chromium' ? devices['Desktop Chrome'] : devices['Desktop Safari']),
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      serviceWorkers: 'block',
    })
    try {
      const dpage = await desk.newPage()
      expect(dpage.viewportSize()).toEqual({ width: 1440, height: 900 })
      const quotasDone = dpage.waitForResponse(r => r.url().endsWith('/api/quotas'))
      await core.open(dpage)
      // The home quotas fetch resolved: whatever would render is rendered.
      await quotasDone
      // The opened app really runs as a desktop: 1x, no coarse pointer or
      // touch points, a desktop UA.
      expect(await dpage.evaluate(() => window.devicePixelRatio)).toBe(1)
      expect(await dpage.evaluate(() => window.innerWidth)).toBe(1440)
      expect(await dpage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
      expect(await dpage.evaluate(() => navigator.maxTouchPoints)).toBe(0)
      expect(await dpage.evaluate(() => navigator.userAgent)).not.toMatch(/iPhone|Android|Mobile/)
      // Home is loaded (this is where the host's quota row used to render):
      // the isolated server has none.
      await expect(dpage.getByRole('button', { name: /Command Code/ }).first()).toBeVisible()
      await expect(dpage.locator('.quota-row')).toHaveCount(0)
      await dpage.getByRole('button', { name: /Command Code/ }).first().click()
      await expect(dpage.locator('.chat-list')).toContainText('The screenshot is rendered inline.')
      const dthumb = dpage.locator('.tool-thumbs img').first()
      await expect.poll(() => dthumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
      await expect(dpage.locator('[data-wherdr="composer-field"]')).toBeVisible()
      await dpage.screenshot({ path: testInfo.outputPath('cmd-desktop.png') })
    } finally { await desk.close() }

    // /clear: a newer persisted file wins; the previous conversation is gone.
    files.set(F(CMD_DIR, U2), { body: Buffer.from(J(...s2) + '\n'), mtime: POST2, ino: 43 })
    await pollText('Second session starts here.')
    await expect(chat).not.toContainText('The screenshot is rendered inline.')

    // A resumed session's file gets a new write — it is the newest again and
    // the conversation follows it back.
    files.set(F(CMD_DIR, U1), { body: Buffer.from(J(...s1) + J(...resume) + '\n'), mtime: '1767227000.5', ino: 42 })
    await pollText('Resumed the first session.')
    await expect(chat).not.toContainText('Second session starts here.')

    // A live same-cwd Command Code peer makes the conversation unavailable.
    procs.push(S(4343, { comm: 'cmdc', argv: ['cmdc'] }))
    await expect.poll(async () => {
      await page.clock.runFor(7000)
      return (await page.locator('.chat-empty').textContent()) ?? ''
    }, { timeout: 20_000 }).toContain('No conversation for this agent yet.')
  } finally {
    await core.stop()
  }
})
