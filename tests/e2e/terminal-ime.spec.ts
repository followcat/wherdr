import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

async function openTerminal(page: Page) {
  const packets: { type: string, keys?: string[], text?: string }[] = []
  page.on('websocket', socket => {
    if (!socket.url().includes('/ws/term?')) return
    socket.on('framesent', ({ payload }) => { if (typeof payload === 'string') packets.push(JSON.parse(payload)) })
  })
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('#agent .agent-title')).not.toHaveText('—')
  const tabs = page.locator('.view-tabs')
  if (await tabs.count()) await tabs.getByRole('tab', { name: 'Terminal', exact: true }).click()
  else await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Show or hide terminal keys', exact: true })
  const phone = await toggle.count() > 0
  if (phone) await toggle.click()
  const bar = phone ? page.getByRole('group', { name: 'Terminal function keys', exact: true }) : page.getByRole('toolbar', { name: 'Keys', exact: true })
  const more = bar.getByRole('button', { name: 'Show or hide function keys', exact: true })
  if (phone) await more.click()
  await bar.getByRole('button', { name: phone ? 'Show or hide the phone keyboard' : 'Type in terminal', exact: true }).click()
  if (phone) await more.click()
  const textarea = page.locator('.xterm-helper-textarea')
  await expect(textarea).toBeFocused()
  return { packets, bar, textarea }
}

test('an IME ASCII commit after keyCode 229 stays text with Ctrl armed', { tag: '@webkit-phone' }, async ({ page }) => {
  const { packets, bar, textarea } = await openTerminal(page)
  const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true })
  await ctrl.click()
  const before = packets.length
  // Reproduce the browser event ordering through xterm, including its
  // deferred composition send. insertText alone does not exercise this.
  await textarea.evaluate(el => {
    el.value = ''
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.value = 'a'
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'a' }))
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Process', keyCode: 229, isComposing: false }))
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a', inputType: 'insertCompositionText' }))
  })
  await expect.poll(() => packets.slice(before).filter(p => p.type === 'terminal.input').map(p => p.text || '').join('')).toBe('a')
  expect(packets.slice(before).filter(p => p.type === 'keys')).toEqual([])
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  // A subsequent ordinary key still uses the virtual modifier exactly once.
  await ctrl.click()
  const beforeKey = packets.length
  await page.keyboard.type('a')
  await expect.poll(() => packets.slice(beforeKey).filter(p => p.type === 'keys').map(p => p.keys)).toEqual([['ctrl+a']])
})

test('cancelling IME leaves the first real Alt+Left shortcut intact', { tag: '@webkit-phone' }, async ({ page }) => {
  const { packets, bar, textarea } = await openTerminal(page)
  const alt = bar.getByRole('button', { name: 'Alt', exact: true })
  await alt.click()
  await textarea.evaluate(el => {
    el.value = ''
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
  const before = packets.length
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => packets.slice(before).filter(p => p.type === 'keys').map(p => p.keys)).toEqual([['alt+left']])
  expect(packets.slice(before).filter(p => p.type === 'terminal.input')).toEqual([])
  await expect(alt).toHaveAttribute('aria-pressed', 'false')
})

test('a real capital keeps Shift when virtual Alt is armed', { tag: '@webkit-phone' }, async ({ page }) => {
  const { packets, bar } = await openTerminal(page)
  const alt = bar.getByRole('button', { name: 'Alt', exact: true })
  await alt.click()
  const before = packets.length
  await page.keyboard.type('A')
  await expect.poll(() => packets.slice(before).filter(p => p.type === 'keys').map(p => p.keys)).toEqual([['alt+shift+a']])
  expect(packets.slice(before).filter(p => p.type === 'terminal.input')).toEqual([])
  await expect(alt).toHaveAttribute('aria-pressed', 'false')
})
