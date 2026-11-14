import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, setResponseStatus } from 'h3'
import { nextTick } from 'vue'
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
  return { project: state.projects.find(p => p.key === b.key) }
}
// The overview's read: held by `gate` (loading), refused while `down`.
let gate: Promise<void> = Promise.resolve()
let down = false
registerEndpoint('/api/pm/overview', async (event) => {
  await gate
  if (!down) return state
  setResponseStatus(event, 503)
  return { error: 'Overview unavailable' }
})
registerEndpoint('/api/pm/project', () => ({ project: state.projects[0], workflow: { id: 'web', steps: [], taskTypes: {}, guards: { protected: ['main'] }, prefs: { agent: 'claude', model: 'sonnet' }, worktree: { share: [] } }, log: [] }))
post('/api/pm/enabled', (b) => { state = { ...state, enabled: b.enabled as boolean }; return state })
post('/api/pm/project-update', b => edit(b, { name: b.name as string, base: b.base as string, ...(b.newKey ? { label: b.newKey as string } : {}) }))
post('/api/pm/project-guards', () => ({}))
let coordinators: { project: string, name: string, proposal?: { diff: string, at: number, said?: string } }[] = []
let coordinatorReads = 0
registerEndpoint('/api/pm/coordinators', () => { coordinatorReads++; return coordinators })
let outdated = false
registerEndpoint('/api/pm/template-proposal', { method: 'POST', handler: async (event) => {
  calls.push({ url: '/api/pm/template-proposal', body: await readBody(event) })
  coordinators = [{ project: 'WEB', name: 'Web' }] // answered either way: the server drops it
  if (!outdated) return { accepted: true }
  setResponseStatus(event, 409)
  return { error: 'The template changed since this proposal: ask the coordinator to propose again' }
} })
post('/api/pm/project-visibility', b => edit(b, { visibility: { value: b.value as 'private', at: 2, by: 'user' } }))

const inSheet = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset(); newAgentOpen.value = false; gate = Promise.resolve(); down = false })

// WHR-328: while the overview loads, no off switch and no empty list: skeletons,
// the buttons disabled; a failed read shows its error and Try again.
it('loading shows skeletons, then the real values; a failed read shows Try again', async () => {
  let open!: () => void
  gate = new Promise((r) => { open = r })
  state = { ...state, enabled: true, projects: [web()] }
  const w = await mountSuspended(ProjectsSettings, { props: { active: true } })
  mounted = w
  expect(w.find('[data-testid="pm-switch"]').exists()).toBe(false)
  expect(w.find('[data-testid="skeleton-switch"]').exists()).toBe(true)
  expect(w.findAll('[data-testid="skeleton-row"]')).toHaveLength(3)
  expect(w.get('[data-testid="pm-add"]').attributes('disabled')).toBeDefined()
  expect(w.get('[data-testid="pm-board"]').attributes('disabled')).toBeDefined()
  open()
  await vi.waitFor(() => expect(w.findAll('[data-testid="pm-project"]')).toHaveLength(1))
  expect(w.get('[data-testid="pm-switch"]').attributes('aria-checked')).toBe('true')
  expect(w.find('[data-testid="skeleton-row"]').exists()).toBe(false)
  w.unmount()

  down = true
  const v = await mountSuspended(ProjectsSettings, { props: { active: true } })
  mounted = v
  await vi.waitFor(() => expect(v.get('[data-testid="load-error"]').text()).toContain('Overview unavailable'))
  expect(v.find('[data-testid="pm-switch"]').exists()).toBe(false)
  down = false
  await v.get('[data-testid="load-retry"]').trigger('click')
  await vi.waitFor(() => expect(v.findAll('[data-testid="pm-project"]')).toHaveLength(1))
})

it('switches project management on; Add project opens the setup window on a new project', async () => {
  const w = await mountSuspended(ProjectsSettings, { props: { active: true } })
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="pm-switch"]').attributes('disabled')).toBeUndefined())
  expect(w.find('[data-testid="pm-add"]').exists()).toBe(false)

  await w.find('[data-testid="pm-switch"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="pm-empty"]').exists()).toBe(true))
  await w.find('[data-testid="pm-add"]').trigger('click')
  await vi.waitFor(() => expect(inSheet('setup-project-form')).toBeTruthy())
  expect(w.get('[data-testid="pm-library"]').text()).toContain('1 saved · 4 examples')
  await w.get('[data-testid="pm-library"]').trigger('click')
  await vi.waitFor(() => expect(inSheet('library-saved')?.dataset.id).toBe('vibe'))
})

// WHR-243: Alfred's `ui open --target projects.setup` opens the setup window, not only a halo.
it('the projects.setup target opens the setup window', async () => {
  mounted = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&target=projects.setup' })
  await vi.waitFor(() => expect(inSheet('setup-wizard')).toBeTruthy())
})

it('opens the project sheet on the URL\'s tab; Guards saves a branch added; General saves the name, base, worktree setup, other projects its coordinator may act on, and the visibility', async () => {
  state = { ...state, enabled: true, projects: [web(), { ...web(), key: 'DOC', name: 'Docs', visibility: undefined }] }
  const w = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&project=WEB&tab=guards' })
  mounted = w
  await vi.waitFor(() => expect(inSheet('guard-chip')?.textContent).toContain('main'))
  expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab')).toBe('guards')
  const branch = inSheet('guard-add')!.querySelector('input') ?? inSheet('guard-add') as HTMLInputElement
  ;(branch as HTMLInputElement).value = 'develop'
  branch.dispatchEvent(new Event('input'))
  branch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  inSheet('guard-others-user')!.click()
  await nextTick()
  inSheet('guard-save')!.closest('form')!.dispatchEvent(new Event('submit'))
  await vi.waitFor(() => expect(calls.shift()).toEqual({ url: '/api/pm/project-guards', body: { key: 'WEB', guards: { protected: ['main', 'develop'], merge: { protected: 'user', others: 'user' } } } }))

  document.body.querySelector<HTMLElement>('[data-tab="general"]')!.click()
  await vi.waitFor(() => expect(inSheet('pm-from')?.textContent).toContain('Based on: vibe v2'))
  const name = inSheet('pm-name')!.querySelector('input') ?? inSheet('pm-name') as HTMLInputElement
  ;(name as HTMLInputElement).value = 'Website'
  name.dispatchEvent(new Event('input'))
  const copy = inSheet('pm-setup-copy')!.querySelector('textarea') ?? inSheet('pm-setup-copy') as HTMLTextAreaElement
  ;(copy as HTMLTextAreaElement).value = '.env\n config/local.json '
  copy.dispatchEvent(new Event('input'))
  await pick(w, 'pm-reach-DOC', 'act')
  inSheet('pm-save')!.closest('form')!.dispatchEvent(new Event('submit'))
  await vi.waitFor(() => expect(calls[0]).toEqual({ url: '/api/pm/project-update', body: {
    key: 'WEB', name: 'Website', coordinatorName: '', base: '', branchName: '', archiveAfter: 7, deleteBranch: true, reach: [{ project: 'DOC', level: 'act' }], prefs: { agent: 'claude', model: 'sonnet', reviewAgent: '', reviewModel: '', reviewFallbackAgent: '', reviewFallbackModel: '' },
    worktree: { copy: ['.env', 'config/local.json'], share: [], lockfile: '', command: '', timeout: '' }, // share none kept
  } }))

  await vi.waitFor(() => expect(inSheet('pm-general')!.getAttribute('aria-busy')).toBe('false'))
  expect(inSheet('pm-save')!.hasAttribute('disabled')).toBe(true) // saved: nothing to save
  await pick(w, 'pm-visibility', 'private')
  await vi.waitFor(() => expect(w.find('[data-testid="pm-public"]').exists()).toBe(false))
  expect(calls[1]).toEqual({ url: '/api/pm/project-visibility', body: { key: 'WEB', value: 'private' } })
})

it('a coordinator\'s proposal: badge on the row and on Workflow, the URL opens its review; answered once, it leaves; an outdated one shows the refusal', async () => {
  for (const old of [false, true]) {
    outdated = old
    state = { ...state, enabled: true, projects: [web()] }
    coordinators = [{ project: 'WEB', name: 'Web', proposal: { diff: '-   "instructions": "a",\n+   "instructions": "b",', at: 1, said: 'Use b' } }]
    const w = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&project=WEB&tab=workflow&review=1' })
    mounted = w
    await vi.waitFor(() => expect(inSheet('proposal-said')?.textContent).toBe('Use b'))
    expect(w.find('[data-testid="pm-review"]').exists()).toBe(true)
    expect(inSheet('workflow-badge')).not.toBeNull()
    expect([...inSheet('proposal-diff')!.querySelectorAll('.add')].map(x => x.textContent?.trim())).toEqual(['+   "instructions": "b",'])
    inSheet('proposal-accept')!.click()
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ url: '/api/pm/template-proposal', body: { project: 'WEB', accept: true } }))
    await vi.waitFor(() => expect(inSheet('workflow-badge')).toBeNull())
    expect(w.find('[data-testid="pm-review"]').exists()).toBe(false)
    if (old) expect(inSheet('proposal-review')?.textContent).toContain('The template changed since this proposal')
    mounted.unmount()
    mounted = null
  }
  outdated = false
})

// WHR-284: the worktree setup's help sits above its fields, Save on its own row,
// enabled only once something changed.
it('the worktree setup: help above the fields, Save on its own row and enabled only after a change', async () => {
  state = { ...state, enabled: true, projects: [web()] }
  mounted = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&project=WEB&tab=general' })
  await vi.waitFor(() => expect(inSheet('pm-setup-copy')).toBeTruthy())
  const help = inSheet('pm-setup-help')!
  const save = inSheet('pm-save')!
  expect(help.contains(save)).toBe(false)
  expect(save.parentElement!.classList.contains('pm-save')).toBe(true)
  expect(help.compareDocumentPosition(inSheet('pm-setup-copy')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(save.hasAttribute('disabled')).toBe(true)
  inSheet('pm-setup-no-share')!.click()
  await vi.waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
})

it('a saved key stays in the field and the badge, and the shared coordinators are read again', async () => {
  state = { ...state, enabled: true, projects: [web()] }
  const w = await mountSuspended(ProjectsSettings, { props: { active: true }, route: '/settings?section=projects&project=WEB&tab=general' })
  mounted = w
  await vi.waitFor(() => expect(inSheet('pm-setup-copy')).toBeTruthy())
  const key = inSheet('pm-key')!.querySelector('input') ?? inSheet('pm-key') as HTMLInputElement
  ;(key as HTMLInputElement).value = 'site'
  key.dispatchEvent(new Event('input'))
  await nextTick()
  const reads = coordinatorReads
  inSheet('pm-save')!.closest('form')!.dispatchEvent(new Event('submit'))
  await vi.waitFor(() => expect(calls.at(-1)?.body.newKey).toBe('SITE'))
  await vi.waitFor(() => expect(inSheet('pm-general')!.getAttribute('aria-busy')).toBe('false'))
  expect((key as HTMLInputElement).value).toBe('SITE')
  expect(document.body.querySelector('.pm-key-row .project-badge')?.textContent?.trim()).toBe('SITE')
  expect(coordinatorReads).toBeGreaterThan(reads)
})
