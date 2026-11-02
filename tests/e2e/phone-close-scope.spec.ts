// Phone closes from the pane sheet (header identity) and the tab overview:
// each one says what goes and what stays, cancelling closes nothing, and a
// close that grew while it was being confirmed is confirmed again.
// Closes are answered here (routes), so the shared fake session stays intact.
import { expect, test, type Page, type WebSocketRoute } from './test'
import { OMP_CHAT_PANE, SPLIT_CHAT_PANE, SPLIT_TAB } from './scenario.mjs'

test.skip(({ isMobile }) => !isMobile, 'phone pane sheet')

type State = { panes: { id: string, tab: string, workspace: string, label?: string | null }[], tabs: { id: string, workspace: string, label: string, number: number, layout: unknown }[] }

// Live state the test can change: every events message goes through `edit`.
async function liveState(page: Page, edit: (s: State) => void = () => {}) {
  let socket: WebSocketRoute | null = null
  let last: State | null = null
  let change = edit
  await page.routeWebSocket('**/ws/events', ws => {
    socket = ws
    const server = ws.connectToServer()
    server.onMessage(message => {
      const state = JSON.parse(message.toString())
      if (state.panes) { change(state); last = state }
      ws.send(JSON.stringify(state))
    })
  })
  return {
    // Changes the state now (as Herdr would push it) and for the next messages.
    push(next: (s: State) => void) {
      const prev = change
      change = s => { prev(s); next(s) }
      if (last && socket) { next(last); socket.send(JSON.stringify(last)) }
    },
  }
}
// Records the close calls and answers them without closing anything.
async function recordCloses(page: Page) {
  const calls: Record<string, unknown>[] = []
  await page.route('**/api/close', route => { calls.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/space', route => {
    const body = route.request().postDataJSON()
    if (!String(body.op).endsWith('.close')) return route.continue()
    calls.push(body)
    return route.fulfill({ json: { ok: true } })
  })
  return calls
}
const sheetButton = (page: Page, name: string | RegExp) => page.locator('.hw-sheet .menu > button').filter({ hasText: name })
const confirmText = (page: Page) => page.locator('.confirm p')

test('a lone pane has one close action, whose confirmation says the space closes too; cancel keeps it', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const calls = await recordCloses(page)
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await page.locator('.phone-identity').click()
  await expect(sheetButton(page, 'Close this conversation')).toBeVisible()
  await expect(page.locator('.hw-sheet .menu > button').filter({ hasText: /^Close/ })).toHaveCount(1)
  await expect(sheetButton(page, 'Close tab')).toHaveCount(0)
  await expect(sheetButton(page, 'Close entire space…')).toHaveCount(0)
  await sheetButton(page, 'Close this conversation').click()
  await expect(confirmText(page)).toContainText('Close the conversation with')
  await expect(confirmText(page)).toContainText('will be stopped.')
  await expect(confirmText(page)).toContainText('It is the last pane of space “demo”: the space closes too.')
  await expect(page.getByRole('button', { name: 'Close conversation', exact: true })).toBeVisible()
  await page.screenshot({ path: `.shots/${info.project.name}-close-lone-pane.png` })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmText(page)).toHaveCount(0)
  expect(calls).toEqual([])
  await expect(page).toHaveURL(new RegExp(`${OMP_CHAT_PANE}$`))
})

test('among several panes, closing the conversation closes only it; the whole space is a separate action', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const calls = await recordCloses(page)
  await page.goto(`/#/a/${SPLIT_CHAT_PANE}`)
  await page.locator('.phone-identity').click()
  await expect(page.locator('.hw-sheet .menu-group').filter({ hasText: 'Space “split”' })).toBeVisible()
  await expect(sheetButton(page, 'Close entire space…')).toContainText('1 tab · 2 panes')
  await page.screenshot({ path: `.shots/${info.project.name}-close-sheet-split.png`, fullPage: true })
  await sheetButton(page, 'Close this conversation').click()
  await expect(confirmText(page)).toContainText('Only this pane closes: the other pane of tab')
  await expect(confirmText(page)).toContainText('stays open.')
  await expect(confirmText(page)).not.toContainText('space closes')
  await page.screenshot({ path: `.shots/${info.project.name}-close-pane-among-others.png` })
  await page.getByRole('button', { name: 'Close conversation', exact: true }).click()
  await expect.poll(() => calls).toEqual([{ pane_id: SPLIT_CHAT_PANE, close_group: false }])

  // The whole space: named tabs, pane count, what stops; cancel then confirm.
  calls.length = 0
  await page.goto(`/#/a/${SPLIT_CHAT_PANE}`)
  await page.reload()
  await page.locator('.phone-identity').click()
  await sheetButton(page, 'Close entire space…').click()
  await expect(confirmText(page)).toContainText('Close space “split”? Its 1 tab')
  await expect(confirmText(page)).toContainText('and 2 panes will close.')
  await expect(confirmText(page)).toContainText('will be stopped.')
  await page.screenshot({ path: `.shots/${info.project.name}-close-entire-space.png` })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls).toEqual([])
  await page.locator('.phone-identity').click()
  await sheetButton(page, 'Close entire space…').click()
  await page.locator('.confirm').getByRole('button').last().click()
  await expect.poll(() => calls).toEqual([expect.objectContaining({ op: 'workspace.close', workspace_id: 'w9', close_group: false })])
})

test('the only pane of a tab closes that tab and says the other tabs stay open', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const calls = await recordCloses(page)
  await liveState(page, s => {
    const p = s.panes.find(x => x.id === OMP_CHAT_PANE)!
    if (s.tabs.some(t => t.id === 'w3:t2')) return
    s.tabs.push({ id: 'w3:t2', workspace: p.workspace, label: 'notes', number: 2, layout: null })
    s.panes.push({ ...p, id: 'w3:p2', tab: 'w3:t2', label: 'notes agent' })
  })
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await page.locator('.phone-identity').click()
  await expect(sheetButton(page, 'Close entire space…')).toContainText('2 tabs · 2 panes')
  await sheetButton(page, 'Close this conversation').click()
  await expect(confirmText(page)).toContainText('the tab closes too. The other tab of space “demo” stays open.')
  await page.screenshot({ path: `.shots/${info.project.name}-close-only-pane-of-tab.png` })
  await page.getByRole('button', { name: 'Close conversation', exact: true }).click()
  await expect.poll(() => calls).toEqual([{ pane_id: OMP_CHAT_PANE, close_group: false }])
})

test('a close that grew during its confirmation is confirmed again before running', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const calls = await recordCloses(page)
  const live = await liveState(page)
  await page.goto(`/#/a/${SPLIT_CHAT_PANE}`)
  await page.locator('.phone-identity').click()
  await sheetButton(page, 'Close this conversation').click()
  await expect(confirmText(page)).toContainText('Only this pane closes')
  // The other pane of the tab goes meanwhile: this close would now take the tab and the space.
  live.push(s => { s.panes = s.panes.filter(p => p.id !== 'w9:p2') })
  await page.getByRole('button', { name: 'Close conversation', exact: true }).click()
  await expect(confirmText(page)).toContainText('It is the last pane of space “split”: the space closes too.')
  await page.screenshot({ path: `.shots/${info.project.name}-close-refreshed.png` })
  expect(calls).toEqual([])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmText(page)).toHaveCount(0)
  expect(calls).toEqual([])
})

test('the tab overview closes the tab with its panes, said in the menu and the confirmation', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const calls = await recordCloses(page)
  await page.goto(`/#/t/${SPLIT_TAB}`)
  await page.getByRole('button', { name: 'Tab options', exact: true }).click()
  await expect(sheetButton(page, 'Close tab')).toContainText('Closes its 2 panes')
  await page.screenshot({ path: `.shots/${info.project.name}-close-tab-overview-menu.png`, fullPage: true })
  await sheetButton(page, 'Close tab').click()
  await expect(confirmText(page)).toContainText('Close tab')
  await expect(confirmText(page)).toContainText('2 panes will close.')
  await page.screenshot({ path: `.shots/${info.project.name}-close-tab-overview-confirm.png` })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls).toEqual([])
})
