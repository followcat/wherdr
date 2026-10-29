import { expect, test } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

test('one-shot modifiers preserve focus, existing keys, IME text and single-character pastes', { tag: '@webkit-phone' }, async ({ page }) => {
  const packets: { type: string, keys?: string[], text?: string }[] = []
  page.on('websocket', socket => {
    if (!socket.url().includes('/ws/term?')) return
    socket.on('framesent', ({ payload }) => { if (typeof payload === 'string') packets.push(JSON.parse(payload)) })
  })
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  const tabs = page.locator('.view-tabs')
  if (await tabs.count()) await tabs.getByRole('tab', { name: 'Terminal', exact: true }).click()
  else await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  const strip = page.getByRole('toolbar', { name: '常用按键与修饰键', exact: true })
  const shift = strip.getByRole('button', { name: 'Shift', exact: true })
  await shift.click()
  await expect(shift).toHaveAttribute('aria-pressed', 'true')
  await strip.getByRole('button', { name: '←', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').flatMap(p => p.keys!)).toContain('shift+left')
  await expect(shift).toHaveAttribute('aria-pressed', 'false')
  await strip.getByRole('button', { name: '←', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['left'])
  await strip.getByRole('button', { name: '展开或收起功能键' }).click()
  const extra = page.getByRole('toolbar', { name: '更多功能键', exact: true })
  const ctrl = extra.getByRole('button', { name: 'Ctrl', exact: true })
  const alt = extra.getByRole('button', { name: 'Alt', exact: true })
  await ctrl.click(); await alt.click()
  await strip.getByRole('button', { name: '↑', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['ctrl+alt+up'])
  await ctrl.click(); await ctrl.click()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  // The system-keyboard toggle keeps the terminal focus, so a real keystroke
  // reaches the armed modifier.
  await extra.getByRole('button', { name: '打开或关闭手机键盘' }).click()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  await strip.getByRole('button', { name: '展开或收起功能键' }).click()
  await ctrl.click()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  await page.keyboard.type('a')
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['ctrl+a'])
  await ctrl.click()
  const beforePaste = packets.length
  await page.locator('.xterm-helper-textarea').evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'x')
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  })
  await expect.poll(() => packets.slice(beforePaste).filter(p => p.type === 'terminal.input').map(p => p.text || '').join('')).toContain('x')
  expect(packets.slice(beforePaste).filter(p => p.type === 'keys')).toEqual([])
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  // A composed ASCII character is committed text, never ctrl+a: the
  // composition is tracked explicitly across compositionstart/end.
  await ctrl.click()
  const beforeIme = packets.length
  await page.locator('.xterm-helper-textarea').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.value = 'a'
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'a' }))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect.poll(() => packets.slice(beforeIme).filter(p => p.type === 'terminal.input').map(p => p.text || '').join('')).toContain('a')
  expect(packets.slice(beforeIme).filter(p => p.type === 'keys')).toEqual([])
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  // And the next real keystroke still consumes the armed modifier.
  await ctrl.click()
  await page.keyboard.type('a')
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['ctrl+a'])
})
