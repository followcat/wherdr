// New → Coordinator on a folder the board does not know yet, against a mocked
// herdr-projects: the sheet says where each folder stands (on the board, new,
// not Git, missing), adds a new one before the conversation opens, and the
// coordinator is then named by the repo's name on the board, never its path.
import { expect, test, type Page } from './test'

const HOME = '/home/user'
const CODE = `${HOME}/code`
const folders: Record<string, Record<string, unknown>> = {
  [`${CODE}/demo`]: { state: 'known', repo: 'demo', root: `${CODE}/demo` },
  [`${CODE}/team-hub`]: { state: 'new', repo: 'team-hub', root: `${CODE}/team-hub` },
  [`${CODE}/notes`]: { state: 'notgit' },
}
const dirs = [
  { name: 'demo', path: `${CODE}/demo`, git: true },
  { name: 'notes', path: `${CODE}/notes`, git: false },
  { name: 'team-hub', path: `${CODE}/team-hub`, git: true },
]

async function fakeBoard(page: Page) {
  const fake = { added: [] as unknown[], told: [] as Record<string, any>[], known: false }
  await page.route('**/api/dirs**', (route) => {
    const p = (new URL(route.request().url()).searchParams.get('path') || '').replace(/^~/, HOME)
    // The browser starts in the test server's own home: shown as the fake one's code folder.
    const here = p.startsWith(`${CODE}/`) ? p : CODE
    return route.fulfill({ json: { path: here, parent: here === CODE ? HOME : CODE, home: HOME, dirs: here === CODE ? dirs : [] } })
  })
  await page.route('**/api/isgit**', route => route.fulfill({ json: { git: true } }))
  await page.route('**/api/tasks**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/api/tasks/links') {
      const repos = [{ repo: 'demo', root: `${CODE}/demo`, branch: 'main', behind: 0 }, ...(fake.known ? [{ repo: 'team-hub', root: `${CODE}/team-hub`, branch: 'main', behind: 0 }] : [])]
      return route.fulfill({ json: { version: `links-${fake.known}`, machines: [{ machine: '', tasks: [], coordinators: [], repos }] } })
    }
    if (url.pathname === '/api/tasks/project') {
      if (req.method() === 'POST') {
        fake.added.push(req.postDataJSON())
        fake.known = true
        return route.fulfill({ json: { repo: 'team-hub', root: `${CODE}/team-hub`, added: true } })
      }
      return route.fulfill({ json: folders[url.searchParams.get('folder') ?? ''] ?? { state: 'missing' } })
    }
    if (url.pathname === '/api/tasks/coordinator') {
      if (req.method() === 'POST') { fake.told.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, msg: 'sent', repo: 'team-hub' } }) }
      return route.fulfill({ json: { pane: null, state: fake.told.length ? 'starting' : 'none', error: '', queued: null } })
    }
    if (url.pathname === '/api/tasks') return route.fulfill({ json: { version: 'empty', machines: [{ machine: '', status: 'ready', version: '1.2.26', tasks: [] }] } })
    return route.fulfill({ json: { machines: [], version: 'empty' } })
  })
  return fake
}

async function pickFolder(page: Page, name: string) {
  const sheet = page.getByRole('dialog')
  await sheet.locator('.dir-pick').click()
  // Its first listing loads as it opens and would replace a path typed before it lands.
  await expect(sheet.locator('.dir-list .term-loading')).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: /Folder path|Chemin du dossier/ })).not.toHaveValue('')
  await sheet.getByRole('textbox', { name: /Folder path|Chemin du dossier/ }).fill(`${CODE}/${name}`)
  await sheet.getByRole('button', { name: /^(Go|Aller)$/ }).click()
  await expect(sheet.getByRole('textbox', { name: /Folder path|Chemin du dossier/ })).toHaveValue(new RegExp(`/${name}$`))
  await sheet.getByRole('button', { name: /Choose this folder|Choisir ce dossier/ }).click()
}

for (const language of ['en', 'fr'] as const) {
  const fr = language === 'fr'
  test(`New coordinator on a folder the board does not know (${language})`, async ({ page }, info) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    const fake = await fakeBoard(page)
    await page.goto('/')
    const desk = (page.viewportSize()?.width ?? 0) >= 1000
    await (desk ? page.getByRole('button', { name: fr ? 'Nouveau' : 'New', exact: true }).first() : page.locator('.fab')).click()
    const sheet = page.getByRole('dialog')
    await sheet.locator('[data-kind="coordinator"]').click()
    await sheet.locator('#coordinator-repo').click()
    await page.getByRole('option', { name: fr ? 'Autre dépôt…' : 'Other repository…' }).click()
    const state = sheet.getByTestId('project-folder-state')
    const open = sheet.locator('.launch-btn')

    // Not Git: said, nothing opens.
    await pickFolder(page, 'notes')
    await expect(state).toHaveAttribute('data-state', 'notgit')
    await expect(state).toContainText(fr ? 'n’est pas un dépôt Git' : 'is not a Git repository')
    await expect(open).toBeDisabled()

    // Already on the board: its name.
    await pickFolder(page, 'demo')
    await expect(state).toHaveAttribute('data-state', 'known')
    await expect(state).toContainText('demo')
    await expect(open).toHaveText(fr ? 'Ouvrir la conversation' : 'Open conversation')

    // New: the name it will get, then added before the conversation opens.
    await pickFolder(page, 'team-hub')
    await expect(state).toHaveAttribute('data-state', 'new')
    await expect(state).toContainText('team-hub')
    await expect(open).toHaveText(fr ? 'Ajouter et ouvrir la conversation' : 'Add and open conversation')
    const shot = (name: string) => page.screenshot({ path: `.shots/new-coordinator-${name}-${language}-${desk ? 'desktop' : 'phone'}-${info.project.name}.png` })
    await shot('sheet')
    await open.click()
    expect(fake.added).toEqual([{ machine: '', folder: `${CODE}/team-hub` }])

    // The conversation is the repo's, by its name: the first message goes there.
    const first = page.locator('#board-panel-first')
    await expect(first).toBeVisible()
    await shot('panel')
    await first.fill(fr ? 'Fais le point sur le projet' : 'Review the project')
    await page.locator('.board-panel-first button[type="submit"]').click()
    await expect.poll(() => fake.told.length).toBe(1)
    expect(fake.told[0]!.to).toEqual({ kind: 'project', repo: 'team-hub' })
  })
}

test('New coordinator sheet on a desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fakeBoard(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'New', exact: true }).first().click()
  const sheet = page.getByRole('dialog')
  await sheet.locator('[data-kind="coordinator"]').click()
  await sheet.locator('#coordinator-repo').click()
  await page.getByRole('option', { name: 'Other repository…' }).click()
  await pickFolder(page, 'team-hub')
  await expect(sheet.getByTestId('project-folder-state')).toHaveAttribute('data-state', 'new')
  await page.screenshot({ path: '.shots/new-coordinator-sheet-en-1440.png' })
})
