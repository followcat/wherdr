// The Board's Autopilot switches, against a mocked herdr-projects: the state
// shown is always what the server read back, the goal is required, the board's
// refusal is shown, and each coordinator is targeted as it should be.
import { expect, test, type Page } from './test'

interface Status { on: boolean, goal: string, next: string, state: string, couldNot: string }
const OFF: Status = { on: false, goal: '', next: '', state: '', couldNot: '' }
const row = { id: 'demo/1', repo: 'demo', repoKey: 'DEMO', n: 1, state: 'idle', kind: '', stage: 'todo', title: 'Grow the garden', msg: '', progress: null, archived: false, group: 'todo' }

// A fake board: each coordinator's state by autopilot id, its saved goals, and
// what the next action answers (a refusal, or an old version).
async function fakeBoard(page: Page) {
  const fake = {
    on: {} as Record<string, Status>,
    saved: { 'main': 'Keep the garden healthy' } as Record<string, string>,
    refuse: '',
    tooOld: false,
    actions: [] as Record<string, any>[],
  }
  const idOf = (to: { kind: string, repo?: string }) => to.kind === 'project' ? `project:${to.repo}` : to.kind
  const details = (id: string) => ({ ...(fake.on[id] ?? { ...OFF, goal: fake.saved[id] ?? '' }), defaults: { every: '6h', tasksPerDay: '5', tasksAtOnce: '2' } })
  await page.route('**/api/tasks**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'autopilot', machines: [{ machine: '', status: 'ready', version: '1.2.21', tasks: [row] }] } })
    if (url.pathname === '/api/tasks/coordinator') return route.fulfill({ json: { pane: null, state: 'none', error: '', queued: null } })
    if (url.pathname !== '/api/tasks/autopilot') return route.fulfill({ json: { machines: [], version: 'empty' } })
    if (fake.tooOld) return route.fulfill({ status: 400, json: { code: 'projects_too_old', error: 'Autopilot needs herdr-projects 1.2.15 or later on this machine (it has 1.2.14).' } })
    if (route.request().method() === 'POST') {
      const b = route.request().postDataJSON()
      fake.actions.push(b)
      if (fake.refuse) return route.fulfill({ status: 400, json: { code: 'projects_failed', error: fake.refuse } })
      const id = idOf(b.to)
      if (b.action === 'on') { fake.saved[id] = b.goal; fake.on[id] = { on: true, goal: b.goal, next: 'next in 2h', state: 'on', couldNot: '' } }
      else delete fake.on[id]
      return route.fulfill({ json: details(id) })
    }
    const kind = url.searchParams.get('kind')
    if (kind) return route.fulfill({ json: details(idOf({ kind, repo: url.searchParams.get('repo') ?? '' })) })
    return route.fulfill({ json: Object.fromEntries(['main', 'machine', 'project:demo'].map(id => [id, fake.on[id] ?? OFF])) })
  })
  return fake
}

test.describe('English interface', () => {
  const language = 'en'
  test(`Autopilot: saved goal, refusal, turn on, stop (${language})`, async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const fake = await fakeBoard(page)
    await page.goto('/#/board')
    const main = page.locator('.board-autopilots .autopilot-switch')
    await expect(main).toHaveAttribute('aria-checked', 'false')
    await expect(main).toContainText('Off')

    await main.click()
    const dialog = page.getByRole('dialog')
    const goal = dialog.getByRole('textbox', { name: 'Goal', exact: true })
    // Filled with the goal it saved.
    await expect(goal).toHaveValue('Keep the garden healthy')
    const turnOn = dialog.getByRole('button', { name: 'Turn on Autopilot', exact: true })
    // No goal: nothing is sent.
    await goal.fill('  ')
    await expect(turnOn).toBeDisabled()
    expect(fake.actions).toEqual([])

    await goal.fill('Grow a lunar garden')
    await dialog.getByRole('textbox', { name: 'Every (optional)', exact: true }).fill('2h')
    // The board's refusal is shown as it said it, and nothing is assumed.
    fake.refuse = 'Tell a coordinator its goal first.'
    await turnOn.click()
    await expect(dialog.getByRole('alert')).toHaveText('Tell a coordinator its goal first.')
    await expect(main).toHaveAttribute('aria-checked', 'false')

    fake.refuse = ''
    await turnOn.click()
    await expect(dialog).toBeHidden()
    await expect(main).toHaveAttribute('aria-checked', 'true')
    await expect(main).toContainText('Next wake in 2h')
    expect(fake.actions.at(-1)).toMatchObject({ action: 'on', goal: 'Grow a lunar garden', every: '2h', tasksPerDay: '', to: { kind: 'main' } })

    // Stopping asks first.
    await main.click()
    await expect(dialog.getByText('Grow a lunar garden')).toBeVisible()
    await dialog.getByRole('button', { name: 'Stop Autopilot', exact: true }).click()
    await expect(main).toHaveAttribute('aria-checked', 'false')
    expect(fake.actions.at(-1)).toMatchObject({ action: 'off', to: { kind: 'main' } })
  })
})

test('Autopilot: machine and project targeting, panel state, old version', async ({ page }) => {
  const fake = await fakeBoard(page)
  await page.goto('/#/board')
  const dialog = page.getByRole('dialog')
  const turnOn = dialog.getByRole('button', { name: 'Turn on Autopilot', exact: true })

  const machine = page.getByRole('switch', { name: 'Autopilot · Machine coordinator', exact: true })
  await machine.click()
  // No goal saved for it: required.
  await expect(dialog.getByRole('textbox', { name: 'Goal', exact: true })).toHaveValue('')
  await expect(turnOn).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'Goal', exact: true }).fill('Tidy this machine')
  await turnOn.click()
  await expect(machine).toHaveAttribute('aria-checked', 'true')
  expect(fake.actions.at(-1)).toMatchObject({ machine: '', to: { kind: 'machine' }, action: 'on' })

  const project = page.locator('.board-repo').getByRole('switch', { name: 'Autopilot · demo coordinator', exact: true })
  await expect(project).toHaveAttribute('aria-checked', 'false')
  await project.click()
  await dialog.getByRole('textbox', { name: 'Goal', exact: true }).fill('Ship demo 2')
  await dialog.getByRole('textbox', { name: 'Tasks / day (optional)', exact: true }).fill('3')
  await turnOn.click()
  await expect(project).toHaveAttribute('aria-checked', 'true')
  expect(fake.actions.at(-1)).toMatchObject({ to: { kind: 'project', repo: 'demo' }, action: 'on', tasksPerDay: '3' })

  // The coordinator's panel shows the same state, and can stop it.
  await page.locator('.board-repo').getByRole('button', { name: 'demo coordinator', exact: true }).click()
  const panel = page.locator('.board-panel-autopilot').getByRole('switch')
  await expect(panel).toHaveAttribute('aria-checked', 'true')
  await expect(panel).toContainText('Next wake in 2h')
  await panel.click()
  await dialog.getByRole('button', { name: 'Stop Autopilot', exact: true }).click()
  await expect(panel).toHaveAttribute('aria-checked', 'false')
  await expect(project).toHaveAttribute('aria-checked', 'false')
  expect(fake.actions.at(-1)).toMatchObject({ to: { kind: 'project', repo: 'demo' }, action: 'off' })

  // An older herdr-projects: its reason, and no button to turn it on.
  fake.tooOld = true
  await panel.click()
  await expect(dialog.getByRole('alert')).toContainText('1.2.15 or later')
  await expect(turnOn).toHaveCount(0)
})
