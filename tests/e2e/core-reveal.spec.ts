import { expect, test, type Page } from '@playwright/test'
import { startCore, STREAM } from './core'

// Opening a core terminal: the attach's replay is written behind an opaque
// cover and revealed once, at the live tail. Views must never show the blank
// screen after the paint's reset or a partly written history scrolling down.
// The fake core sends the agy-sized paint (1000 history lines) in several
// pieces with a small delay between them, like the relay does.
//
// A page-side journal samples the view every animation frame, so "covered
// until the replay is done" is read from what the user could see instead of
// being raced against it.

const HISTORY = 1000
// 76 columns of plain text: about 76 KB of history, the size of an agy replay.
const line = (n: number) => `history line ${String(n).padStart(4, '0')} ${'.'.repeat(56)}`
const SCREEN = ['acme-shop screen row 01', 'acme-shop screen row 02', 'screen ready']

// The paint as the core sends it: a soft reset, the retained history, then the
// screen at the cursor. Writing the screen after the history leaves the last
// history line just above it: the first screen the tail shows.
function paintPieces(): string[] {
  const pieces: string[] = []
  const per = Math.ceil(HISTORY / 8)
  for (let start = 0; start < HISTORY; start += per) {
    const head = start === 0 ? '\x1b[H\x1b[2J' : ''
    const body = Array.from({ length: Math.min(per, HISTORY - start) }, (_, i) => line(start + i + 1)).join('\r\n') + '\r\n'
    pieces.push(head + body)
  }
  pieces.push(SCREEN.join('\r\n'))
  return pieces
}

interface Sample { t: number, shown: boolean, cover: boolean, bg: string, rows: string }

// Every animation frame: is a terminal on screen, is it covered, on what
// background, and what do its visible rows say. Any change is recorded with
// its timestamp.
async function journal(page: Page) {
  await page.addInitScript(() => {
    // The DOM renderer keeps the visible rows as text, which the journal reads.
    localStorage.setItem('terminalRenderer', 'html')
    const frames: Sample[] = []
    ;(window as unknown as { __reveal: { frames: Sample[] } }).__reveal = { frames }
    const t0 = performance.now()
    const sample = () => {
      const coverEl = document.querySelector('.term-loading')
      const rows = document.querySelector('.xterm-rows')
      const now: Sample = {
        t: Math.round(performance.now() - t0),
        shown: Boolean(document.querySelector('.xterm')),
        cover: Boolean(coverEl),
        bg: coverEl ? getComputedStyle(coverEl).backgroundColor : '',
        rows: rows?.textContent ?? '',
      }
      const prev = frames[frames.length - 1]
      if (!prev || prev.shown !== now.shown || prev.cover !== now.cover || prev.rows !== now.rows) frames.push(now)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

test('an attach opens covered, then shows the final screen at the bottom', async ({ page }, testInfo) => {
  const pieces = paintPieces()
  const bytes = pieces.reduce((n, p) => n + Buffer.byteLength(p), 0)
  // The harness streams the pieces on the attach channel as core does.
  const core = await startCore(() => undefined, undefined, { paint: { pieces, gapMs: 8 } })
  try {
    await journal(page)
    await core.open(page)
    await page.getByRole('button', { name: /review-agent/ }).first().click()
    await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
    await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').length).toBeGreaterThan(0)
    // Revealed once the last write has been quiet for the gate's period.
    await expect(page.locator('.term-loading')).toHaveCount(0)
    await expect(page.locator('.xterm-rows')).toContainText('screen ready')

    const frames = await page.evaluate(() => (window as unknown as { __reveal: { frames: Sample[] } }).__reveal.frames)
    const terminal = frames.filter(f => f.shown)
    // The cover is opaque: the replay is hidden, not just decorated.
    const covered = terminal.filter(f => f.cover)
    expect(covered.length).toBeGreaterThan(0)
    expect(covered.every(f => f.bg !== 'rgba(0, 0, 0, 0)' && f.bg !== 'transparent')).toBe(true)
    // Nothing between the first and last piece is ever shown: every frame with
    // a terminal on screen is covered until the reveal...
    expect(terminal[0]!.cover).toBe(true)
    const revealAt = terminal.findIndex(f => !f.cover)
    expect(revealAt).toBeGreaterThan(0)
    expect(terminal.slice(0, revealAt).every(f => f.cover)).toBe(true)
    // ...it reveals once, and never covers again.
    expect(terminal.slice(revealAt).every(f => !f.cover)).toBe(true)
    // The first uncovered frame is the final screen at the bottom: the last
    // history line and the screen are visible, the first history line is not.
    const first = terminal[revealAt]!
    expect(first.rows).toContain('screen ready')
    expect(first.rows).toContain(`history line ${HISTORY}`)
    expect(first.rows).not.toContain('history line 0001')
    const atBottom = await page.locator('.xterm-viewport').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    expect(Math.round(atBottom)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('attach-reveal-phone.png') })

    // Credits went back for every piece, the whole paint included. The attach
    // channel is 3 in this harness; channel 2 carries the subscription's own
    // opening grant.
    await expect.poll(() => core.inbound
      .filter(f => f.channel === 3 && f.kind === STREAM.credit)
      .reduce((n, f) => n + f.data.readUInt32LE(0), 0))
      .toBe(bytes)
  } finally {
    await core.stop()
  }
})
