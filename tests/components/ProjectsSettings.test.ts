import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProjectsSettings from '~/components/ProjectsSettings.vue'
import type { PmOverview, Project } from '#shared/pm/project'
import { pick } from '../helpers/select'

// A fake server: the same rules as server/utils/pmStore.ts, in memory.
let state: PmOverview
const calls: { url: string, body: Record<string, unknown> }[] = []
const web = (): Project => ({ key: 'WEB', name: 'Web', machine: '', path: '/home/u/src/web', addedAt: 1, from: { template: 'vibe', version: 2 }, visibility: { value: 'public', at: 1, by: 'check' } })
const reset = () => {
  state = { enabled: false, projects: [], templates: [{ id: 'vibe', version: 2 }] }
  calls.length = 0
}
reset()
const post = (url: string, fn: (b: Record<string, unknown>) => unknown) => registerEndpoint(url, {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    calls.push({ url, body })
    return fn(body)
  },
})
const edit = (b: Record<string, unknown>, change: Partial<Project>) => {
  state = { ...state, projects: state.projects.map(p => p.key === b.key ? { ...p, ...change } : p) }
  return { project: {} }
}
registerEndpoint('/api/pm/overview', () => state)
registerEndpoint('/api/pm/project', () => ({ project: state.projects[0], workflow: { id: 'web', steps: [], prefs: { agent: 'claude', model: 'sonnet' } }, log: [] }))
post('/api/pm/enabled', (b) => { state = { ...state, enabled: b.enabled as boolean }; return state })
post('/api/pm/project-update', b => edit(b, { name: b.name as string, base: b.base as string }))
post('/api/pm/project-visibility', b => edit(b, { visibility: { value: b.value as 'private', at: 2, by: 'user' } }))

const inSheet = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset(); newAgentOpen.value = false })

it('switches project management on; Add project opens the New sheet on a new project', async () => {
  const w = await mountSuspended(ProjectsSettings, { props: { active: true } })
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="pm-switch"]').attributes('disabled')).toBeUndefined())
  expect(w.find('[data-testid="pm-add"]').exists()).toBe(false)

  await w.find('[data-testid="pm-switch"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="pm-empty"]').exists()).toBe(true))
  await w.find('[data-testid="pm-add"]').trigger('click')
  expect([newAgentOpen.value, newProjectOpen.value]).toEqual([true, true])
})

it('opens the project sheet on the URL\'s tab; General saves the name and base, and the visibility', async () => {
  state = { ...state, enabled: true, projects: [web()] }
  const w = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&project=WEB&tab=guards' })
  mounted = w
  await vi.waitFor(() => expect(inSheet('pm-coming')).not.toBeNull())
  expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab')).toBe('guards')

  document.body.querySelector<HTMLElement>('[data-tab="general"]')!.click()
  await vi.waitFor(() => expect(inSheet('pm-from')?.textContent).toContain('Based on: vibe v2'))
  const name = inSheet('pm-name')!.querySelector('input') ?? inSheet('pm-name') as HTMLInputElement
  ;(name as HTMLInputElement).value = 'Website'
  name.dispatchEvent(new Event('input'))
  inSheet('pm-save')!.closest('form')!.dispatchEvent(new Event('submit'))
  await vi.waitFor(() => expect(calls[0]).toEqual({ url: '/api/pm/project-update', body: { key: 'WEB', name: 'Website', base: '', prefs: { agent: 'claude', model: 'sonnet', reviewAgent: '', reviewModel: '' } } }))

  await vi.waitFor(() => expect(inSheet('pm-save')!.hasAttribute('disabled')).toBe(false))
  await pick(w, 'pm-visibility', 'private')
  await vi.waitFor(() => expect(w.find('[data-testid="pm-public"]').exists()).toBe(false))
  expect(calls[1]).toEqual({ url: '/api/pm/project-visibility', body: { key: 'WEB', value: 'private' } })
})
