import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fixture, startCore, type Call } from './core'

// ModelPicker on the fake core: the phone opens the agent's /model menu
// through the picker, picks a model, and the switch goes out as terminal
// keys — `/model` typed, one `down`, then `s` (this session only, never
// Enter). The fake answers terminal.read from the picker's own key phase,
// and the pill shows the verified model after the state picks it up.
const WORK = '/workspace/demo'
const CLAUDE = {
  address: 'host-a/t5', name: 'demo-claude', cwd: WORK, state: 'live', template: 'claude', agent: 'claude',
  labels: {}, argv: ['claude'], created_ms: 1700000050000, screen: 'exact', cols: 80, rows: 24,
  status: { state: 'idle' },
}
const fix = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const IDLE = fix('core-screens/claude-idle.txt')
const MENU: Record<number, string> = { 1: fix('claude-model-1.txt'), 2: fix('claude-model-cursor2.txt'), 11: fix('claude-model-2.txt') }

test('model picker: open, pick, post /api/model, pill updates', async ({ page }) => {
  // The agent's own TUI state: closed (idle) or the /model menu at a row.
  // terminal.send/keys move it; the picker's every read sees the result.
  let menu = false
  let cursor = 1
  const screen = () => !menu ? IDLE : MENU[cursor] || MENU[11]!
  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [CLAUDE] }
    : call.method === 'terminal.read' && call.params.terminal === CLAUDE.address ? { text: screen() }
    : call.method === 'terminal.get' && call.params.terminal === CLAUDE.address ? { pid: 42424242, argv: CLAUDE.argv }
    : call.method === 'terminal.send' && call.params.terminal === CLAUDE.address ? (() => {
      if (call.params.text === '/model') { menu = true; cursor = 1 }
      return { sent: true, started: false, turn: 0 }
    })()
    : call.method === 'terminal.keys' && call.params.terminal === CLAUDE.address ? (() => {
      const keys = (call.params.keys as string[]) || []
      if (keys.includes('esc')) { menu = false; cursor = 1 }
      else if (menu) {
        cursor = Math.min(11, Math.max(1, cursor + keys.filter(k => k === 'down').length - keys.filter(k => k === 'up').length))
        if (keys.includes('s') || keys.includes('enter')) menu = false
      }
      return { status: null, turn: 0 }
    })()
    : call.method === 'machine.exec' ? (() => {
      const argv = call.params.argv as string[]
      const stdout = argv[2] === 'printf %s "$HOME"' ? Buffer.from('/home/user') : Buffer.alloc(0)
      return { code: 0, stdout: stdout.toString('base64'), stderr: '' }
    })()
    : call.method === 'doc.get' ? { value: null, version: 1 }
    : call.method === 'events.subscribe' ? { channel: 2, seq: 1, terminals: [CLAUDE] }
    : undefined)
  try {
    await core.open(page)
    await page.getByRole('button', { name: /demo-claude/ }).first().click()
    await expect(page).toHaveURL(/#\/(a|t)\//)
    await expect(page.locator('.agent-top')).toBeVisible()
    const toChat = page.getByRole('button', { name: 'Conversation', exact: true })
    if (await toChat.count() && await toChat.getAttribute('aria-pressed') === 'false') await toChat.click()
    // Focus the composer field: the footer (and its model picker) expands.
    await page.locator('.prompt-input').first().click()
    const pick = page.locator('.model-pick:not(.effort-pick)')
    await expect(pick).toBeVisible()
    await pick.click()
    // The list read drives the agent's menu: /model typed, then the rows read.
    await expect(page.locator('.hw-dropdown.model-menu')).toBeVisible()
    await expect(page.locator('.model-menu').getByText('For this session only')).toBeVisible()
    await expect.poll(() => core.calls.filter(c => c.method === 'terminal.send').map(c => c.params.text)).toContain('/model')
    const post = page.waitForRequest(r => r.url().includes('/api/model') && r.method() === 'POST')
    await page.locator('.model-menu').locator(':text-is("Opus 5.5")').first().click()
    const body = (await post).postDataJSON()
    expect(body.pane_id).toMatch(/:p[0-9a-f]+$/)
    expect(body.label).toBe('Opus 5.5')
    // The wire: /model, one `down` (row 1 → 2), then `s` — Enter never leaves
    // (it would write the account default).
    await expect.poll(() => core.calls.filter(c => c.method === 'terminal.keys').map(c => (c.params as { keys: string[] }).keys))
      .toEqual(expect.arrayContaining([['down'], ['s']]))
    expect(core.calls.some(c => c.method === 'terminal.keys' && (c.params.keys as string[]).includes('enter'))).toBe(false)
    // The verified pick lands on the pane's model (the phone header has no
    // pill — PhoneIdentity carries status+kind only, as in v2): the poll picks
    // the verified model up and the picker's own name shows it.
    await expect.poll(async () => {
      const st = await page.evaluate(() => fetch('/api/state').then(r => r.json()))
      return st.panes[0]?.model?.label
    }).toBe('Opus 5.5')
    await expect(pick.locator('.model-name')).toHaveText('Opus 5.5')
  } finally {
    await core.stop()
  }
})
