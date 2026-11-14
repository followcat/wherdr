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

const folders: Record<string, { exists: boolean, git: boolean, remote?: boolean, empty: boolean }> = {
  '/repos/web': { exists: true, git: true, remote: true, empty: false },
  '/repos/new-app': { exists: false, git: false, empty: false },
  '/repos/clients': { exists: true, git: false, empty: false },
}
registerEndpoint('/api/pm/repos', () => ({ home: '/repos', repos: ['/repos/api', '/repos/web'] }))
registerEndpoint('/api/pm/folder', (e) => {
  const at = String(new URL(e.node.req.url!, 'http://x').searchParams.get('path')).replace(/^~/, '/repos')
  return { path: at, ...folders[at]! }
})
registerEndpoint('/api/pm/project', { method: 'POST', handler: async (e) => {
  const body = await readBody(e)
  posts.push({ url: '/api/pm/project', body })
  views = [...views, { project: body.key, name: body.name }]
  return { project: { key: body.key } }
} })

const stubs = {
  AppSheet: { template: '<section><slot /><slot name="footer" /></section>' },
  // The folder browser: chooses a folder of the machine at once.
  DirBrowser: { emits: ['choose'], template: '<button data-testid="browse-choose" @click="$emit(\'choose\', \'/repos/clients\')" />' },
}
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

it('opens on adding a project; below, only the projects whose coordinator does not run, started with the chosen agent', async () => {
  const w = await openSheet([
    { project: '_main', name: 'Alfred', main: true, agent: opus },
    { project: 'CO', name: 'Company', agent: opus, ran: opus, terminal: 'host/t1' },
    { project: 'WEB', name: 'Website', agent: { program: 'codex' } },
    { project: 'DOC', name: 'Docs', agent: opus },
  ], [running])
  // The machine's repositories first, no template, no project picked.
  await vi.waitFor(() => expect(w.findAll('[data-repo]')).toHaveLength(2))
  expect(w.find('[data-testid="project-template"]').exists()).toBe(false)
  expect(w.find('#newPrompt').exists()).toBe(false)
  // CO runs (the sidebar has it), Alfred has its own row.
  expect(w.get('[data-testid="project-existing"]').findAll('[data-project]').map(b => b.text())).toEqual(['WEBWebsite', 'DOCDocs'])
  await w.get('[data-project="WEB"]').trigger('click')
  expect(w.get('[data-testid="coordinator-start"]').text()).toBe('Start with Codex')
  await w.get('[data-agent="claude"]').trigger('click')
  expect(w.text()).toContain('The default stays Codex.')
  await w.get('[data-testid="coordinator-start"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w2%3Ap1'))
  expect(posts).toEqual([{ url: '/api/pm/coordinator-start', body: { project: 'WEB', program: 'claude' } }])
  expect(newAgentOpen.value).toBe(false)
  w.unmount()
})

it('no existing project to start again: no Existing projects heading', async () => {
  const w = await openSheet([{ project: 'CO', name: 'Company', agent: opus, ran: opus, terminal: 'host/t1' }], [running])
  expect(w.find('[data-testid="project-existing"]').exists()).toBe(false)
  expect(w.text()).not.toContain('Existing projects')
  w.unmount()
})

it('adds a project from a git repository, a new folder or a folder without git, then starts its coordinator', async () => {
  const w = await openSheet([{ project: '_main', name: 'Main coordinator', main: true, agent: opus }])
  const folder = async (kind: string) => {
    await vi.waitFor(() => expect(w.find('[data-testid="project-folder"]').attributes('data-folder')).toBe(kind), { timeout: 2000 })
    return w.find('[data-testid="project-git-init"]').exists()
  }
  // A repository found on the machine: one tap, name and key from its folder, no git option.
  await vi.waitFor(() => expect(w.findAll('[data-repo]').map(b => b.text())).toEqual(['api~/api', 'web~/web']))
  await w.get('[data-repo="/repos/web"]').trigger('click')
  expect(await folder('git')).toBe(false)
  expect(w.find('[data-testid="project-no-remote"]').exists()).toBe(false)
  expect((w.get('#projectName').element as HTMLInputElement).value).toBe('web')
  expect((w.get('#projectKey').element as HTMLInputElement).value).toBe('WEB')
  // A folder without git: taken as it is, no git option either.
  await w.get('#projectPath').setValue('~/clients')
  expect(await folder('plain')).toBe(false)
  expect((w.get('#projectKey').element as HTMLInputElement).value).toBe('CLN')
  // A new folder: created at start, git init offered (off).
  await w.get('#projectName').setValue('Shop')
  await w.get('#projectPath').setValue('~/new-app')
  expect(await folder('new')).toBe(true)
  expect((w.get('#projectName').element as HTMLInputElement).value).toBe('Shop') // the user's name stays
  await w.get('[data-testid="project-git-init"]').trigger('click')
  // git init makes a repository without a remote: the hint says what works without one.
  await vi.waitFor(() => expect(w.get('[data-testid="project-no-remote"]').text()).toContain('git remote add origin <url>'))
  expect(w.find('[data-testid="project-template"]').exists()).toBe(false)
  expect(w.get('[data-testid="project-start"]').text()).toBe('Start with Claude')
  await w.get('[data-testid="project-start"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w2%3Ap1'))
  // No template: the project gets the minimal default, its coordinator proposes a workflow.
  expect(posts.map(p => p.url)).toEqual(['/api/pm/project', '/api/pm/coordinator-start'])
  expect(posts[0]!.body).toEqual({ key: 'NA', name: 'Shop', machine: '', path: '/repos/new-app', plain: true, create: true, gitInit: true })
  expect(posts[1]!.body).toEqual({ project: 'NA', program: 'claude' })
  w.unmount()
})

it('a browsed folder fills name and key, shows as ~/…, is probed and can start', async () => {
  const w = await openSheet([{ project: '_main', name: 'Main coordinator', main: true, agent: opus }])
  await w.get('[aria-label="Browse"]').trigger('click')
  await w.get('[data-testid="browse-choose"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="project-folder"]').attributes('data-folder')).toBe('plain'), { timeout: 2000 })
  expect((w.get('#projectPath').element as HTMLInputElement).value).toBe('~/clients')
  expect((w.get('#projectName').element as HTMLInputElement).value).toBe('clients')
  expect((w.get('#projectKey').element as HTMLInputElement).value).toBe('CLN')
  expect(w.get('[data-testid="project-start"]').attributes('disabled')).toBeUndefined()
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
