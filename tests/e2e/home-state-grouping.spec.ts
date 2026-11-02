import { expect, test } from './test'
import fs from 'node:fs/promises'

test.describe('English interface', () => {
  const language = 'en'
  for (const compact of [true, false]) {
    test(`state grouping, ${language}, ${compact ? 'compact' : 'normal'}`, async ({ page }) => {
      await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
      const base = await (await page.request.get('/api/state')).json()
      const machineFor = (workspace: string) => ['w2', 'w3', 'w6'].includes(workspace) ? 'laptop' : workspace === 'w4' ? 'sleeping' : ''
      const keep = new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])
      base.workspaces = base.workspaces.filter((w: { id: string }) => keep.has(w.id))
      base.tabs = base.tabs.filter((t: { workspace: string }) => keep.has(t.workspace))
      base.panes = base.panes.filter((p: { workspace: string }) => keep.has(p.workspace))
      const state = { ...base,
        machines: ['', 'laptop', 'sleeping', 'mini'].map((key, i) => ({ key, label: ['Server', 'Laptop', 'Sleeping', 'Mini'][i], local: !key, status: key === 'sleeping' ? 'offline' : key === 'mini' ? 'connecting' : 'online', error: null, session: 'default' })),
        workspaces: base.workspaces.map((w: { id: string }) => ({ ...w, machine: machineFor(w.id) })),
        tabs: base.tabs.map((t: { workspace: string }) => ({ ...t, machine: machineFor(t.workspace) })),
        panes: base.panes.map((p: { id: string, workspace: string }) => ({ ...p, machine: machineFor(p.workspace), status: ['w1', 'w2'].includes(p.workspace) ? 'blocked' : ['w5', 'w6'].includes(p.workspace) ? 'working' : 'idle', prompt: undefined, screen: undefined, menu: undefined })),
      }
      await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
      await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
        version: 'state-fixture', machines: ['', 'laptop'].map((machine, i) => ({ machine,
          coordinators: i ? [{ level: 'project', repo: 'demo', pane: 'w3:p1', workspace: null }] : [],
          tasks: [{ id: `demo/${i + 1}`, repo: 'demo', n: i + 1, key: `DEMO-${i + 1}`, title: i ? 'Review navigation' : 'Approve navigation',
            panes: [{ id: `w${i + 1}:p1`, role: 'worker' }], workspace: `w${i + 1}`, group: 'needs', stage: 'asks', progress: 40, msg: 'Checking the layout', since: null }],
        })),
      } }))
      await page.addInitScript(({ language, compact }) => {
        if (localStorage.getItem('stateFixture')) return
        localStorage.setItem('stateFixture', '1')
        localStorage.setItem('herdrLanguage', language)
        localStorage.setItem('compactListV2', compact ? '1' : '0')
        localStorage.setItem('machineGroups', JSON.stringify([{ id: '*group:studio', name: 'Studio', machines: ['laptop'] }]))
      }, { language, compact })
      await page.goto('/')
      await expect(page.locator('section.machine')).toHaveCount(4)
      await expect(page.locator('.project-tree .card', { hasText: 'DEMO-1' })).toBeVisible()
      await page.goto('/#/settings?section=appearance')
      await page.getByRole('radio', { name: 'State', exact: true }).check()
      await page.goto('/')
      const tasks = page.locator('.state-group.blocked .task-row')
      await expect(tasks).toHaveCount(2)
      await expect(page.locator('.state-group.working .card')).toHaveCount(2)
      await expect(page.locator('section.machine, .project-tree, .project-lead')).toHaveCount(0)
      await expect(tasks.nth(0)).toContainText('Server')
      await expect(tasks.nth(1)).toContainText('Laptop')
      await expect(tasks.nth(0)).toContainText('demo')
      await expect(tasks.nth(0).locator('.home-task-line')).toHaveCount(compact ? 0 : 1)
      await expect(page.locator('.state-group .home-coord')).toContainText('Laptop')
      await expect(page.locator('.state-group .card-origin', { hasText: 'Sleeping' })).toHaveCount(0)
      // Online machines: a chip row at the top. Offline and reconnecting ones:
      // one line at the bottom, after the groups, with their state and known agents.
      await expect(page.locator('.state-machine')).toHaveText([/Server/, /Laptop/])
      const away = page.locator('.state-away-item')
      await expect(away).toHaveCount(2)
      await expect(away.nth(0)).toContainText('offline')
      await expect(away.nth(0)).toContainText('Sleeping')
      await expect(away.nth(0).locator('.state-away-known')).toHaveText('1')
      await expect(away.nth(1)).toHaveClass(/connecting/)
      await expect(away.nth(1)).toContainText('reconnecting')
      expect(await page.locator('.state-away').evaluate(el => {
        const groups = [...document.querySelectorAll('.state-group')]
        return groups.every(g => g.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
      expect(await page.locator('.state-machines').evaluate(el => {
        const first = document.querySelector('.state-group')
        return !!first && Boolean(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
      // A machine's own menu stays reachable from its chip.
      await page.locator('.state-machine-chip', { hasText: 'Laptop' }).click()
      await expect(page.getByRole('menuitem', { name: 'Herdr sessions' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Open the board' })).toBeVisible()
      await page.keyboard.press('Escape')
      await away.nth(0).click()
      await expect(page.getByRole('menuitem', { name: 'Connection status' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      expect(await page.locator('.state-away').evaluate(el => new Set([...el.children].map(c => Math.round(c.getBoundingClientRect().top))).size)).toBe(1)
      await fs.mkdir('.shots', { recursive: true })
      for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        await page.setViewportSize({ width, height })
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        for (const card of await tasks.all()) expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: `.shots/home-state-${language}-${compact ? 'compact' : 'normal'}-${width}.png` })
      }
      await page.locator('.machine-bar-item', { hasText: 'Studio' }).click()
      await expect(tasks).toHaveCount(1)
      await expect(tasks).toContainText('Laptop')
      await expect(page.locator('.state-machine')).toHaveText([/Laptop/])
      await expect(page.locator('.state-away')).toHaveCount(0)
      await page.reload()
      await expect(tasks).toHaveCount(1)
      expect(await page.evaluate(() => localStorage.getItem('homeGrouping'))).toBe('state')
      await page.locator('.machine-bar-item', { hasText: 'Server' }).click()
      await expect(tasks).toHaveCount(1)
      await expect(tasks).toContainText('Server')
      await page.goto('/#/settings?section=appearance')
      await page.getByRole('radio', { name: 'Machine', exact: true }).check()
      await page.goto('/')
      await expect(page.locator('.state-group')).toHaveCount(0)
      await expect(page.locator('section.machine')).toHaveCount(1)
    })
  }
})
