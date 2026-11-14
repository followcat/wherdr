import { test, expect, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startCore } from './core'
import { wherdr } from '../../shared/pm/examples'

// The project sheet (General) and the task sheet (To do at its merge step, three screenshots),
// on the phone and at 1440x900, with long texts: nothing wider than the sheet, no
// sideways scroll, one vertical scroll (the sheet's body) whose end reaches the
// sheet's bottom edge. Only a browser lays
// them out, so this cannot be a component test.
const LONG = 'a-rather-long-name-without-any-space-to-check-that-it-wraps-or-shrinks'
const SHOTS = ['0123456789a1.png', '0123456789a2.png', '0123456789a3.png']

// What breaks the rule: an element past the sheet body's edges, a box that scrolls
// sideways, a box inside the body that scrolls on its own. The phone's row of
// screenshots scrolls sideways on purpose (swipe between them).
const overflows = (page: Page) => page.evaluate(() => {
  const sheet = document.querySelector<HTMLElement>('.hw-sheet')!
  const body = sheet.querySelector<HTMLElement>('[data-slot="body"]')!
  const edge = body.getBoundingClientRect()
  const name = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}[${el.getAttribute('data-testid') ?? ''}]`
  const found: string[] = []
  for (const el of [body, ...body.querySelectorAll('*')]) {
    const row = el.closest('.todo-shots')
    const r = el.getBoundingClientRect()
    if (r.width && !(row && row !== el) && (r.left < edge.left - 1 || r.right > edge.right + 1)) found.push(`wider: ${name(el)}`)
    const cs = getComputedStyle(el)
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && !row) found.push(`sideways: ${name(el)}`)
    if (el !== body && /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) found.push(`inner scroll: ${name(el)}`)
  }
  return found
})

// Scrolled to its end, the sheet's body reaches the sheet's bottom edge (its gap
// and the safe area are padding inside the scroll, not a band over the content),
// and its last element shows in full above that edge.
const bottom = (page: Page) => page.evaluate(() => {
  const sheet = document.querySelector<HTMLElement>('.hw-sheet')!
  const body = sheet.querySelector<HTMLElement>('[data-slot="body"]')!
  body.scrollTop = body.scrollHeight
  const edge = sheet.getBoundingClientRect().bottom - parseFloat(getComputedStyle(sheet).borderBottomWidth)
  const shown = [...body.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0)
  const last = Math.max(...shown.map(el => el.getBoundingClientRect().bottom))
  // `|| 0`: a sub-pixel difference rounds to -0, which toEqual tells from 0.
  return { band: Math.round(edge - body.getBoundingClientRect().bottom) || 0, clipped: last > body.getBoundingClientRect().bottom + 1 }
})

// On the phone To do's buttons are pinned (sticky): scrolled to the middle or the
// end, the bar sits on the sheet's bottom edge, with no body padding under it
// for content to scroll through.
const pinned = (page: Page) => page.evaluate(() => {
  const body = document.querySelector<HTMLElement>('.hw-sheet [data-slot="body"]')!
  const bar = body.querySelector<HTMLElement>('.todo-actions')!
  const gap = (top: number) => { body.scrollTop = top; return Math.round(body.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom) || 0 }
  return { scrolls: body.scrollHeight > body.clientHeight, middle: gap((body.scrollHeight - body.clientHeight) / 2), end: gap(body.scrollHeight), padding: getComputedStyle(body).paddingBottom }
})

test('sheets: no sideways scroll, one scroll, long texts', async ({ page, browser }, info) => {
  // Three made-up screenshots: two of a computer, one of a phone.
  const shot = async (width: number, height: number, hue: number) => {
    const p = await browser.newPage({ viewport: { width, height } })
    await p.setContent(`<body style="margin:0;background:hsl(${hue} 30% 20%);font:40px sans-serif;color:#fff;display:grid;place-items:center;height:100vh">${width}×${height}</body>`)
    const png = await p.screenshot()
    await p.close()
    return png
  }
  const images = [await shot(1440, 900, 260), await shot(1440, 900, 180), await shot(390, 844, 30)]
  const core = await startCore(() => undefined, async (data) => {
    const dir = join(data, 'projects')
    const json = (file: string, v: unknown) => writeFile(join(dir, file), JSON.stringify(v))
    for (const d of ['templates', 'tasks', 'runs', 'shots/WH-3']) await mkdir(join(dir, d), { recursive: true })
    await json('pm.json', { v: 1, enabled: true })
    await json('projects.json', { v: 1, projects: [
      { key: 'WH', name: `Project ${LONG}`, machine: '', path: `/workspace/${LONG}/${LONG}`, template: 'wherdr', base: `feature/${LONG}`, addedAt: 1 },
    ] })
    await json('templates/wherdr.json', { ...wherdr, prefs: { agent: 'claude', model: `model-${LONG}`, reviewAgent: 'codex', reviewModel: `model-${LONG}` } })
    await Promise.all(SHOTS.map((f, i) => writeFile(join(dir, 'shots/WH-3', f), images[i]!)))
    await json('tasks/WH-3.json', {
      id: 'WH-3', project: 'WH', title: `Task ${LONG}`, description: `What to do: ${LONG} ${LONG}`, type: 'visual', state: 'working', createdAt: 1,
      links: [{ label: 'PR', url: `https://example.com/pull/3?${LONG}` }],
      step: { at: 4, started: true, proofs: {}, rounds: { review: 1 }, yourTurn: { reason: 'user', badge: 'Look at the screenshots, then merge' },
        shots: { work: SHOTS.map((file, i) => ({ file, phase: 'after', at: i + 1 })) } },
    })
  })
  // On a computer, the sheets use the room it gives them.
  const wide = async (p: Page, size: string) => {
    if (size === 'desktop') expect(await p.locator('.hw-sheet').evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(880)
  }
  const check = async (p: Page, size: string) => {
    await core.open(p, '/#/settings?section=projects&project=WH&tab=general')
    await expect(p.locator('[data-testid="pm-setup-copy"], .sheet-form .settings-hint').first()).toBeVisible() // loaded
    await expect(p.getByTestId('pm-save')).toBeDisabled()
    expect(await overflows(p)).toEqual([])
    await wide(p, size)
    expect(await bottom(p)).toEqual({ band: 0, clipped: false })
    await p.screenshot({ path: `.shots/project-sheet-${size}.png`, animations: 'disabled' })

    await p.goto(`${core.url}/#/board`)
    await p.locator('[data-task="WH-3"]').click()
    await expect(p.locator('[data-tab="todo"]')).toHaveAttribute('aria-selected', 'true')
    await expect(p.getByTestId('shot')).toHaveCount(3)
    await expect.poll(() => p.getByTestId('todo-shots').locator('img').evaluateAll(l => l.every(i => (i as HTMLImageElement).complete))).toBe(true)
    expect(await overflows(p)).toEqual([])
    await wide(p, size)
    expect(await bottom(p)).toEqual({ band: 0, clipped: false })
    await p.screenshot({ path: `.shots/task-sheet-${size}.png`, animations: 'disabled' })
    if (size !== 'desktop') expect(await pinned(p)).toEqual({ scrolls: true, middle: 0, end: 0, padding: '0px' })
  }
  try {
    await mkdir('.shots', { recursive: true })
    await check(page, info.project.name)
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await check(desktop, 'desktop')
    await desktop.close()
  } finally {
    await core.stop()
  }
})
