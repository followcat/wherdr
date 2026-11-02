import { expect, test, type Locator, type Page } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

// Review comments in Changes: on one line or on a block of lines, started from
// the gutter only (the code stays plain selectable text), kept as local drafts
// and added to the message draft by Send review, never sent.
const first = { path: 'src/first.ts', status: ' M', added: 3, deleted: 2, binary: false, truncated: false, lines: [
  { kind: 'hunk', text: '@@ -7,3 +10,4 @@' }, { kind: 'context', text: ' function total() {' }, { kind: 'del', text: '-  return 1' },
  { kind: 'add', text: '+  const n = 2' }, { kind: 'add', text: '+  return n' }, { kind: 'context', text: ' }' },
  { kind: 'hunk', text: '@@ -30 +41 @@' }, { kind: 'del', text: '-old()' }, { kind: 'add', text: '+renewed()' },
] }
const second = { path: 'src/second.ts', status: ' M', added: 1, deleted: 1, binary: false, truncated: false, lines: [
  { kind: 'hunk', text: '@@ -7 +10 @@' }, { kind: 'del', text: '-old' }, { kind: 'add', text: '+second()' },
] }
const data = { git: true, root: '/project', branch: 'review-example', working: { count: 2, truncated: false, files: [first, second] } }
const shot = (page: Page, project: string, name: string) => process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-review-${name}.png` }) : Promise.resolve()

async function openChanges(page: Page, name = 'View changes') {
  await page.locator('.agent-top').getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).click()
  await expect(page.locator('.changes-view')).toBeVisible()
}
async function setup(page: Page) {
  await page.route('**/api/changes?**', r => r.fulfill({ json: data }))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
}
const field = (page: Page) => page.locator('.prompt').locator('textarea, [contenteditable="true"]').first()
const fileOf = (page: Page, path: string) => page.locator('.change-file').filter({ hasText: path })
const gutter = (f: Locator, line: string) => f.getByRole('button', { name: `Comment on line ${line}`, exact: true })
const rowOf = (f: Locator, line: string) => f.locator('.review-line', { has: f.page().getByRole('button', { name: `Comment on line ${line}`, exact: true }) })
// Opens the editor on a line or on the block from one line to another, the way
// each device does it: mouse press, drag and release; taps, then Comment.
async function comment(page: Page, mobile: boolean, f: Locator, from: string, to?: string) {
  if (mobile) {
    await gutter(f, from).tap()
    if (to) await rowOf(f, to).locator('.review-source').tap()
    await page.locator('.review-pick').getByRole('button', { name: 'Comment', exact: true }).tap()
  } else if (to) {
    await gutter(f, from).hover()
    await page.mouse.down()
    await gutter(f, to).hover()
    await page.mouse.up()
  } else await gutter(f, from).click()
  await expect(f.locator('.review-note textarea')).toBeFocused()
}

test('a block and a line go to the message draft without sending; drafts survive closing and reload', { tag: '@webkit-phone' }, async ({ page, isMobile }, info) => {
  // WebKit can spend seconds on each gesture on a slow runner. Closing,
  // reopening and reloading all verify persistence; keep every assertion's
  // normal timeout, but budget for the complete workflow on this project.
  if (info.project.name === 'webkit-desktop') test.setTimeout(60_000)
  await setup(page)
  const sent: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/(prompt|input)$/.test(new URL(r.url()).pathname)) sent.push(r.url()) })
  await field(page).fill('Existing draft')
  await openChanges(page)
  const a = fileOf(page, 'src/first.ts')
  await a.locator('summary').click()
  await shot(page, info.project.name, 'diff')
  if (isMobile) {
    // First tap: the line is chosen, nothing is written yet.
    await gutter(a, '11').tap()
    const pick = page.locator('.review-pick')
    await expect(pick).toContainText('Line 11')
    await expect(page.locator('.review-note')).toHaveCount(0)
    await rowOf(a, '13').locator('.review-source').tap()
    await expect(pick).toContainText('Lines 11–13')
    await expect(a.locator('.review-line.picked')).toHaveCount(3)
    await expect(a.locator('.review-line.out')).toHaveCount(3)
    await shot(page, info.project.name, 'block-chosen')
    await pick.getByRole('button', { name: 'Cancel', exact: true }).tap()
    await expect(pick).toHaveCount(0)
  } else {
    await rowOf(a, '11').hover()
    await expect(rowOf(a, '11').locator('.review-plus')).toHaveCSS('opacity', '1')
    await expect(rowOf(a, '12').locator('.review-plus')).toHaveCSS('opacity', '0')
    await shot(page, info.project.name, 'hover-plus')
    await gutter(a, '11').hover()
    await page.mouse.down()
    await gutter(a, '13').hover()
    await expect(a.locator('.review-line.picked')).toHaveCount(3)
    await shot(page, info.project.name, 'block-dragging')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(a.locator('.review-line.picked')).toHaveCount(0)
    await expect(page.locator('.changes-view')).toBeVisible()
  }
  await expect(page.locator('.review-note')).toHaveCount(0)
  await comment(page, isMobile, a, '11', '13')
  const note = a.locator('.review-note')
  await expect(note.locator('.review-range')).toHaveText('Lines 11–13')
  // The thread sits under the last line of the block, whose lines are marked.
  expect(await note.evaluate(el => el.previousElementSibling?.textContent)).toContain(' }')
  await expect(a.locator('.review-line.open')).toHaveCount(3)
  await note.locator('textarea').fill('Check the first call')
  await shot(page, info.project.name, 'block-editor')
  await note.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(note.locator('.review-body')).toHaveText('Check the first call')
  await expect(a.locator('.review-line.noted')).toHaveCount(3)
  await shot(page, info.project.name, 'block-saved')
  const b = fileOf(page, 'src/second.ts')
  await b.locator('summary').click()
  await comment(page, isMobile, b, '10')
  // Left open on purpose: an unsaved editor is a draft too.
  await b.locator('textarea').fill('Handle the empty case')
  await expect(page.locator('.review-toolbar [role="status"]')).toHaveText('2 review comments')
  await page.getByRole('button', { name: 'Refresh changes' }).click()
  await expect(page.locator('.review-note')).toHaveCount(2)
  await page.locator('.hw-sheet-close').click()
  await openChanges(page)
  await expect(page.locator('.review-note')).toHaveCount(2)
  await page.reload()
  await openChanges(page)
  await expect(page.locator('.review-note')).toHaveCount(2)
  await fileOf(page, 'src/second.ts').locator('summary').click()
  await expect(fileOf(page, 'src/second.ts').locator('textarea')).toHaveValue('Handle the empty case')
  const send = page.getByRole('button', { name: 'Send review', exact: true })
  await expect(send).toBeInViewport()
  await shot(page, info.project.name, 'two-files')
  await send.click()
  await expect(page.locator('.changes-view')).toHaveCount(0)
  const expected = 'Existing draft\n\nPlease review these points:\n\nsrc/first.ts:11-13 — Check the first call\n    +  const n = 2\n    +  return n\n     }\n\nsrc/second.ts:10 — Handle the empty case\n    +second()'
  await expect(field(page)).toHaveValue(expected)
  expect(sent).toEqual([])
  if (process.env.SHOTS) {
    await expect(page.locator('.hw-sheet-close')).toBeHidden()
    await shot(page, info.project.name, 'message-draft')
  }
  await openChanges(page)
  await expect(page.locator('.review-note')).toHaveCount(0)
})

test('deleted line, edit, delete in two steps, block gone from the diff and discard', async ({ page, isMobile }, info) => {
  // This workflow also opens the modal twice; see the persistence case above.
  if (info.project.name === 'webkit-desktop') test.setTimeout(60_000)
  await setup(page)
  await openChanges(page)
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  await comment(page, isMobile, f, '8 (old line)', '11')
  const note = page.locator('.review-note')
  await expect(note.locator('.review-range')).toHaveText('Line 11 + old line 8')
  await note.locator('textarea').fill('Keep this behaviour')
  await note.getByRole('button', { name: 'Comment', exact: true }).click()
  await note.getByRole('button', { name: 'Edit comment', exact: true }).click()
  await expect(note.locator('textarea')).toBeFocused()
  await note.locator('textarea').fill('Keep the previous behaviour')
  await note.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(note.locator('.review-body')).toHaveText('Keep the previous behaviour')
  await page.route('**/api/changes?**', r => r.fulfill({ json: { ...data, working: { ...data.working, count: 1, files: [second] } } }))
  await page.getByRole('button', { name: 'Refresh changes' }).click()
  await expect(page.locator('.review-note.missing')).toContainText('No longer in the diff')
  await expect(page.locator('.review-note.missing .review-path')).toHaveText('src/first.ts')
  await expect(page.locator('.review-note .review-body')).toHaveText('Keep the previous behaviour')
  await shot(page, info.project.name, 'missing-block')
  await page.getByRole('button', { name: 'Send review', exact: true }).click()
  await expect(field(page)).toHaveValue('Please review these points:\n\nsrc/first.ts:11 (old line 8, no longer in diff) — Keep the previous behaviour\n    -  return 1\n    +  const n = 2')
  await openChanges(page)
  const s = fileOf(page, 'src/second.ts')
  await s.locator('summary').click()
  await comment(page, isMobile, s, '10')
  await page.locator('.review-note textarea').fill('Delete me')
  await page.locator('.review-note').getByRole('button', { name: 'Comment', exact: true }).click()
  await page.getByRole('button', { name: 'Delete comment', exact: true }).click()
  await expect(page.locator('.review-note')).toHaveCount(1)
  await shot(page, info.project.name, 'delete-confirm')
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
  await expect(page.locator('.review-note')).toHaveCount(0)
  await comment(page, isMobile, s, '7 (old line)')
  await page.locator('.review-note textarea').fill('Discard me')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.locator('.review-note')).toHaveCount(0)
  expect(await page.evaluate(pane => localStorage.getItem(`review:${pane}`), OMP_CHAT_PANE)).toBeNull()
})

test('a block whose inner code changed is flagged, and keeps the excerpt that was commented', async ({ page, isMobile }, info) => {
  await setup(page)
  await openChanges(page)
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  await comment(page, isMobile, f, '11', '13')
  await f.locator('.review-note textarea').fill('Return the constant directly')
  await f.locator('.review-note').getByRole('button', { name: 'Comment', exact: true }).click()
  // Same first and last lines, another line between them.
  const lines = first.lines.map(l => l.text === '+  return n' ? { ...l, text: '+  return n + 1' } : l)
  await page.route('**/api/changes?**', r => r.fulfill({ json: { ...data, working: { ...data.working, files: [{ ...first, lines }, second] } } }))
  await page.getByRole('button', { name: 'Refresh changes' }).click()
  const note = page.locator('.review-note.missing')
  await expect(note).toContainText('The code of this block changed')
  await expect(note.locator('.review-body')).toHaveText('Return the constant directly')
  await expect(fileOf(page, 'src/first.ts').locator('.review-note')).toHaveCount(0)
  await shot(page, info.project.name, 'changed-block')
  await page.getByRole('button', { name: 'Send review', exact: true }).click()
  await expect(field(page)).toHaveValue('Please review these points:\n\nsrc/first.ts:11-13 (code changed since this comment) — Return the constant directly\n    +  const n = 2\n    +  return n\n     }')
})

test('code stays selectable: clicks and selections in it never start a comment', async ({ page, isMobile }) => {
  await setup(page)
  await openChanges(page)
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  const source = rowOf(f, '12').locator('.review-source')
  expect(await source.evaluate(el => getComputedStyle(el).userSelect)).not.toBe('none')
  if (isMobile) await source.tap()
  else {
    await source.click()
    await source.dblclick({ position: { x: 40, y: 8 } })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('return')
    // A selection dragged over several lines copies code, without line numbers.
    const from = (await rowOf(f, '11').locator('.review-source').boundingBox())!
    const to = (await rowOf(f, '13').locator('.review-source').boundingBox())!
    await page.mouse.move(from.x + 8, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 4 })
    await page.mouse.up()
    const copied = await page.evaluate(() => window.getSelection()!.toString())
    expect(copied).toContain('return n')
    expect(copied).not.toMatch(/\d\d/)
  }
  await page.waitForTimeout(400)
  await expect(page.locator('.review-note')).toHaveCount(0)
  await expect(page.locator('.review-pick')).toHaveCount(0)
})

test('on a long diff the chosen block and its bar stay in reach while scrolling', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'touch selection')
  const long = { path: 'src/long.ts', status: '??', added: 120, deleted: 0, binary: false, truncated: false, lines: [
    { kind: 'hunk', text: '@@ -0,0 +1,120 @@' }, ...Array.from({ length: 120 }, (_, i) => ({ kind: 'add', text: `+const v${i + 1} = ${i + 1}` })),
  ] }
  await setup(page)
  await page.route('**/api/changes?**', r => r.fulfill({ json: { ...data, working: { count: 1, truncated: false, files: [long] } } }))
  await openChanges(page)
  const f = fileOf(page, 'src/long.ts')
  await f.locator('summary').click()
  await gutter(f, '3').tap()
  const pick = page.locator('.review-pick')
  await expect(pick).toBeInViewport({ ratio: 0.95 })
  await rowOf(f, '60').scrollIntoViewIfNeeded()
  await expect(pick).toBeInViewport({ ratio: 0.95 })
  await rowOf(f, '60').locator('.review-source').tap()
  await expect(pick).toContainText('Lines 3–60')
  await shot(page, info.project.name, 'long-block-chosen')
  await pick.getByRole('button', { name: 'Comment', exact: true }).tap()
  await expect(f.locator('.review-note textarea')).toBeFocused()
  await expect(f.locator('.review-note')).toBeInViewport()
  await shot(page, info.project.name, 'long-block-editor')
})

test('mouse and keyboard: Shift+click extends, a block stops at its hunk, Escape keeps the window', { tag: '@chromium-desktop' }, async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'desktop mouse and keyboard')
  await setup(page)
  await openChanges(page)
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  const note = f.locator('.review-note')
  // Click "+", then Shift+click another line: the open editor takes the block.
  await gutter(f, '11').click()
  await expect(note.locator('.review-range')).toHaveText('Line 11')
  await gutter(f, '13').click({ modifiers: ['Shift'] })
  await expect(note).toHaveCount(1)
  await expect(note.locator('.review-range')).toHaveText('Lines 11–13')
  await expect(note.locator('textarea')).toBeFocused()
  // Escape closes an empty editor, never the window; written text takes a second Escape.
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  await expect(page.locator('.changes-view')).toBeVisible()
  // Dragged past the end of the hunk, the block stops at the hunk's last line.
  await gutter(f, '12').hover()
  await page.mouse.down()
  await gutter(f, '41').hover()
  await expect(f.locator('.review-line.picked')).toHaveCount(2)
  await expect(f.locator('.review-line.out')).toHaveCount(3)
  await shot(page, info.project.name, 'block-hunk-limit')
  await page.mouse.up()
  await expect(note.locator('.review-range')).toHaveText('Lines 12–13')
  await page.keyboard.type('Why two lines?')
  await page.keyboard.press('Escape')
  await expect(note.getByRole('button', { name: 'Discard this text?', exact: true })).toBeVisible()
  await expect(note.locator('textarea')).toHaveValue('Why two lines?')
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  await expect(page.locator('.changes-view')).toBeVisible()
  // Escape from a button of the editor is the editor's too, and gives the focus back to the line.
  await gutter(f, '41').click()
  await page.keyboard.type('Unfinished comment')
  await page.keyboard.press('Tab')
  await expect(note.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.changes-view')).toBeVisible()
  await expect(note.getByRole('button', { name: 'Discard this text?', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  await expect(page.locator('.changes-view')).toBeVisible()
  await expect(gutter(f, '41')).toBeFocused()
  // Keyboard only: arrows between lines, Shift+arrows for the block, Enter, Ctrl+Enter.
  await gutter(f, '10').focus()
  await page.keyboard.press('ArrowDown')
  await expect(gutter(f, '8 (old line)')).toBeFocused()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.changes-view p[role="status"]')).toHaveText('Selection: Lines 11–12 + old line 8')
  await expect(page.locator('.review-pick')).toContainText('Shift+Arrow')
  await shot(page, info.project.name, 'block-keyboard')
  await page.keyboard.press('Enter')
  await expect(note.locator('textarea')).toBeFocused()
  await page.keyboard.type('Keyboard review')
  await page.keyboard.press('Control+Enter')
  await expect(note.locator('.review-body')).toHaveText('Keyboard review')
  await expect(gutter(f, '12')).toBeFocused()
  await page.getByRole('button', { name: 'Send review', exact: true }).click()
  await expect(field(page)).toHaveValue('Please review these points:\n\nsrc/first.ts:11-12 (old line 8) — Keyboard review\n    -  return 1\n    +  const n = 2\n    +  return n')
})

test('a refresh arriving during a drag cancels it: no comment on rows that are gone', { tag: '@chromium-desktop' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag')
  await setup(page)
  await openChanges(page)
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  let asked!: () => void
  const request = new Promise<void>((resolve) => { asked = resolve })
  await page.route('**/api/changes?**', async (r) => {
    asked()
    await held
    await r.fulfill({ json: { ...data, working: { ...data.working, files: [{ ...first, lines: first.lines.slice(0, 2) }, second] } } })
  })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.getByRole('button', { name: 'Refresh changes' }).click()
  await request
  await gutter(f, '41').hover()
  await page.mouse.down()
  await expect(f.locator('.review-line.picked')).toHaveCount(1)
  finish()
  await expect(gutter(f, '41')).toHaveCount(0)
  await expect(f.locator('.review-line.picked')).toHaveCount(0)
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(errors).toEqual([])
  await expect(page.locator('.review-note')).toHaveCount(0)
})

test('English review controls fit the phone with a legacy French preference', async ({ page, isMobile }, info) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await setup(page)
  await openChanges(page, 'View changes')
  const f = fileOf(page, 'src/first.ts')
  await f.locator('summary').click()
  const line = (n: string) => f.getByRole('button', { name: `Comment on line ${n}`, exact: true })
  if (isMobile) {
    await line('8 (old line)').tap()
    await f.locator('.review-line', { has: page.getByRole('button', { name: 'Comment on line 10', exact: true }) }).locator('.review-source').tap()
    const pick = page.locator('.review-pick')
    await expect(pick).toContainText('Line 10 + old line 8')
    const box = (await pick.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await shot(page, info.project.name, 'french-block-chosen')
    await pick.getByRole('button', { name: 'Comment', exact: true }).tap()
  } else {
    await line('10').hover()
    await page.mouse.down()
    await line('8 (old line)').hover()
    await page.mouse.up()
  }
  await page.locator('.review-note textarea').fill('Vérifier la valeur vide')
  const send = page.getByRole('button', { name: 'Send review', exact: true })
  await expect(send).toBeVisible()
  const rect = (await send.boundingBox())!
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await shot(page, info.project.name, 'french')
  await send.click()
  await expect(field(page)).toHaveValue('Please review these points:\n\nsrc/first.ts:10 (old line 8) — Vérifier la valeur vide\n     function total() {\n    -  return 1')
})
