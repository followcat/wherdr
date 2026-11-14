import { test, expect, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startCore, type Call } from './core'

// A project's settings on the built server: a project added from an example
// gets its own workflow, a branch protected in the Guards tab is saved, and a
// coordinator's proposal is accepted from the Workflow tab, guards kept. The New
// sheet's form, each tab and the library sheet are covered lower, in
// tests/components (NewProject, ProjectsSettings, ProjectWorkflow, TemplateLibrary).
const b64 = (s: string) => Buffer.from(s).toString('base64')
// The folder checks run as shell scripts on the machine (server/utils/pmFolder.ts).
const exec = (call: Call) => {
  const script = String(call.params?.argv?.[2] ?? '')
  const out = script.includes('$HOME') ? '/workspace' : script.includes('echo dir') ? 'dir\ngit' : script.includes('git -C') ? 'git' : ''
  return { code: 0, stdout: b64(out) }
}
const api = (page: Page, url: string, body?: unknown) => page.evaluate(async ([url, body]) => {
  const r = await fetch(url as string, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  return r.json()
}, [url, body] as const)

// No sheet scrolls sideways (docs/design.md): every open sheet and its body
// is exactly as wide as its content, on the phone and on a computer.
const sizes = [{ width: 390, height: 664 }, { width: 1440, height: 900 }]
const sideScroll = (page: Page) => page.locator('.hw-sheet').evaluateAll(sheets => sheets
  .flatMap(s => [s, ...s.querySelectorAll('[data-slot="body"]')])
  .map(e => e.scrollWidth - e.clientWidth).filter(d => d > 0))

test('project settings: added from an example, a branch protected, a proposal accepted', async ({ page }) => {
  let data = ''
  const core = await startCore(call => (call.method === 'machine.exec' ? exec(call) : undefined), async (dir) => {
    data = dir
    await mkdir(join(dir, 'projects'), { recursive: true })
    await writeFile(join(dir, 'projects', 'pm.json'), JSON.stringify({ v: 1, enabled: true }))
  })
  // A new hash only: reload, so the page reads the projects again.
  const sheet = async (tab: string) => { await page.goto(`${core.url}/#/settings?section=projects&project=WEB&tab=${tab}`); await page.reload() }
  try {
    await core.open(page, '/#/settings?section=projects')
    await expect(page.getByTestId('pm-empty')).toBeVisible()
    // What the New sheet sends for a git folder and the example "vibe". Tried
    // again until the server has read its machines from the core (else
    // "unknown machine"); a refused add changes nothing.
    await expect.poll(() => api(page, '/api/pm/project', { key: 'WEB', name: 'Web', machine: '', path: '/workspace/web', template: 'example:vibe', plain: true }))
      .toMatchObject({ project: { key: 'WEB', from: { template: 'vibe' } } })
    await sheet('general')
    await expect(page.getByTestId('pm-from')).toContainText('Based on: vibe v1')
    await mkdir('.shots', { recursive: true })
    for (const size of sizes) {
      await page.setViewportSize(size)
      await expect.poll(() => sideScroll(page)).toEqual([])
      await page.screenshot({ path: `.shots/project-general-${size.width}.png` })
    }
    await page.setViewportSize(sizes[0]!)

    await page.locator('[data-tab="guards"]').click()
    await page.getByLabel('Branch to protect').fill('release')
    await page.getByTestId('guard-add-button').click()
    await page.getByTestId('guard-save').click()
    await expect(page.getByTestId('guard-chip').filter({ hasText: 'release' })).toBeVisible()
    const { workflow } = await api(page, '/api/pm/project?key=WEB')
    expect(workflow.guards.protected).toEqual(['main', 'release'])
    await page.screenshot({ path: `.shots/project-guards-${test.info().project.name}.png` })

    // The coordinator's `template edit`, as it is stored: the diff against this version.
    const proposal = { template: { ...workflow, instructions: 'Run the tests first.' }, diff: '-  "instructions": "Commit small, clear commits.",\n+  "instructions": "Run the tests first.",', at: Date.now(), base: workflow.version, said: 'Run the tests first' }
    await mkdir(join(data, 'projects', 'coordinators'), { recursive: true })
    await writeFile(join(data, 'projects', 'coordinators', 'WEB.json'), JSON.stringify({ project: 'WEB', tokenHash: '', proposal }))
    await sheet('workflow')
    await page.getByTestId('workflow-proposal').click()
    await expect(page.getByTestId('proposal-review')).toBeVisible()
    for (const size of sizes) {
      await page.setViewportSize(size)
      await expect.poll(() => sideScroll(page)).toEqual([])
    }
    await page.getByTestId('proposal-accept').click()
    await expect(page.getByTestId('workflow-proposal')).toHaveCount(0)
    const after = (await api(page, '/api/pm/project?key=WEB')).workflow
    expect(after).toMatchObject({ instructions: 'Run the tests first.', version: workflow.version + 1, guards: { protected: ['main', 'release'] } })
  } finally {
    await core.stop()
  }
})
