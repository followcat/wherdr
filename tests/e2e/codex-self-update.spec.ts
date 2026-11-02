// The Codex self-update journey in a browser: the card, its buttons, the held
// message and the restart. The edge cases are unit tests in
// tests/agentSelfUpdate.test.ts: the fresh-start arguments (conversation choice),
// another foreground program, continuation drafts, a replaced process, a failed
// final transcript read and a guessed session.
import { expect, test, type Page } from './test'
import fs from 'node:fs'
import path from 'node:path'
import { CODEX_UPDATE_PANE, CODEX_UPDATE_SESSION, SOCK_FILE, fakeHerdr } from './scenario.mjs'

const card = (page: Page) => page.locator('.choices')
const record = () => {
  try {
    const records = JSON.parse(fs.readFileSync(path.join(path.dirname(SOCK_FILE), 'data/last-agents.json'), 'utf8'))
    return records.find(([id]: [string]) => id === CODEX_UPDATE_PANE)?.[1]
  } catch { return null }
}
const stats = () => fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })
const post = (page: Page, endpoint: string, data: object) => page.request.post(`/api/${endpoint}`, {
  headers: { Origin: new URL(page.url()).origin }, data: { pane_id: CODEX_UPDATE_PANE, ...data },
})
// Commit resets at the next poll snapshot: an in-flight observation must
// finish reading the old invocation before the fake exposes the new PID.
async function stopAfterUpdate(page: Page, existing = false, question = 'Codex updated itself and stopped') {
  const { pid } = await fakeHerdr('e2e.update_reset', { onSnapshot: true, pane_id: CODEX_UPDATE_PANE, ...(existing ? { session: CODEX_UPDATE_SESSION } : {}) })
  await page.goto(`/#/a/${CODEX_UPDATE_PANE}`)
  // Wait for wherdr to capture this invocation's argv and conversation.
  await expect.poll(record, { timeout: 15000 }).toMatchObject({ pid, conversation: existing ? 'existing' : 'empty', ...(existing ? { session: CODEX_UPDATE_SESSION } : {}) })
  if (existing) await expect(page.locator('.chat').getByText('The build passes.')).toBeVisible()
  await fakeHerdr('e2e.update_exit', { pane_id: CODEX_UPDATE_PANE })
  await expect(card(page).getByText(question)).toBeVisible()
}

test('a new Codex restarts with its original options, only after a tap', async ({ page }, info) => {
  await stopAfterUpdate(page)
  const button = card(page).getByRole('button', { name: 'Restart Codex', exact: false })
  await expect(button).toBeVisible()
  await expect(page.locator('.prompt textarea')).toBeDisabled()
  expect((await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })).starts).toEqual([])
  if (info.project.name.startsWith('chromium')) {
    await page.screenshot({ path: `.shots/codex-update-${info.project.name}.png`, fullPage: true })
  }
  expect((await (await post(page, 'prompt', { text: 'Held until startup returns' })).json()).queued.state).toBe('held')
  expect((await stats()).prompts).toEqual([])
  await button.click()
  await expect.poll(async () => (await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })).starts.length).toBe(1)
  const { starts } = await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })
  expect(starts[0]).toMatchObject({ kind: 'codex', pane_id: CODEX_UPDATE_PANE, args: ['--profile', 'work', '-m', 'gpt-x'] })
  await expect(card(page)).toHaveCount(0)
  await expect.poll(async () => (await stats()).prompts.map((p: { text: string }) => p.text)).toEqual(['Held until startup returns'])
})

const leaving = async (page: Page) => {
  const state = await (await page.request.get('/api/state')).json()
  return Boolean(state.panes.find((p: { id: string }) => p.id === CODEX_UPDATE_PANE)?.leaving)
}

test('a Project message sent before the card appears is held, never typed into the shell', async ({ page }) => {
  const { pid } = await fakeHerdr('e2e.update_reset', { onSnapshot: true, pane_id: CODEX_UPDATE_PANE })
  await page.goto(`/#/a/${CODEX_UPDATE_PANE}`)
  await expect.poll(record, { timeout: 15000 }).toMatchObject({ pid, conversation: 'empty' })
  await fakeHerdr('e2e.update_exit', { pane_id: CODEX_UPDATE_PANE })
  // Codex is gone and its screen is not checked yet: a bare shell, no card.
  await expect.poll(() => leaving(page), { intervals: [50] }).toBe(true)
  await expect(card(page)).toHaveCount(0)
  // What the Project panel sends to a pane with no agent: text, then Enter.
  const raw = await post(page, 'input', { text: 'Confirm: Check the restart', keys: ['enter'] })
  expect((await raw.json()).queued.state).toBe('held')
  expect((await post(page, 'input', { keys: ['enter'] })).status()).toBe(400)
  expect(await stats()).toMatchObject({ starts: [], writes: [], prompts: [] })
  const button = card(page).getByRole('button', { name: 'Restart Codex', exact: false })
  await expect(button).toBeVisible()
  expect(await leaving(page)).toBe(false)
  expect(await stats()).toMatchObject({ writes: [], prompts: [] })
  await button.click()
  await expect.poll(async () => (await stats()).prompts.map((p: { text: string }) => p.text)).toEqual(['Confirm: Check the restart'])
  expect((await stats()).writes).toEqual([])
})

// What the message field of the pane holds: its draft (kept by the device),
// and the field itself where the app shows one (a shell on a computer is its
// terminal alone).
const draftText = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').text || '', `draft:${CODEX_UPDATE_PANE}`)
const paneState = async (page: Page) => (await (await page.request.get('/api/state')).json()).panes.find((p: { id: string }) => p.id === CODEX_UPDATE_PANE)
async function expectInField(page: Page, project: string, text: string) {
  await expect.poll(() => draftText(page)).toBe(text)
  if (project.endsWith('-phone')) await expect(page.locator('.prompt textarea')).toHaveValue(text)
}

test('Dismiss forgets the update and gives the pane back as a plain shell', async ({ page }, info) => {
  const pane = () => paneState(page)
  // Something already typed in the field of this pane (once: not after the reload below).
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('typed')) return
    sessionStorage.setItem('typed', '1')
    localStorage.setItem(key, JSON.stringify({ text: 'already typed' }))
  }, `draft:${CODEX_UPDATE_PANE}`)
  await stopAfterUpdate(page)
  for (const text of ['Held for the restart', 'And a second one']) {
    expect((await (await post(page, 'prompt', { text })).json()).queued.state).toBe('held')
  }
  await card(page).getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(record).toBeUndefined()
  // The user finds what they wrote back in the message field, after what
  // was there; nothing stays in a queue no screen shows.
  await expect(page.locator('.hw-toast-title', { hasText: '2 unsent messages put back into the message field' })).toBeVisible()
  await expectInField(page, info.project.name, 'already typed\nHeld for the restart\nAnd a second one')
  // (Records of earlier tests, typed into the fake Codex, may still be listed.)
  const mine = async () => ((await pane()).queued || []).filter((q: { text: string, back?: boolean }) => q.back || /^(Held for the restart|And a second one)$/.test(q.text))
  await expect.poll(mine).toEqual([])
  // No agent, no question, no disabled field: a shell like any other.
  expect(await pane()).toMatchObject({ agent: null })
  expect((await pane()).stopped).toBeUndefined()
  expect((await pane()).prompt).toBeUndefined()
  expect(await stats()).toMatchObject({ starts: [], writes: [], prompts: [] })
  if (info.project.name.startsWith('chromium')) await page.screenshot({ path: `.shots/codex-update-dismissed-${info.project.name}.png`, fullPage: true })
  // The card does not come back on later polls, nor after a reload; the text stays, once.
  await page.reload()
  await page.waitForTimeout(2500)
  await expect(card(page)).toHaveCount(0)
  await expectInField(page, info.project.name, 'already typed\nHeld for the restart\nAnd a second one')
  expect(await mine()).toEqual([])
  expect(await stats()).toMatchObject({ starts: [], writes: [], prompts: [] })
})

test('a Codex that simply left gives the message held meanwhile back into the field', async ({ page }, info) => {
  const { pid } = await fakeHerdr('e2e.update_reset', { onSnapshot: true, pane_id: CODEX_UPDATE_PANE })
  await page.goto(`/#/a/${CODEX_UPDATE_PANE}`)
  await expect.poll(record, { timeout: 15000 }).toMatchObject({ pid, conversation: 'empty' })
  // /exit, no update: a bare shell whose screen is not checked yet.
  await fakeHerdr('e2e.update_exit', { pane_id: CODEX_UPDATE_PANE, plain: true })
  await expect.poll(() => leaving(page), { intervals: [50] }).toBe(true)
  const raw = await post(page, 'input', { text: 'Written while Codex was leaving', keys: ['enter'] })
  expect((await raw.json()).queued.state).toBe('held')
  // The check ends without a card: no agent will take the message.
  await expect.poll(() => leaving(page)).toBe(false)
  await expect(card(page)).toHaveCount(0)
  await expect(page.locator('.hw-toast-title', { hasText: 'Unsent message put back into the message field' })).toBeVisible()
  await expectInField(page, info.project.name, 'Written while Codex was leaving')
  await expect.poll(async () => ((await paneState(page)).queued || []).filter((q: { text: string, back?: boolean }) => q.back || q.text === 'Written while Codex was leaving')).toEqual([])
  expect(await paneState(page)).toMatchObject({ agent: null })
  // Never typed into the shell.
  expect(await stats()).toMatchObject({ starts: [], writes: [], prompts: [] })
  if (info.project.name.startsWith('chromium')) await page.screenshot({ path: `.shots/codex-left-${info.project.name}.png`, fullPage: true })
})

test('an existing Codex resumes its exact session', { tag: '@chromium-desktop' }, async ({ page }) => {
  await stopAfterUpdate(page, true)
  await expect(card(page).getByRole('button', { name: /Start fresh/ })).toBeVisible()
  expect((await (await post(page, 'prompt', { text: 'Held until exact resume' })).json()).queued.state).toBe('held')
  await card(page).getByRole('button', { name: /Resume conversation/ }).click()
  await expect.poll(async () => (await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })).starts.length).toBe(1)
  const { starts } = await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })
  expect(starts[0].args).toEqual(['resume', '--profile', 'work', '-m', 'gpt-x', CODEX_UPDATE_SESSION])
  await expect.poll(async () => (await stats()).prompts.map((p: { text: string }) => p.text)).toEqual(['Held until exact resume'])
})

test('a shell draft refuses restart and keyboard navigation sends nothing', async ({ page }) => {
  await stopAfterUpdate(page)
  await fakeHerdr('e2e.update_draft', { pane_id: CODEX_UPDATE_PANE, text: 'echo hello' })
  const response = page.waitForResponse(r => r.url().endsWith('/api/choose'))
  await card(page).getByRole('button', { name: /Restart Codex/ }).click()
  expect((await response).status()).toBe(400)
  expect((await fakeHerdr('e2e.update_starts', { pane_id: CODEX_UPDATE_PANE })).starts).toEqual([])
  const nav = await page.request.post('/api/nav', { headers: { Origin: new URL(page.url()).origin }, data: { pane_id: CODEX_UPDATE_PANE, key: 'enter' } })
  expect(nav.status()).toBe(400)
})
