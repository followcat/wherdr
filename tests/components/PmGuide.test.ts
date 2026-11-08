import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import PmGuide from '~/components/PmGuide.vue'
import type { PmOverview } from '#shared/pm/project'
import type { CoordinatorView } from '#shared/pm/coordinator'

// What the fake server answers; each case sets it before mounting.
let overview: PmOverview
let coords: Partial<CoordinatorView>[] = []
registerEndpoint('/api/pm/overview', () => overview)
registerEndpoint('/api/pm/coordinators', () => coords)

const project = (key: string, template?: string) => ({ key, name: key, machine: '', path: `/src/${key}`, addedAt: 1, ...(template ? { from: { template, version: 1 } } : {}) })

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; coords = [] })

async function states(props: { always?: boolean } = {}) {
  const w = await mountSuspended(PmGuide, { props })
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="pm-guide-step"]')).toHaveLength(4))
  return Object.fromEntries(w.findAll('[data-testid="pm-guide-step"]').map(s => [s.attributes('data-step'), s.attributes('data-done') === 'true']))
}

it('marks nothing done while project management is off', async () => {
  overview = { enabled: false, projects: [], templates: [] }
  expect(await states()).toEqual({ enable: false, template: false, projects: false, coordinator: false })
})

it('an imported project without a template leaves step 3 to do, and the coordinator cannot start', async () => {
  overview = { enabled: true, projects: [project('WEB', 'vibe'), project('API')], templates: [{ id: 'vibe' }] }
  coords = [{ project: 'WEB' }]
  // One project has a template: the guide is no longer needed on its own.
  const w = await mountSuspended(PmGuide, { props: {} })
  mounted = w
  await new Promise(r => setTimeout(r, 50))
  expect(w.find('[data-testid="pm-guide"]').exists()).toBe(false)
  w.unmount(); mounted = null
  expect(await states({ always: true })).toEqual({ enable: true, template: true, projects: false, coordinator: false })
})

it('marks every step done once each project has a template and its coordinator ran', async () => {
  overview = { enabled: true, projects: [project('WEB', 'vibe')], templates: [{ id: 'vibe' }] }
  coords = [{ project: 'WEB', terminal: 'local:1:2' }]
  expect(await states({ always: true })).toEqual({ enable: true, template: true, projects: true, coordinator: true })
})

it('with no project yet, the coordinator step is disabled', async () => {
  overview = { enabled: true, projects: [], templates: [{ id: 'vibe' }] }
  expect(await states()).toEqual({ enable: true, template: true, projects: false, coordinator: false })
  const w = await mountSuspended(PmGuide)
  await vi.waitFor(() => expect(w.findAll('[data-testid="pm-guide-action"]')).toHaveLength(4))
  expect(w.findAll('[data-testid="pm-guide-action"]')[3]!.attributes('disabled')).toBeDefined()
  w.unmount()
})

it('starts the project coordinator with the user\'s first offered agent that can run it (Settings › Agents)', async () => {
  const { readBody } = await import('h3')
  const { agentOrder, appConfig, hiddenAgents } = await import('~/composables/useHerdr')
  const posts: unknown[] = []
  registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => { posts.push(await readBody(e)); return { terminal: 'host/t9' } } })
  appConfig.value = { ...appConfig.value, machines: undefined, kinds: ['claude', 'omp', 'codex'] }
  agentOrder.value = ['omp', 'claude', 'codex']
  hiddenAgents.value = ['claude']
  overview = { enabled: true, projects: [project('WEB', 'vibe')], templates: [{ id: 'vibe' }] }
  coords = [{ project: 'WEB' }]
  const w = await mountSuspended(PmGuide, { props: { always: true } })
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="pm-guide-action"]')[3]!.attributes('disabled')).toBeUndefined())
  await w.findAll('[data-testid="pm-guide-action"]')[3]!.trigger('click')
  // OMP comes first but cannot run a project coordinator; Claude is unchecked.
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'WEB', program: 'codex' }]))
  hiddenAgents.value = []; agentOrder.value = []
})
