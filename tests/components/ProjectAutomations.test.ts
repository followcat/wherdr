import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProjectAutomations from '~/components/ProjectAutomations.vue'
import type { Automation } from '#shared/pm/automations'
import { pick } from '../helpers/select'

const posts: Record<string, unknown>[] = []
let list: Automation[] = []
registerEndpoint('/api/pm/automations', () => ({ automations: list, types: ['simple', 'study'] }))
registerEndpoint('/api/pm/automation', { method: 'POST', handler: async (e) => {
  const b = await readBody(e)
  posts.push(b)
  return b.runNow ? { firing: { at: 1, by: 'user', task: 'W3-9' } } : { automations: list }
} })

const at = new Date(2026, 10, 5, 4, 17).getTime()
const clean: Automation = { id: 'clean', name: 'Test cleanup', prompt: 'Remove dead tests', on: false, schedule: 'daily 04:17', last: 0,
  firings: [{ at, by: 'schedule', task: 'W3-4' }, { at: at + 1000, by: 'user', error: 'The project has no template' }] }
const watch: Automation = { id: 'watch', name: 'Docs check', prompt: 'Check the docs', on: true, event: 'merged', filter: 'docs*' }
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
const mount = async () => (w = await mountSuspended(ProjectAutomations, { props: { project: 'W3', name: 'wherdr' } }))
afterEach(() => { w?.unmount(); w = null; posts.length = 0 })

it('lists each automation with its switch, trigger and last firing; switch and run now post', async () => {
  list = [clean, watch]
  const b = await mount()
  await vi.waitFor(() => expect(b.findAll('[data-testid="automation"]')).toHaveLength(2))
  expect(b.findAll('[data-testid="automation-trigger"]').map(x => x.text())).toEqual(['daily 04:17', 'On merged · docs*'])
  expect(b.findAll('[data-testid="automation-last"]')[1]!.text()).toBe('Never fired')
  await b.findAll('[data-testid="automation-on"]')[0]!.trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'W3', automation: { ...clean, on: true } }]))
  await b.findAll('[data-testid="automation-run"]')[0]!.trigger('click')
  await vi.waitFor(() => expect(posts[1]).toEqual({ project: 'W3', id: 'clean', runNow: true }))
})

it('edits one: its last firings, newest first, and the changes saved', async () => {
  list = [clean]
  const b = await mount()
  await vi.waitFor(() => expect(b.find('[data-testid="automation-edit"]').exists()).toBe(true))
  await b.find('[data-testid="automation-edit"]').trigger('click')
  const firings = b.findAll('[data-testid="automation-firings"] li')
  expect(firings.map(f => f.classes('err'))).toEqual([true, false])
  expect(firings[1]!.text()).toContain('W3-4')
  await b.find('input#pa-schedule-W3').setValue('mon,thu 08:10')
  await pick(b, 'automation-type', 'study')
  await b.find('[data-testid="automation-form"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'W3', automation: { id: 'clean', on: false, name: 'Test cleanup', prompt: 'Remove dead tests', type: 'study', schedule: 'mon,thu 08:10' } }]))
})

it('adds one on an event, switched off, and removes one', async () => {
  list = []
  const b = await mount()
  await vi.waitFor(() => expect(b.find('[data-testid="automations-empty"]').exists()).toBe(true))
  await b.find('[data-testid="automation-add"]').trigger('click')
  expect(b.find('[data-testid="automation-save"]').attributes('disabled')).toBeDefined()
  await b.find('input#pa-name-W3').setValue('Docs check')
  await b.find('textarea#pa-prompt-W3').setValue('Check the docs')
  await b.find('[data-testid="automation-kind-event"]').trigger('click')
  await pick(b, 'automation-event', 'failed')
  await b.find('input#pa-filter-W3').setValue('docs*')
  await b.find('[data-testid="automation-form"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'W3', automation: { on: false, name: 'Docs check', prompt: 'Check the docs', type: '', event: 'failed', filter: 'docs*' } }]))
  list = [watch]
  await w!.unmount()
  const c = await mount()
  await vi.waitFor(() => expect(c.find('[data-testid="automation-edit"]').exists()).toBe(true))
  await c.find('[data-testid="automation-edit"]').trigger('click')
  await c.find('[data-testid="automation-remove"]').trigger('click')
  await vi.waitFor(() => expect(posts[1]).toEqual({ project: 'W3', id: 'watch', remove: true }))
})
