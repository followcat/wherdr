import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import NewAgentSheet from '~/components/NewAgentSheet.vue'
import { newAgentOpen } from '~/composables/useUi'
import { herdrState } from '~/composables/useHerdr'
import { coordinators, resumedCoordinators } from '~/composables/useCoordinators'
import type { CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const opus = { program: 'claude' as const }
let views: CoordinatorView[] = []
const posts: { url: string, body: Record<string, unknown> }[] = []
registerEndpoint('/api/config', () => ({ kinds: ['claude', 'codex'], home: '/repos', dirs: ['/repos'], push: { enabled: false, key: null, devices: 0 } }))
registerEndpoint('/api/pm/coordinators', () => views)
registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => {
  posts.push({ url: '/api/pm/coordinator-start', body: await readBody(e) })
  herdrState.value = { ...herdrState.value, panes: [...herdrState.value.panes, { id: 'w2:p1', coreAddress: 'host/t9', status: 'idle', agent: 'claude', workspace: 'w2', tab: 't' } as Pane] }
  return { terminal: 'host/t9' }
} })

const folders: Record<string, { exists: boolean, git: boolean, empty: boolean }> = {
  '/repos/web': { exists: true, git: true, empty: false },
  '/repos/new-app': { exists: false, git: false, empty: false },
  '/repos/clients': { exists: true, git: false, empty: false },
}
registerEndpoint('/api/pm/overview', () => ({ enabled: true, projects: [], templates: [] }))
registerEndpoint('/api/pm/repos', () => ({ home: '/repos', repos: ['/repos/api', '/repos/web'] }))
registerEndpoint('/api/pm/folder', (e) => {
  const at = String(new URL(e.node.req.url!, 'http://x').searchParams.get('path')).replace(/^~/, '/repos')
  return { path: at, ...folders[at]! }
})
for (const url of ['/api/pm/template', '/api/pm/project']) {
  registerEndpoint(url, { method: 'POST', handler: async (e) => {
    const body = await readBody(e)
    posts.push({ url, body })
    if (url === '/api/pm/project') views = [...views, { project: body.key, name: body.name, template: body.template }]
    return url === '/api/pm/project' ? { project: { key: body.key } } : { template: { id: 'vibe' } }
  } })
}

const stubs = { AppSheet: { template: '<section><slot /><slot name="footer" /></section>' } }
const running = { id: 'w1:p1', coreAddress: 'host/t1', status: 'idle', agent: 'codex', workspace: 'w1', tab: 't' } as Pane
async function openSheet(v: CoordinatorView[], panes: Pane[] = []) {
  views = v
  herdrState.value = { ok: true, workspaces: [], panes }
  const w = await mountSuspended(NewAgentSheet, { global: { stubs } })
  newAgentOpen.value = true
  await vi.waitFor(() => expect(w.find('[data-kind="project"]').exists()).toBe(true))
  await w.get('[data-kind="project"]').trigger('click')
  await flushPromises()
  return w
}
afterEach(() => {
  newAgentOpen.value = false; posts.length = 0; navigate.mockClear(); coordinators.value = []; views = []
  herdrState.value = { ok: false, workspaces: [], panes: [] }
})

it('lists the projects, then starts the chosen one\'s coordinator with the chosen agent and opens it', async () => {
  const w = await openSheet([
    { project: 'CO', name: 'Company', agent: opus, template: 'company' },
    { project: 'WEB', name: 'Website', agent: { program: 'codex' }, template: 'company' },
  ])
  expect(w.findAll('[data-project]').map(b => b.text())).toEqual(['COCompany', 'WEBWebsite'])
  // The folder and first message belong to agents, not to a coordinator.
  expect(w.find('#newPrompt').exists()).toBe(false)
  expect(w.get('[data-testid="coordinator-start"]').text()).toBe('Start with Claude')
  // Another project: its own default agent.
  await w.get('[data-project="WEB"]').trigger('click')
  expect(w.get('[data-testid="coordinator-start"]').text()).toBe('Start with Codex')
  // Programs only, from Settings › Agents.
  await w.get('[data-project="CO"]').trigger('click')
  expect(w.findAll('[data-agent]').map(b => b.text())).toEqual(['Claude', 'Codex'])
  await w.get('[data-agent="codex"]').trigger('click')
  expect(w.text()).toContain('The default stays Claude.')
  await w.get('[data-testid="coordinator-start"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w2%3Ap1'))
  expect(posts).toEqual([{ url: '/api/pm/coordinator-start', body: { project: 'CO', program: 'codex' } }])
  expect(newAgentOpen.value).toBe(false)
  w.unmount()
})

it('opens a running coordinator instead of starting a second one', async () => {
  const w = await openSheet([{ project: 'CO', name: 'Company', agent: opus, ran: opus, terminal: 'host/t1', template: 'company' }], [running])
  expect(w.get('[data-project="CO"]').text()).toContain('Running')
  await w.get('[data-testid="coordinator-open"]').trigger('click')
  expect(navigate).toHaveBeenCalledWith('/a/w1%3Ap1')
  expect(posts).toEqual([])
  w.unmount()
})

it('running with another agent: a new conversation, or resume it', async () => {
  const w = await openSheet([{ project: 'CO', name: 'Company', agent: opus, ran: { program: 'codex' }, terminal: 'host/t1', template: 'company' }], [running])
  expect(w.find('[data-testid="coordinator-open"]').exists()).toBe(false)
  expect(w.get('[data-testid="coordinator-other-agent"]').text()).toBe('Its conversation runs with Codex.')
  expect(w.get('[data-testid="coordinator-new"]').text()).toBe('New conversation with Claude')
  await w.get('[data-testid="coordinator-resume"]').trigger('click')
  expect(navigate).toHaveBeenCalledWith('/a/w1%3Ap1')
  expect(resumedCoordinators.value).toContain('host/t1')
  expect(posts).toEqual([])
  resumedCoordinators.value = []
  localStorage.removeItem('wherdr.coordinatorsResumed')
  w.unmount()
})

it('a project without a template says it needs one and links to Settings › Projects', async () => {
  const w = await openSheet([{ project: 'CO', name: 'Company', agent: opus }])
  expect(w.get('[data-testid="coordinator-no-template"]').text()).toContain('This project needs a template')
  expect(w.get('[data-testid="coordinator-settings"]').attributes('href')).toContain('/settings?section=projects')
  expect(w.get('[data-testid="coordinator-start"]').attributes('disabled')).toBeDefined()
  w.unmount()
})

it('lists the projects only (Alfred has its own row); with none, goes straight to adding one', async () => {
  const w = await openSheet([{ project: '_main', name: 'Alfred', main: true, agent: opus }])
  expect(w.find('[data-project="_main"]').exists()).toBe(false)
  expect(w.text()).not.toContain('All projects')
  await vi.waitFor(() => expect(w.get('[data-testid="project-add"]').attributes('aria-checked')).toBe('true'))
  w.unmount()
})

it('adds a project from a git repository, a new folder or a folder without git, then starts its coordinator', async () => {
  const w = await openSheet([{ project: '_main', name: 'Main coordinator', main: true, agent: opus }])
  await w.get('[data-testid="project-add"]').trigger('click')
  const folder = async (kind: string) => {
    await vi.waitFor(() => expect(w.find('[data-testid="project-folder"]').attributes('data-folder')).toBe(kind), { timeout: 2000 })
    return w.find('[data-testid="project-git-init"]').exists()
  }
  // A repository found on the machine: one tap, name and key from its folder, no git option.
  await vi.waitFor(() => expect(w.findAll('[data-repo]').map(b => b.text())).toEqual(['api~/api', 'web~/web']))
  await w.get('[data-repo="/repos/web"]').trigger('click')
  expect(await folder('git')).toBe(false)
  expect((w.get('#projectName').element as HTMLInputElement).value).toBe('web')
  expect((w.get('#projectKey').element as HTMLInputElement).value).toBe('WEB')
  // A folder without git: taken as it is, no git option either.
  await w.get('#projectPath').setValue('~/clients')
  expect(await folder('plain')).toBe(false)
  expect((w.get('#projectKey').element as HTMLInputElement).value).toBe('CLN')
  expect(w.find('[data-testid="project-template"]').exists()).toBe(false) // no git: no template, no tasks
  // A new folder: created at start, git init offered (off).
  await w.get('#projectName').setValue('Shop')
  await w.get('#projectPath').setValue('~/new-app')
  expect(await folder('new')).toBe(true)
  expect((w.get('#projectName').element as HTMLInputElement).value).toBe('Shop') // the user's name stays
  expect(w.find('[data-testid="project-template"]').exists()).toBe(false)
  await w.get('[data-testid="project-git-init"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="project-template"]').exists()).toBe(true))
  expect(w.get('[data-testid="project-template"]').text()).toContain('vibe (example)')
  expect(w.text()).toContain('Settings › Projects › Templates')
  await w.get('[data-testid="project-start"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w2%3Ap1'))
  // The example is copied into the project's workflow, not saved into the library.
  expect(posts.map(p => p.url)).toEqual(['/api/pm/project', '/api/pm/coordinator-start'])
  expect(posts[0]!.body).toEqual({ key: 'NA', name: 'Shop', machine: '', path: '/repos/new-app', template: 'example:vibe', plain: true, create: true, gitInit: true })
  expect(posts[1]!.body).toEqual({ project: 'NA', program: 'claude' })
  w.unmount()
})

it('offers no project without project management', async () => {
  views = []
  const w = await mountSuspended(NewAgentSheet, { global: { stubs } })
  newAgentOpen.value = true
  await flushPromises()
  expect(w.find('[data-kind="claude"]').exists()).toBe(true)
  expect(w.find('[data-kind="project"]').exists()).toBe(false)
  w.unmount()
})
