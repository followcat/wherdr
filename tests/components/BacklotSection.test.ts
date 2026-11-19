import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import BacklotSection from '~/components/BacklotSection.vue'
import { herdrState } from '~/composables/useHerdr'
import { machineBarSaved } from '~/composables/useMachineBar'
import type { BacklotMachineView, BacklotRole, BacklotStudio } from '#shared/backlot'

registerEndpoint('/api/backlot', () => ({ ok: true, machines: [] }))
const posts: unknown[] = []
registerEndpoint('/api/backlot/action', { method: 'POST', handler: async (event) => { posts.push(await readBody(event)); return { ok: true, output: 'done' } } })

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', state: 'live', ...more })
const studio = (more: Partial<BacklotStudio> = {}): BacklotStudio => ({
  id: 'shop', title: 'Acme shop', state: 'live', requirement_version: 3, open_reviews: 0, waiting: 2, tasks_done: 2, tasks_total: 5, roles: [role()], ...more,
})
const view = (more: Partial<BacklotMachineView> = {}): BacklotMachineView => ({
  machine: '', label: 'host-a', stageRunning: true, backlotVersion: '1.0.0',
  summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio()], hollywood: null }, ...more,
})

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; posts.length = 0; machineBarSaved.value = null; herdrState.value = { ok: false, workspaces: [], panes: [] }; document.body.innerHTML = '' })

it('renders nothing when no machine publishes a backlot document', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [] } })
  expect(w.find('[data-testid="backlot-section"]').exists()).toBe(false)
})

it('shows the studios, progress, waiting count and a stopped stage, then starts it', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view({ stageRunning: false })] }, attachTo: document.body })
  const section = w.find('[data-testid="backlot-section"]')
  expect(section.exists()).toBe(true)
  expect(section.find('.group-title').text()).toContain('Studios')
  expect(section.find('[data-testid="backlot-waiting"]').text()).toBe('2')
  const card = section.find('[data-testid="backlot-studio-local-shop"]')
  expect(card.text()).toContain('Acme shop')
  expect(card.text()).toContain('r3 · 2/5')
  expect(card.text()).toContain('2 waiting')
  expect(section.find('[data-testid="backlot-stage-notice"]').text()).toContain('Stage not running')
  await section.find('[data-testid="backlot-stage-start"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'stage-start', machine: '' }]))
})

it('opens the studio sheet from its card', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view()] }, attachTo: document.body })
  await w.find('[data-testid="backlot-studio-local-shop"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).not.toBeNull())
})

it('keeps one card per machine and follows the machine bar filter', async () => {
  herdrState.value = {
    ok: true, workspaces: [], panes: [],
    machines: [
      { key: '', label: 'host-a', local: true, status: 'online', error: null },
      { key: '6b', label: 'host-b', local: false, status: 'online', error: null },
      { key: '6c', label: 'host-c', local: false, status: 'online', error: null },
    ],
  }
  const machines = [
    view({ machine: 'host-b', label: 'host-b', summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio({ id: 'beta', title: 'Beta tools' })], hollywood: null } }),
    view({ machine: 'host-c', label: 'host-c', summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio({ id: 'gamma', title: 'Gamma' })], hollywood: null } }),
  ]
  machineBarSaved.value = '6b'
  w = await mountSuspended(BacklotSection, { props: { machines }, attachTo: document.body })
  expect(w.findAll('[data-testid^="backlot-studio-"]').map(c => c.text())).toEqual([expect.stringContaining('Beta tools')])
  expect(w.find('[data-testid="backlot-studio-host-b-beta"]').exists()).toBe(true)
  expect(w.find('[data-testid="backlot-studio-host-c-gamma"]').exists()).toBe(false)
  machineBarSaved.value = '*'
  await vi.waitFor(() => expect(w!.findAll('[data-testid^="backlot-studio-"]')).toHaveLength(2))
})

it('shows Hollywood cards and tells Hollywood from the section', async () => {
  const machine = view({
    summary: {
      schema: 'backlot/1', updated_ms: 1, studios: [studio()],
      hollywood: { state: 'live', headline: 'Ship it', cards: [{ id: 'c1', studio: 'shop', action: 'merge', why: 'ready' }] },
    },
  })
  w = await mountSuspended(BacklotSection, { props: { machines: [machine] }, attachTo: document.body })
  const holly = w.find('[data-testid="backlot-hollywood-local"]')
  expect(holly.text()).toContain('Ship it')
  expect(holly.text()).toContain('1 open cards')
  await holly.find('[data-testid="backlot-card-apply"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'card-apply', machine: '', cardId: 'c1' }]))
  await holly.find('[data-testid="backlot-tell-hollywood"]').trigger('click')
  await holly.find('input').setValue('Focus on checkout')
  await holly.find('[data-testid="backlot-tell-hollywood-send"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([
    { kind: 'card-apply', machine: '', cardId: 'c1' },
    { kind: 'tell-hollywood', machine: '', text: 'Focus on checkout' },
  ]))
})
