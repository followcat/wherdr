import { expect, test, type Page } from '@playwright/test'
import { startCore, STREAM } from './core'

// Virtual keys and IME through the fake herdr-core socket (tests/e2e/core.ts):
// the strip arms one-shot modifiers, real composition event order goes through
// xterm's own composition helper, and the spec reads the exact DATA frames and
// terminal.keys calls the core received — never just the emitted packets.
// Native OS IME engines stay physical-device checks; the browser sequences
// here reproduce the documented event ordering (see CONTRIBUTING.md).

type Core = Awaited<ReturnType<typeof startCore>>

const tick = (page: Page, ms = 120) => page.clock.runFor(ms)
const dataIn = (core: Core) => core.inbound.filter(f => f.kind === STREAM.data).map(f => f.data.toString())
const keyCalls = (core: Core) => core.framed.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)

async function openTerminal(page: Page, core: Core) {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await core.open(page)
  await page.getByRole('button', { name: /review-agent/ }).first().click()
  await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
  await expect(page.locator('.xterm')).toBeVisible()
  await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').length).toBeGreaterThan(0)
}

async function openStrip(page: Page) {
  await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
  const bar = page.getByRole('group', { name: 'Terminal function keys', exact: true })
  await expect(bar).toBeVisible()
  return bar
}

// The browser event ordering of a composition, through xterm's own helper —
// insertText alone does not exercise the deferred commit path. Returns the
// textarea locator for chaining.
function compose(page: Page, value: string, endData: string) {
  return page.locator('.xterm-helper-textarea').evaluate((el, { value, endData }) => {
    el.value = ''
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.value = value
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: endData }))
  }, { value, endData })
}

test('IME commits stay exact text through compositionend, keyCode 229 and cancellation', async ({ page }) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: 'ready\r\n' })
  try {
    await page.clock.install()
    await openTerminal(page, core)
    const bar = await openStrip(page)
    const ta = page.locator('.xterm-helper-textarea')
    const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true })
    let keys = keyCalls(core).length

    // An ASCII commit after compositionend + keyCode 229 is text, never the
    // armed Ctrl chord — and it still clears the modifier like any text.
    await ctrl.click()
    await ta.evaluate(el => {
      el.value = ''
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'a'
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'a' }))
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Process', keyCode: 229, isComposing: false }))
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a', inputType: 'insertCompositionText' }))
    })
    await expect.poll(async () => { await tick(page); return dataIn(core).filter(d => d === 'a').length }).toBe(1)
    expect(keyCalls(core).slice(keys)).toEqual([])
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
    // The next ordinary key spends exactly one armed modifier.
    await ctrl.click()
    await ta.focus()
    await page.keyboard.press('a')
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['ctrl+a']])
    keys = keyCalls(core).length

    // An armed modifier never turns a commit into a chord: candidate edits
    // while composing send nothing, the pinyin commit arrives once, the
    // modifier clears and no warning appears.
    await ctrl.click()
    await ta.evaluate(el => {
      el.value = ''
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'n'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'n', inputType: 'insertCompositionText' }))
      el.value = 'ni'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ni', inputType: 'insertCompositionText' }))
    })
    await tick(page)
    expect(dataIn(core).filter(d => d === 'n' || d === 'ni')).toEqual([])
    await ta.evaluate(el => {
      el.value = '你好'
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
    })
    await expect.poll(async () => { await tick(page); return dataIn(core).filter(d => d === '你好').length }).toBe(1)
    expect(keyCalls(core).slice(keys)).toEqual([])
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.hw-toast-title')).toHaveCount(0)

    // Same contract for a Cantonese commit with Alt armed.
    const alt = bar.getByRole('button', { name: 'Alt', exact: true })
    await alt.click()
    await compose(page, '唔該', '唔該')
    await expect.poll(async () => { await tick(page); return dataIn(core).filter(d => d === '唔該').length }).toBe(1)
    expect(keyCalls(core).slice(keys)).toEqual([])
    await expect(page.locator('.hw-toast-title')).toHaveCount(0)
    // The commit cleared Alt like any text: nothing armed leaks between cases.
    await expect(alt).toHaveAttribute('aria-pressed', 'false')

    // A cancelled composition produces nothing, spends no armed modifier, and
    // the very next ordinary key still becomes the armed chord.
    await alt.click()
    const dataBefore = dataIn(core).length
    await ta.evaluate(el => {
      el.value = ''
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'a'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a', inputType: 'insertCompositionText' }))
      // The candidate is dismissed: the textarea is empty before the end event.
      el.value = ''
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    })
    await tick(page)
    expect(dataIn(core)).toHaveLength(dataBefore)
    await ta.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['alt+left']])
    keys = keyCalls(core).length
    expect(dataIn(core)).toHaveLength(dataBefore)
    await expect(alt).toHaveAttribute('aria-pressed', 'false')

    // A real capital keeps the keyboard's Shift on top of the armed Alt.
    await alt.click()
    await ta.focus()
    await page.keyboard.type('A')
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['alt+shift+a']])
    keys = keyCalls(core).length
    expect(dataIn(core)).toHaveLength(dataBefore)
    await expect(alt).toHaveAttribute('aria-pressed', 'false')

    // A one-character paste stays text and still clears the armed modifier.
    await ctrl.click()
    await ta.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', 'x')
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })
    await expect.poll(() => dataIn(core).length).toBe(dataBefore + 1)
    expect(dataIn(core).at(-1)).toBe('x')
    expect(keyCalls(core).slice(keys)).toEqual([])
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await core.stop()
  }
})

test('the strip spends one modifier, falls back without attach, survives close and reorder', async ({ page }, testInfo) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: 'ready\r\n' })
  try {
    await page.clock.install()
    await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
    // Start on the conversation, before any terminal attach: the strip's keys
    // must take the /api/input fallback and produce exactly one named call.
    await core.open(page)
    await page.getByRole('button', { name: /review-agent/ }).first().click()
    await expect(page.locator('.composer')).toBeVisible()
    const bar = await openStrip(page)
    await bar.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await bar.getByRole('button', { name: 'Alt', exact: true }).click()
    await bar.getByRole('button', { name: 'Right arrow', exact: true }).click()
    await expect.poll(() => core.calls.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys)).toEqual([['ctrl+alt+right']])
    // Nothing went through the framed stream: there is no attach at all yet.
    expect(core.framed.filter(c => c.method === 'terminal.keys')).toEqual([])
    expect(core.framed.filter(c => c.method === 'terminal.attach')).toEqual([])
    // The keyboard key drives the composer field in conversation mode.
    await bar.getByRole('button', { name: 'Show or hide the phone keyboard', exact: true }).click()
    await expect(page.locator('.composer textarea')).toBeFocused()
    await bar.getByRole('button', { name: 'Show or hide the phone keyboard', exact: true }).click()
    await expect(page.locator('.composer textarea')).not.toBeFocused()

    // Now the terminal attaches; the same strip uses the live socket instead.
    await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').length).toBe(1)
    const ta = page.locator('.xterm-helper-textarea')
    const toggle = page.getByRole('button', { name: 'Show or hide terminal keys', exact: true })
    const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true })
    let keys = keyCalls(core).length

    // Closing the strip drops the armed modifiers.
    await ctrl.click()
    await expect(ctrl).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(page.getByRole('group', { name: 'Terminal function keys' })).toHaveCount(0)
    await openStrip(page)
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')

    // A pending composition survives closing, reopening and reordering the
    // strip, with the textarea focused the whole time.
    await ta.focus()
    await ta.evaluate(el => {
      el.value = ''
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'a'
    })
    await toggle.click()
    await toggle.click()
    await expect(ta).toBeFocused()
    const ids = await page.locator('.vk-strip button').evaluateAll(els => els.map(el => el.getAttribute('data-key')))
    const reordered = [ids[1], ids[0], ...ids.slice(2)]
    await page.evaluate((order) => {
      localStorage.setItem('phoneKeyOrder', JSON.stringify(order))
      dispatchEvent(new StorageEvent('storage', { key: 'phoneKeyOrder', newValue: JSON.stringify(order) }))
    }, reordered)
    await expect(page.locator('.vk-strip button').first()).toHaveAttribute('data-key', ids[1]!)
    await expect(ta).toBeFocused()
    await ta.evaluate(el => {
      el.value = 'a'
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'a' }))
    })
    await expect.poll(async () => { await tick(page); return dataIn(core).filter(d => d === 'a').length }).toBe(1)

    // One ordinary key spends the modifier exactly once; the next is text.
    await ctrl.click()
    await ta.focus()
    await page.keyboard.press('a')
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['ctrl+a']])
    keys = keyCalls(core).length
    await page.keyboard.press('b')
    await expect.poll(() => dataIn(core).at(-1)).toBe('b')
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')

    // Strip chords reach core as exactly one canonical name, announced readably.
    await ctrl.click()
    await bar.getByRole('button', { name: 'Alt', exact: true }).click()
    await bar.getByRole('button', { name: 'Up arrow', exact: true }).click()
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['ctrl+alt+up']])
    keys = keyCalls(core).length
    await expect(bar.locator('.vk-announcement')).toHaveText('Ctrl + Alt + ↑')
    await page.screenshot({ path: testInfo.outputPath(`04-keys-${testInfo.project.name}-strip.png`) })
    await bar.getByRole('button', { name: 'Shift', exact: true }).click()
    await bar.getByRole('button', { name: 'Left arrow', exact: true }).click()
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['shift+left']])
    keys = keyCalls(core).length
    await bar.getByRole('button', { name: 'Ctrl+C', exact: true }).click()
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['ctrl+c']])

    // The keyboard key focuses and releases the terminal textarea.
    await ta.blur()
    await bar.getByRole('button', { name: 'Show or hide the phone keyboard', exact: true }).click()
    await expect(ta).toBeFocused()
    await bar.getByRole('button', { name: 'Show or hide the phone keyboard', exact: true }).click()
    await expect(ta).not.toBeFocused()
  } finally {
    await core.stop()
  }
})

test('armed modifiers keep unrepresentable punctuation as text with feedback', async ({ page }) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: 'ready\r\n' })
  try {
    await page.clock.install()
    await openTerminal(page, core)
    const bar = await openStrip(page)
    const ta = page.locator('.xterm-helper-textarea')
    const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true })
    let keys = keyCalls(core).length
    // `ctrl+]` fails the name grammar; `ctrl+plus` passes it but herdr-core
    // has no such alias. Neither may be consumed into a rejected named key —
    // the typed text goes through, the modifier clears and the user is told.
    for (const ch of [']', '+']) {
      await ctrl.click()
      await ta.focus()
      await page.keyboard.type(ch)
      await expect.poll(async () => { await tick(page); return dataIn(core).at(-1) }).toBe(ch)
      await expect(page.locator('.hw-toast-title')).toContainText('Chord not applied — text sent as typed')
      await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
    }
    expect(keyCalls(core).slice(keys)).toEqual([])
    // The representable partner still works right after.
    await ctrl.click()
    await ta.focus()
    await page.keyboard.press('a')
    await expect.poll(() => keyCalls(core).slice(keys)).toEqual([['ctrl+a']])
  } finally {
    await core.stop()
  }
})

test('every strip target is at least 44px and never overlaps a neighbor', async ({ page }, testInfo) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: 'ready\r\n' })
  try {
    await page.clock.install()
    await openTerminal(page, core)
    await openStrip(page)
    await page.screenshot({ path: testInfo.outputPath(`04-keys-${testInfo.project.name}-geometry.png`) })
    // Theoretical hitbox for every key — its own border box unioned with a
    // positioned ::after, whose offsets resolve against the button's padding
    // box (inside the border), all in strip-content coordinates so off-screen
    // keys count too. Native elementFromPoint seam probes then verify real
    // tap ownership wherever the seam can be scrolled into view — off-screen
    // buttons would probe null, so those seams rely on the computed bounds.
    const { hits, seams } = await page.locator('.vk-strip button').evaluateAll(els => {
      const strip = els[0]!.parentElement!
      const s = strip.getBoundingClientRect()
      const sl0 = strip.scrollLeft
      const px = (v: string) => parseFloat(v) || 0
      const hits = els.map(el => {
        const r = el.getBoundingClientRect()
        const b = getComputedStyle(el)
        const p = getComputedStyle(el, '::after')
        const on = p.content !== 'none' && p.position === 'absolute'
        return {
          left: Math.min(r.left, on ? r.left + px(b.borderLeftWidth) + px(p.left) : r.left) - s.left + sl0,
          right: Math.max(r.right, on ? r.right - px(b.borderRightWidth) - px(p.right) : r.right) - s.left + sl0,
          top: Math.min(r.top, on ? r.top + px(b.borderTopWidth) + px(p.top) : r.top) - s.top,
          bottom: Math.max(r.bottom, on ? r.bottom - px(b.borderBottomWidth) - px(p.bottom) : r.bottom) - s.top,
          midY: r.top + r.height / 2,
        }
      })
      const ownerIdx = (x: number, y: number) => els.findIndex(el => {
        const hit = document.elementFromPoint(x, y)
        return hit === el || (hit !== null && el.contains(hit))
      })
      const seams: { i: number, left: number, right: number, skipped?: boolean }[] = []
      for (let i = 1; i < els.length; i++) {
        const prev = hits[i - 1]!, cur = hits[i]!
        // Scroll the seam to the middle of the scrollport before probing
        // inside each neighboring hitbox.
        strip.scrollLeft = Math.max(0, (prev.right + cur.left) / 2 - strip.clientWidth / 2)
        const sNow = strip.getBoundingClientRect()
        const sl = strip.scrollLeft
        const toX = (contentX: number) => contentX + sNow.left - sl
        const y = prev.midY
        // Probe a full pixel inside each edge: elementFromPoint quantizes
        // sub-pixel coordinates, so half-pixel probes land on the shared
        // boundary where the later key legitimately wins.
        const x1 = toX(prev.right - 1.25), x2 = toX(cur.left + 1.25)
        const visible = (x: number) => x >= sNow.left && x <= sNow.right && x >= 0 && x <= innerWidth
        seams.push(visible(x1) && visible(x2)
          ? { i, left: ownerIdx(x1, y), right: ownerIdx(x2, y) }
          : { i, left: -1, right: -1, skipped: true })
      }
      strip.scrollLeft = sl0
      return { hits, seams }
    })
    expect(hits.length).toBeGreaterThan(10)
    // Every key — first, last and everything between — carries a >=44px
    // target that never reaches into a neighbor's.
    for (const h of hits) {
      expect(h.right - h.left).toBeGreaterThanOrEqual(44)
      expect(h.bottom - h.top).toBeGreaterThanOrEqual(44)
    }
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.left).toBeGreaterThanOrEqual(hits[i - 1]!.right)
    const probed = seams.filter(s => !s.skipped)
    expect(probed.length).toBeGreaterThan(0)
    for (const s of probed) {
      expect(s.left).toBe(s.i - 1)
      expect(s.right).toBe(s.i)
    }
  } finally {
    await core.stop()
  }
})
