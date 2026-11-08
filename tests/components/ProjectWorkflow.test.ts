import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody } from 'h3'
import ProjectWorkflow from '~/components/ProjectWorkflow.vue'
import { company, vibe } from '#shared/pm/examples'
import type { Template } from '#shared/pm/workflow'
import type { Project } from '#shared/pm/project'
import { pick, selects, selectValue } from '../helpers/select'
import { NONE } from '~/utils/selectNone'

// A fake server: it records the posts.
const posts: { url: string, body: Record<string, unknown> }[] = []
for (const url of ['/api/pm/project-workflow', '/api/pm/template-from-project', '/api/pm/project-apply']) {
  registerEndpoint(url, { method: 'POST', handler: async (event) => { posts.push({ url, body: await readBody(event) }); return {} } })
}
registerEndpoint('/api/pm/template', { method: 'GET', handler: event => ({ template: { ...vibe, id: String(getQuery(event).id), version: 3 }, log: [] }) })

const project: Project = { key: 'WEB', name: 'Web', machine: '', path: '~/project', addedAt: 1 }
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; posts.length = 0; document.body.innerHTML = '' })
const mount = async (workflow: Template = { ...company, id: 'web', version: 4 }) => (mounted = await mountSuspended(ProjectWorkflow, {
  attachTo: document.body,
  props: { project, workflow, log: [{ at: 0, by: 'user', version: 4, changes: ['feature.work'] }], templates: [{ id: 'web', version: 1 }] },
}))
type W = Awaited<ReturnType<typeof mount>>
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const errors = (w: W) => w.findAll('[data-testid="tpl-errors"] li').map(l => l.text())
const plan = (w: W) => w.findAll('[data-testid="tpl-plan"] li').map(l => l.text().split(' ')[0])
// The ⋯ menu's entry, as the sheet runs it.
const menu = async (w: W, label: string) => {
  (w.vm as unknown as { menu: () => MenuItem[] }).menu().find(m => m.label === label)!.run!()
  await nextTick()
}
const area = () => document.querySelector<HTMLTextAreaElement>('textarea[data-testid="tpl-json"], [data-testid="tpl-json"] textarea')!
const json = () => JSON.parse(area().value)
const type = async (el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input')); await nextTick() }

it('edits the project\'s steps in the form, previews the plan and saves them to the project', async () => {
  const w = await mount()
  expect(w.findAll('[data-testid="tpl-step"]')).toHaveLength(7)
  expect(plan(w)).toEqual(['todo', 'work', 'review', 'pr', 'merge', 'deploy', 'done'])

  // The worker step held by no one: refused, with its line in the JSON.
  expect(selectValue(w, 'tpl-holder', 4)).toBe('none') // merge
  await pick(w, 'tpl-holder', 'none', 1)
  const src = JSON.stringify({ ...company, id: 'web', version: 4 }, null, 2).split('\n')
  const line = src.findIndex((l, n) => n > src.findIndex(x => x.includes('"id": "work"')) && l.includes('"holder"')) + 1
  expect(errors(w)).toEqual([`Line ${line} · taskTypes.feature.steps[1].holder: an agent must hold a step that ends with report`])
  expect(w.find('[data-testid="tpl-save"]').attributes('disabled')).toBeDefined()
  expect(plan(w)).toEqual([])
  await pick(w, 'tpl-holder', 'worker', 1)
  expect(errors(w)).toEqual([])

  await w.find('[data-testid="tpl-add"]').trigger('click')
  expect(plan(w)).toEqual(['todo', 'work', 'review', 'pr', 'merge', 'deploy', 'done', 'step-8'])
  await w.find('[data-testid="tpl-save"]').trigger('click')
  await vi.waitFor(() => expect(w.emitted('changed')).toHaveLength(1))
  expect(posts[0]).toMatchObject({ url: '/api/pm/project-workflow', body: { key: 'WEB' } })
  expect((posts[0]!.body.workflow as Template).taskTypes.feature!.steps.at(-1)).toEqual({ id: 'step-8' })
})

it('edits the JSON from the ⋯ menu: the faulty line, then the fixed text saved', async () => {
  const w = await mount({ ...vibe, id: 'web', version: 1 })
  await menu(w, 'Edit as JSON')
  await vi.waitFor(() => expect(area()).not.toBeNull())
  const good = area().value
  const jsonErrors = () => [...document.querySelectorAll('[data-testid="tpl-json-errors"] li')].map(l => l.textContent!.trim())

  await type(area(), good.replace('"ends": "report",', '"ends": "report"'))
  expect(jsonErrors()[0]).toMatch(/^Line \d+ · expected , or }$/)
  await type(area(), good.replace('"ends": "report"', '"ends": "finished"'))
  expect(jsonErrors()[0]).toMatch(/^Line \d+ · taskTypes\.simple\.steps\[1\]\.ends: must be one of/)
  expect(q('tpl-json-save')!.hasAttribute('disabled')).toBe(true)
  // The steps form waits for a fix when the shape is broken.
  await type(area(), '{')
  expect(w.findAll('[data-testid="tpl-step"]')).toHaveLength(0)

  await type(area(), good.replace('npm run lint', 'npm test'))
  expect(jsonErrors()).toEqual([])
  q('tpl-json-save')!.click()
  await vi.waitFor(() => expect(posts).toHaveLength(1))
  expect((posts[0]!.body.workflow as Template).taskTypes.simple!.steps[1]).toMatchObject({ instructions: expect.stringContaining('npm test') })
})

it('saves the workflow as a library template, and starts over only after showing the diff', async () => {
  const w = await mount({ ...vibe, id: 'web', version: 1 })
  const saveAs = () => (w.vm as unknown as { menu: () => MenuItem[] }).menu().find(m => m.label === 'Save as template…')!
  // Unsaved edits: Save as template would copy the stored workflow, so it waits.
  await w.find('[data-testid="tpl-add"]').trigger('click')
  expect(saveAs()).toMatchObject({ disabled: true, desc: 'Save your changes first' })
  await w.setProps({ workflow: { ...vibe, id: 'web', version: 1 } }) // reloaded: the edit is gone
  expect(saveAs().disabled).toBe(false)
  await menu(w, 'Save as template…')
  await vi.waitFor(() => expect(q('wf-save-as-id')).not.toBeNull())
  const id = (q('wf-save-as-id')!.querySelector('input') ?? q('wf-save-as-id')) as HTMLInputElement
  expect(id.value).toBe('web-copy') // web is taken in the library
  q('wf-save-as')!.click()
  await vi.waitFor(() => expect(posts[0]).toEqual({ url: '/api/pm/template-from-project', body: { key: 'WEB', id: 'web-copy' } }))
  // Only the library changed: the project's workflow is not reloaded.
  await vi.waitFor(() => expect(w.emitted('templates')).toHaveLength(1))
  expect(w.emitted('changed')).toBeUndefined()

  await menu(w, 'Start over from a template…')
  await vi.waitFor(() => expect(q('wf-start-pick')).not.toBeNull())
  q('wf-start-pick')!.querySelector<HTMLElement>('[data-pick="example:company"]')!.click()
  await vi.waitFor(() => expect(q('wf-start-diff')?.textContent).toContain('+ '))
  expect(posts).toHaveLength(1)
  q('wf-start-apply')!.click()
  await vi.waitFor(() => expect(posts[1]).toEqual({ url: '/api/pm/project-apply', body: { key: 'WEB', template: 'example:company' } }))
})

it('sets screenshots as a step\'s evidence: after only, before and after, or none', async () => {
  const w = await mount()
  await menu(w, 'Edit as JSON')
  const shots = () => selects(w, 'tpl-shots') // work, pr, deploy: the report steps
  const step = (id: string) => json().taskTypes.feature.steps.find((s: { id?: string }) => s.id === id)
  expect(shots()).toHaveLength(3)
  await pick(w, 'tpl-shots', 'before-after', 1)
  await pick(w, 'tpl-shots', 'after', 0)
  expect(selectValue(w, 'tpl-shots', 1)).toBe('before-after')
  expect(step('pr')).toMatchObject({ evidence: ['link', 'screenshots'], screenshots: 'before-after' })
  expect(step('work').evidence).toEqual(['screenshots'])
  expect(step('work').screenshots).toBeUndefined()
  await pick(w, 'tpl-shots', NONE, 1)
  expect(step('pr').evidence).toEqual(['link'])
  expect(step('pr').screenshots).toBeUndefined()
})

it('shows a step\'s action as fields, edits it, and says what each step does', async () => {
  const w = await mount({ ...vibe, id: 'web', version: 1 })
  await menu(w, 'Edit as JSON')
  const step = (id: string) => json().taskTypes.simple.steps.find((s: { id?: string }) => s.id === id)
  const kind = () => w.find('[data-testid="tpl-action"]')
  const input = (id: string) => w.find(`input[data-testid="${id}"], [data-testid="${id}"] input`)
  const says = () => w.findAll('[data-testid="tpl-say"]').map(p => p.text())
  // land: merge into dev, no PR, with its plain label and sentence.
  expect(selectValue(w, 'tpl-action')).toBe('git.land')
  expect(kind().text()).toBe('Merge into dev (no PR)')
  expect((input('tpl-action-branch').element as HTMLInputElement).value).toBe('dev')
  expect(says()).toEqual([
    'The task waits here until it starts.',
    'The worker does the task and says when it is done.',
    'The engine merges the task’s branch into dev and pushes it, without a PR. A conflict sends it back to the agent.',
    'The task is done.',
  ])
  expect(w.find('[data-testid="tpl-plan"]').text()).toContain('without a PR')
  expect(w.findAll('[data-testid="tpl-holder"]')[2]!.text()).toBe('none · the engine or you')

  // Into main, protected: the sentence says the merge waits for you.
  await input('tpl-action-branch').setValue('main')
  expect(says()[2]).toContain('main is protected: it waits for you to merge.')
  // Another kind keeps the branch, as the PR's base.
  await pick(w, 'tpl-action', 'github.pr')
  expect(step('land').action).toEqual({ kind: 'github.pr', base: 'main' })
  await pick(w, 'tpl-action', 'github.merge')
  await pick(w, 'tpl-action-method', 'squash')
  await input('tpl-action-checks').setValue('smoke, lint')
  await input('tpl-action-checks').trigger('change')
  expect(says()[2]).toBe('The engine merges the GitHub PR (squash) once smoke, lint are green.')
  // A step that no longer ends with an action drops it.
  await pick(w, 'tpl-ends', NONE, 2)
  expect(w.find('[data-testid="tpl-action"]').exists()).toBe(false)
  expect(step('land')).toEqual({ id: 'land', column: 'Working' })
})
