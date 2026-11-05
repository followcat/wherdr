import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProjectsSettings from '~/components/ProjectsSettings.vue'
import type { PmOverview } from '#shared/pm/project'

// A fake server: the same rules as server/utils/pmStore.ts, in memory.
let state: PmOverview
const calls: { url: string, body: Record<string, unknown> }[] = []
const reset = () => {
  state = { enabled: false, projects: [], templates: [{ id: 'vibe', version: 1 }, { id: 'company' }] }
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
registerEndpoint('/api/pm/overview', () => state)
post('/api/pm/enabled', (b) => { state = { ...state, enabled: b.enabled as boolean }; return state })
post('/api/pm/project', (b) => {
  const p = { key: String(b.key).toUpperCase(), name: String(b.name || b.key).trim(), machine: '', path: '/home/u/src/web', template: b.template as string, addedAt: 1 }
  state = { ...state, projects: [...state.projects, p] }
  return { project: p }
})
post('/api/pm/project-template', (b) => {
  state = { ...state, projects: state.projects.map(p => p.key === b.key ? { ...p, template: b.template as string } : p) }
  return { project: {} }
})

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset() })

it('switches project management on, adds a project with its template, then changes it', async () => {
  const w = await mountSuspended(ProjectsSettings, { props: { active: true } })
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="pm-switch"]').attributes('disabled')).toBeUndefined())
  // Off: no project list, no form.
  expect(w.find('form').exists()).toBe(false)

  await w.find('[data-testid="pm-switch"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="pm-empty"]').exists()).toBe(true))
  expect(calls).toEqual([{ url: '/api/pm/enabled', body: { enabled: true } }])

  await w.find('#pmKey').setValue('web')
  await w.find('#pmPath').setValue(' ~/src/web ')
  await w.find('[data-testid="pm-template"]').setValue('vibe')
  await w.find('form').trigger('submit')
  await vi.waitFor(() => expect(w.findAll('[data-testid="pm-project"]')).toHaveLength(1))
  expect(calls[1]).toEqual({ url: '/api/pm/project', body: { key: 'web', name: '', machine: '', path: '~/src/web', base: '', template: 'vibe' } })
  expect(w.find('[data-testid="pm-project"]').text()).toContain('/src/web')
  expect((w.find('#pmKey').element as HTMLInputElement).value).toBe('')

  await w.find('[data-testid="pm-project-template"]').setValue('company')
  await vi.waitFor(() => expect(calls[2]).toEqual({ url: '/api/pm/project-template', body: { key: 'WEB', template: 'company' } }))
})
