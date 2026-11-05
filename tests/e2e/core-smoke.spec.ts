import { test, expect } from '@playwright/test'
import { fixture, startCore } from './core'

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
