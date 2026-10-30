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
  const shift = bar.getByRole('button', { name: 'Shift', exact: true })
  const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true })
  const alt = bar.getByRole('button', { name: 'Alt', exact: true })
  await shift.click()
  await expect(shift).toHaveAttribute('aria-pressed', 'true')
  await bar.getByRole('button', { name: '←', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').flatMap(p => p.keys!)).toContain('shift+left')
  await expect(shift).toHaveAttribute('aria-pressed', 'false')
  await bar.getByRole('button', { name: '←', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['left'])
  await ctrl.click(); await alt.click()
  await bar.getByRole('button', { name: '↑', exact: true }).click()
  await expect.poll(() => packets.filter(p => p.type === 'keys').at(-1)?.keys).toEqual(['ctrl+alt+up'])
  await ctrl.click(); await ctrl.click()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  await bar.getByRole('button', { name: phone ? 'Show or hide the phone keyboard' : 'Type in terminal', exact: true }).click()
  if (phone) await more.click()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
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
  await ctrl.click()
  const beforeIme = packets.length
  await page.keyboard.insertText('你好')
  await expect.poll(() => packets.slice(beforeIme).filter(p => p.type === 'terminal.input').map(p => p.text || '').join('')).toContain('你好')
  expect(packets.slice(beforeIme).filter(p => p.type === 'keys')).toEqual([])
})
