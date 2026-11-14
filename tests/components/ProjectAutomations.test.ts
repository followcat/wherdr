import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProjectAutomations from '~/components/ProjectAutomations.vue'
import type { Automation, AutomationProposal } from '#shared/pm/automations'

const posts: [string, Record<string, unknown>][] = []
let list: Automation[] = []
let proposals: AutomationProposal[] = []
registerEndpoint('/api/pm/automations', () => ({ automations: list, proposals, next: { clean: at + 86_400_000, watch: at } }))
for (const url of ['/api/pm/automation', '/api/pm/automation-proposal']) {
  registerEndpoint(url, { method: 'POST', handler: async (e) => {
    const b = await readBody(e)
    posts.push([url, b])
    if (url.endsWith('proposal')) proposals = []
    return b.runNow ? { firing: { at: 1, by: 'user', task: 'W3-9' } } : { automations: list }
  } })
}

const at = new Date(2026, 10, 5, 4, 17).getTime()
const clean: Automation = { id: 'clean', name: 'Test cleanup', prompt: 'Remove dead tests', on: true, schedule: '0 9 * * 1-5', last: at,
  firings: [{ at, by: 'schedule', task: 'W3-4' }, { at: at + 1000, by: 'schedule', error: 'paced: the account hit its limit' }, { at: at + 2000, by: 'user', error: 'The project has no template' }] }
const watch: Automation = { id: 'watch', name: 'Docs check', prompt: 'Check the docs', on: false, event: 'merged', filter: 'docs*' }
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
const mount = async () => (w = await mountSuspended(ProjectAutomations, { props: { project: 'W3', name: 'wherdr' } }))
afterEach(() => { w?.unmount(); w = null; posts.length = 0; proposals = [] })

it('lists each automation: its trigger in words, its next firing, its last results newest first; no form, the switch and run now post', async () => {
  list = [clean, watch]
  const b = await mount()
  await vi.waitFor(() => expect(b.findAll('[data-testid="automation"]')).toHaveLength(2))
  expect(b.find('form').exists()).toBe(false)
  expect(b.find('[data-testid="automation-ask"]').exists()).toBe(true)
  expect(b.findAll('[data-testid="automation-trigger"]').map(x => x.text())).toEqual(['every weekday at 9:00', 'when a task is merged · docs*'])
  expect(b.findAll('[data-testid="automation-next"]')).toHaveLength(1)
  const firings = b.findAll('[data-testid="automation-firing"]')
  expect(firings.map(f => f.classes().filter(c => c !== 'pa-firing'))).toEqual([['failed'], ['skipped'], ['fired']])
  expect(firings[2]!.text()).toContain('Fired W3-4')
  expect(firings[1]!.text()).toContain('Skipped paced: the account hit its limit')
  expect(b.find('[data-testid="automation-never"]').text()).toBe('Never fired')
  await b.findAll('[data-testid="automation-on"]')[1]!.trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([['/api/pm/automation', { project: 'W3', id: 'watch', on: true }]]))
  await b.findAll('[data-testid="automation-run"]')[0]!.trigger('click')
  await vi.waitFor(() => expect(posts[1]).toEqual(['/api/pm/automation', { project: 'W3', id: 'clean', runNow: true }]))
})

it('shows a proposal made while the tab is open, with its whole prompt; Accept answers it', async () => {
  list = []
  vi.useFakeTimers({ toFake: ['setInterval'] })
  const b = await mount()
  await vi.waitFor(() => expect(b.find('[data-testid="automations-empty"]').exists()).toBe(true))
  proposals = [{ id: 'p1-docs', project: 'W3', action: 'add', automation: { ...watch, prompt: 'Check the docs\n2\n3\n4\n5\nsixth line' }, at, by: 'W3' }]
  vi.advanceTimersByTime(15_000)
  vi.useRealTimers()
  await vi.waitFor(() => expect(b.find('[data-testid="automation-proposal"]').exists()).toBe(true))
  expect(b.find('.ap-prompt').text()).toContain('sixth line')
  const card = b.find('[data-testid="automation-proposal"]')
  expect(card.text()).toContain('New automation')
  expect(card.text()).toContain('Check the docs')
  expect(card.find('[data-testid="automation-proposal-when"]').text()).toBe('when a task is merged · docs*')
  await card.find('[data-testid="automation-proposal-accept"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([['/api/pm/automation-proposal', { project: 'W3', id: 'p1-docs', accept: true }]]))
  await vi.waitFor(() => expect(b.find('[data-testid="automation-proposal"]').exists()).toBe(false))
})
