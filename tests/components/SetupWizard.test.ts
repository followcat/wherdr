import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import SetupWizard from '~/components/SetupWizard.vue'
import SetupButton from '~/components/SetupButton.vue'
import type { PmOverview } from '#shared/pm/project'
import type { CoordinatorView } from '#shared/pm/coordinator'
import { appConfig, herdrState } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

// What the fake server answers; each case sets it before mounting.
let overview: PmOverview
let coords: Partial<CoordinatorView>[] = []
registerEndpoint('/api/pm/overview', () => overview)
registerEndpoint('/api/pm/coordinators', () => coords)
// Starting a coordinator: its conversation, then the setup asked of it.
let sent: Record<string, unknown>[] = []
registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => {
  sent.push({ start: await readBody(e) })
  coords = [{ project: 'WEB', terminal: 'host/t1' }]
  herdrState.value = { ok: true, panes: [coordPane('idle')], workspaces: [] }
  return { terminal: 'host/t1' }
} })
registerEndpoint('/api/pm/coordinator-agent', { method: 'POST', handler: async (e) => { sent.push({ agent: await readBody(e) }); return {} } })
for (const url of ['/api/prompt', '/api/input']) registerEndpoint(url, { method: 'POST', handler: async (e) => { sent.push({ message: (await readBody(e)).text }); return {} } })
registerEndpoint('/api/pm/enabled', { method: 'POST', handler: () => { overview = { ...overview, enabled: true }; return overview } })

registerEndpoint('/api/pm/repos', () => ({ home: '/home/u', repos: ['/home/u/web'] }))
registerEndpoint('/api/pm/folder', () => ({ path: '/home/u/web', exists: true, git: true, remote: false, empty: false }))
let added: Record<string, unknown> | null = null
registerEndpoint('/api/pm/project', { method: 'POST', handler: async (e) => {
  added = await readBody(e)
  const p = { ...project(String(added!.key)), visibility: { value: 'public', by: 'check', at: 1 } }
  overview = { ...overview, projects: [...overview.projects, p] }
  return { project: p }
} })

const project = (key: string, template?: string) => ({ key, name: key, machine: '', path: `~/${key}`, addedAt: 1, ...(template ? { from: { template, version: 1 } } : {}) })

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; coords = []; added = null; sent = []; herdrState.value = { ok: false, panes: [], workspaces: [] } })
// The coordinator's live pane, as herdr-core shows it.
const coordPane = (status: Pane['status']) => ({ id: 'w1:p1', coreAddress: 'host/t1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status, title: null, cwd: null, agentSession: null }) as Pane

// The newest match: a sheet of the previous case may still be closing.
const $ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].pop()
const stepShown = () => $('setup-wizard')?.dataset.step
async function wizard(props: { project?: string, adding?: boolean } = {}) {
  mounted = await mountSuspended(SetupWizard, { props: { open: true, ...props } })
  await vi.waitFor(() => expect($('setup-wizard')).toBeTruthy())
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading…'))
}
const click = async (id: string) => { $(id)!.click(); await new Promise(r => setTimeout(r, 0)) }

it('three steps; no Back on the first, and Next waits for the step to be done', async () => {
  overview = { enabled: false, projects: [], templates: [], tasks: [] }
  await wizard()
  await vi.waitFor(() => expect(stepShown()).toBe('enable'))
  expect($('setup-count')!.textContent).toContain('Step 1 of 3')
  expect($('setup-back')).toBeFalsy()
  expect($('setup-alfred')!.classList.contains('hw-cta')).toBe(false) // Turn on is the main button
  expect($('setup-next')!.hasAttribute('disabled')).toBe(true)
  await vi.waitFor(() => expect($('setup-enable')!.classList.contains('hw-cta')).toBe(true))
  await click('setup-enable')
  await vi.waitFor(() => expect($('setup-next')!.hasAttribute('disabled')).toBe(false))
  await click('setup-next')
  await vi.waitFor(() => expect(stepShown()).toBe('project'))
  expect($('setup-next')!.hasAttribute('disabled')).toBe(true) // no project yet
  expect($('setup-back')).toBeTruthy()
})

it('a project without a workflow: its agent and model picked in step 2, then step 3 starts its coordinator and opens its conversation', async () => {
  appConfig.value = { ...appConfig.value, kinds: ['claude', 'codex'] }
  overview = { enabled: true, projects: [project('WEB')], templates: [], tasks: [] }
  await wizard()
  await vi.waitFor(() => expect(stepShown()).toBe('coordinator')) // no workflow or guards step
  expect($('setup-count')!.textContent).toContain('Step 3 of 3')
  expect($('setup-next')!.hasAttribute('disabled')).toBe(true)
  await click('setup-back')
  await vi.waitFor(() => expect(stepShown()).toBe('project'))
  document.querySelector<HTMLElement>('[data-agent="codex"]')!.click()
  const model = $('setup-model')!.querySelector('input') ?? $('setup-model') as HTMLInputElement
  model.value = 'gpt-5-codex'
  model.dispatchEvent(new Event('input'))
  await click('setup-next')
  await vi.waitFor(() => expect($('setup-meet')!.textContent).toContain('Start with Codex'))
  await click('setup-meet')
  // The agent page lazy-loads (see CoordinatorPanel.test.ts): allow for it.
  await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/a/w1:p1'), { timeout: 15000 })
  // Kept as its default, then started with it.
  expect(sent).toEqual([{ agent: { project: 'WEB', program: 'codex', model: 'gpt-5-codex' } }, { start: { project: 'WEB', program: 'codex', model: 'gpt-5-codex' } }])
})

it('a project without a workflow is set up once its coordinator runs; the board button is then gone', async () => {
  overview = { enabled: true, projects: [project('API'), project('WEB')], templates: [], tasks: [] }
  coords = [{ project: 'WEB', terminal: 'host/t1' }]
  // Its pane asking something: step 3, with its answer button; running: done.
  herdrState.value = { ok: true, panes: [coordPane('blocked')], workspaces: [] }
  await wizard({ project: 'WEB' })
  await vi.waitFor(() => expect($('setup-meet')!.textContent).toContain('Answer its question'))
  expect(stepShown()).toBe('coordinator')
  expect($('setup-next')!.hasAttribute('disabled')).toBe(true)
  mounted!.unmount()
  herdrState.value = { ok: true, panes: [coordPane('idle')], workspaces: [] }
  await wizard({ project: 'WEB' })
  await vi.waitFor(() => expect(stepShown()).toBe('done'))
  expect($('setup-complete')).toBeTruthy()
  mounted!.unmount()
  const w = await mountSuspended(SetupButton)
  mounted = w
  await new Promise(r => setTimeout(r, 50))
  expect(w.find('[data-testid="setup-button"]').exists()).toBe(false)
})

it('adding: opens at step 2 on a new project, with no Back, added in place with its color, then shows its visibility', async () => {
  overview = { enabled: true, projects: [project('WEB', 'vibe')], templates: [], tasks: [] }
  await wizard({ adding: true })
  await vi.waitFor(() => expect($('setup-project-form')).toBeTruthy())
  expect(stepShown()).toBe('project')
  expect($('setup-back')).toBeFalsy()
  await vi.waitFor(() => expect($('setup-repos')).toBeTruthy())
  $('setup-repos')!.querySelector('button')!.click()
  await vi.waitFor(() => expect($('setup-add-project')!.hasAttribute('disabled')).toBe(false))
  await click('setup-add-project')
  await vi.waitFor(() => expect($('setup-visibility')).toBeTruthy())
  expect(added).toMatchObject({ key: 'WEB2', name: 'web', path: '/home/u/web', color: expect.any(String) })
  expect($('setup-next')!.hasAttribute('disabled')).toBe(false)
  expect($('setup-public-note')).toBeTruthy() // checked: public
})

it('says nothing about a public repository while it is not checked; the board button counts the steps done', async () => {
  overview = { enabled: true, projects: [project('WEB')], templates: [], tasks: [] }
  await wizard({ project: 'WEB' })
  await vi.waitFor(() => expect(stepShown()).toBe('coordinator'))
  await click('setup-back')
  await vi.waitFor(() => expect($('setup-visibility')).toBeTruthy())
  expect($('setup-public-note')).toBeFalsy()
  mounted!.unmount()
  const w = await mountSuspended(SetupButton)
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="setup-button"]').text()).toContain('Finish setup (2/3)'))
})
