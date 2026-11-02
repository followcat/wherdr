import { readFileSync } from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

// A long workspace name and a long state ("quota reached · claude") at iPhone
// width: both lines of the agent header must end with an ellipsis inside their
// own box, never cut a word at the edge or run under the buttons.
const LONG_NAME = 'claude refactor the authentication middleware'
const quota = readFileSync(new URL('../fixtures/claude-limit-weekly.txt', import.meta.url), 'utf8')

test.afterEach(async () => {
  await fakeHerdr('e2e.workspace_label', { workspace_id: 'w3', label: 'demo' })
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null, agent: 'omp', status: 'idle' })
})

test('a long agent name and state truncate with an ellipsis in the header at 390 px', async ({ page }, info) => {
  await fakeHerdr('e2e.workspace_label', { workspace_id: 'w3', label: LONG_NAME })
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: quota, agent: 'claude', status: 'blocked' })
  await page.setViewportSize({ width: 390, height: 844 })
  // The phone identity shows the pane name independently of its tab name.
  await page.routeWebSocket('**/ws/events', ws => {
    const server = ws.connectToServer()
    server.onMessage(message => {
      const state = JSON.parse(message.toString())
      const named = state.panes?.find((p: { id: string }) => p.id === pane)
      if (named) named.label = LONG_NAME
      ws.send(JSON.stringify(state))
    })
  })
  await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.phone-identity-kind, .agent-meta .pill-kind')).toHaveText(/claude/i)
  const top = page.locator('.agent-top')
  const identity = top.locator('.phone-identity')
  if (await identity.count()) {
    await expect(identity.locator('.phone-identity-title')).toHaveText(LONG_NAME)
    await expect(identity.locator('.phone-identity-kind')).toHaveText('Claude')
    await expect(identity).toHaveAccessibleName(/quota reached/i)
    const layout = await identity.evaluate(el => {
      const title = el.querySelector<HTMLElement>('.phone-identity-title')!
      const kind = el.querySelector<HTMLElement>('.phone-identity-kind')!
      const style = getComputedStyle(title)
      const r = el.getBoundingClientRect()
      return {
        ellipsis: title.scrollWidth > title.clientWidth && style.textOverflow === 'ellipsis',
        kindFits: kind.scrollWidth <= kind.clientWidth,
        left: r.left, right: r.right,
        actionsLeft: el.parentElement!.querySelector('.agent-actions')!.getBoundingClientRect().left,
      }
    })
    expect(layout.ellipsis).toBe(true)
    expect(layout.kindFits).toBe(true)
    expect(layout.left).toBeGreaterThanOrEqual(44)
    expect(layout.right).toBeLessThanOrEqual(layout.actionsLeft)
    // A lone pane has no pane list in the sheet: its own line keeps the full,
    // unclipped name and the state (not the space name, which matches here).
    await identity.click()
    const current = page.locator('.phone-identity-details .phone-identity-current')
    await expect(current.locator('.phone-identity-current-title')).toHaveText(LONG_NAME)
    await expect(current.locator('.pill')).toHaveText(/quota reached/i)
    await expect(current).toContainText('Claude')
    expect(await current.locator('.phone-identity-current-title').evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true)
    await page.screenshot({ path: `.shots/agent-header-long-name-sheet-${info.project.name}.png` })
    return
  }
  await expect(top.locator('.agent-title')).toHaveText(LONG_NAME)
  await expect(top.locator('.agent-meta .pill')).toHaveText(/quota reached·claude/i)

  const box = await page.evaluate(() => {
    const el = (s: string) => document.querySelector<HTMLElement>(`.agent-top ${s}`)!
    const rect = (s: string) => {
      const r = el(s).getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }
    const text = (s: string) => {
      const e = el(s)
      const cs = getComputedStyle(e)
      return { overflowing: e.scrollWidth > e.clientWidth, ellipsis: cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' }
    }
    return {
      header: rect(''), back: rect('#btnBack'), head: rect('.agent-head'), actions: rect('.agent-actions'),
      title: rect('.agent-title'), meta: rect('.agent-meta'), pill: rect('.agent-meta .pill'), kind: rect('.agent-meta .pill-kind'),
      titleText: text('.agent-title'), kindText: text('.agent-meta .pill-kind'),
    }
  })
  await page.screenshot({ path: `.shots/agent-header-long-name-${info.project.name}.png` })

  // The name is cut by an ellipsis, inside the head column.
  expect(box.titleText).toEqual({ overflowing: true, ellipsis: true })
  expect(box.title.right).toBeLessThanOrEqual(box.head.right + 0.5)
  // The agent kind ends with an ellipsis too, inside the state line: not clipped at its edge.
  expect(box.kindText).toEqual({ overflowing: true, ellipsis: true })
  expect(box.pill.right, 'state line right edge').toBeLessThanOrEqual(box.meta.right + 0.5)
  expect(box.kind.right, 'agent kind right edge').toBeLessThanOrEqual(box.meta.right + 0.5)
  // Nothing runs under the buttons.
  expect(box.back.right).toBeLessThanOrEqual(box.head.left + 0.5)
  for (const part of [box.head, box.title, box.meta, box.pill]) expect(part.right).toBeLessThanOrEqual(box.actions.left + 0.5)
  // One row: back, head and actions share the header's height.
  for (const part of [box.back, box.head, box.actions]) {
    expect(part.top).toBeGreaterThanOrEqual(box.header.top)
    expect(part.bottom).toBeLessThanOrEqual(box.header.bottom)
  }
  expect(box.header.bottom - box.header.top).toBeLessThan(60)
})
