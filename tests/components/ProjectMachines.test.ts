// The project sheet's Machines block: home read only, an added machine saved
// with its clone through project-update, then its readiness check shown; each
// machine's last check, run again with Check; remove; its switch pauses it.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProjectMachines from '~/components/ProjectMachines.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Project } from '#shared/pm/project'
import { machineNow, type MachineView } from '#shared/pm/placement'
import { WEIGHT_DEFAULTS, type Weight } from '#shared/pm/weight'
import type { MachineInfo } from '#shared/types'
import { pick, selectLabels } from '../helpers/select'

const posts: [string, Record<string, unknown>][] = []
registerEndpoint('/api/pm/project-update', { method: 'POST', handler: async (e) => { posts.push(['update', await readBody(e)]); return {} } })
// Laptop is a Mac: its room is macOS's available estimate, by its pressure.
registerEndpoint('/api/machine/memory', () => ({ machines: [{ key: 'a', mem: { total: 18432, available: 8479, swapTotal: 0, swapFree: 0, pressure: 'normal' } }] }))
registerEndpoint('/api/pm/project-machine-check', { method: 'POST', handler: async (e) => { posts.push(['check', await readBody(e)]); return { items: [], at: 1, refused: 'gh login: not logged in' } } })

let live: unknown = { machines: [], next: null }
registerEndpoint('/api/pm/project-machines', () => live)

const m = (key: string, label: string, status: MachineInfo['status'] = 'online') => ({ key, label, local: !key, status, error: null }) as MachineInfo
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; posts.length = 0 })

it('adds a connected machine with its clone, shows its check, and removes one', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [], machines: [m('', 'Host'), m('a', 'Laptop'), m('b', 'Builder'), m('c', 'Away', 'offline')] }
  const project = { key: 'WEB', name: 'Web', machine: '', path: '~/project', machines: ['', 'a'], clones: { a: '~/web' } } as Project
  const b = w = await mountSuspended(ProjectMachines, { props: { project } })
  expect(b.text()).toContain('Host Home')
  await vi.waitFor(() => expect(b.find('[data-testid="pm-machine-memory"]').text()).toBe('pressure normal, ≈8.3 GB available of 18.0 GB'))
  expect(b.findAll('[data-testid="pm-machine-ready"]').map(x => x.text())).toEqual(['Not checked yet'])
  await b.setProps({ ready: { a: '' } })
  expect(b.find('[data-testid="pm-machine-ready"]').text()).toBe('Ready')
  expect(selectLabels(b, 'pm-machine-pick')).toEqual(['Builder'])

  await pick(b, 'pm-machine-pick', 'b')
  await b.find('[data-testid="pm-machine-clone"]').setValue('~/project')
  await b.find('form').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([
    ['update', { key: 'WEB', machines: ['a', 'b'], clones: { b: '~/project' } }],
    ['check', { key: 'WEB', machine: 'b' }],
  ]))
  expect(b.emitted('changed')).toHaveLength(1)

  await b.setProps({ project: { ...project, machines: ['', 'a', 'b'], clones: { a: '~/web', b: '~/project' } } })
  await vi.waitFor(() => expect(b.findAll('[data-testid="pm-machine-ready"]').map(x => x.text())).toEqual(['Ready', 'Not ready: gh login: not logged in']))
  // Check runs that machine's check again; its answer replaces the last one.
  await b.findAll('[data-testid="pm-machine-check"]')[0]!.trigger('click')
  await vi.waitFor(() => expect(b.findAll('[data-testid="pm-machine-ready"]')[0]!.text()).toBe('Not ready: gh login: not logged in'))
  expect(posts[2]).toEqual(['check', { key: 'WEB', machine: 'a' }])
  await b.findAll('[data-testid="pm-machine-remove"]')[0]!.trigger('click')
  await vi.waitFor(() => expect(posts[3]).toEqual(['update', { key: 'WEB', machines: ['b'], clones: {} }]))
  // Its switch off: paused for the project, its clone kept.
  await b.findAll('[data-testid="pm-machine-on"]')[2]!.trigger('click')
  await vi.waitFor(() => expect(posts[4]).toEqual(['update', { key: 'WEB', paused: ['b'] }]))
  await b.setProps({ project: { ...project, machines: ['', 'a', 'b'], clones: { a: '~/web', b: '~/project' }, paused: ['b'] } })
  expect(b.findAll('[data-testid="pm-machine-paused"]').map(x => x.text())).toEqual(['Paused for this project: no new task starts here'])
})

// The live view: each machine's card with what it takes now or why not, and the next task's line.
const GB = 1024
const view = (key: string, totalGb: number, freeGb: number, running: Weight[], more: Partial<MachineView> = {}): MachineView => ({
  key, label: key, home: !key, online: true, settings: { minFreeMb: 2 * GB },
  capacity: { cores: 8, total: totalGb * GB, available: freeGb * GB, swapTotal: 0, swapFree: 0, load1: 1.5 },
  running: running.map((w, i) => ({ ...WEIGHT_DEFAULTS[w], weight: w, task: `WEB-${i + 1}` })), ...more,
})

it('shows each machine live: full, paused, offline and free, and where the next task goes', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [], machines: [m('', 'Host'), m('a', 'Laptop'), m('b', 'Builder'), m('c', 'Away', 'offline')] }
  const project = { key: 'WEB', name: 'Web', machine: '', path: '~/project', machines: ['', 'a', 'b', 'c'], clones: { a: '~/web', b: '~/web', c: '~/web' }, paused: ['a'] } as Project
  live = {
    machines: [
      view('', 8, 6, ['standard', 'light'], { settings: { minFreeMb: 2 * GB, maxAgents: 2 } }),
      view('a', 16, 12, ['light'], { paused: true }),
      view('c', 16, 12, [], { online: false, capacity: null }),
      view('b', 32, 28, []),
    ].map(v => machineNow({ ...v, label: v.key || 'Host' })),
    next: { task: 'WEB-7', title: 'Fix the header', weight: 'heavy', on: 'b' },
  }
  const b = w = await mountSuspended(ProjectMachines, { props: { project } })
  await vi.waitFor(() => expect(b.findAll('[data-testid="machine-takes"]')).toHaveLength(4))
  const takes = b.findAll('[data-testid="machine-takes"]').map(x => x.text())
  expect(takes).toEqual([
    'Takes nothing now: full: 2 agents (cap 2)',
    'Takes nothing now: paused for this project',
    'Takes heavy now',
    'Takes nothing now: offline',
  ])
  expect(b.findAll('[data-testid="machine-load"]').map(x => x.attributes('data-state'))).toEqual(['online', 'paused', 'online', 'offline'])
  expect(b.find('[data-testid="machine-agents"]').text()).toContain('WEB-1')
  expect(b.find('[data-testid="pm-next"]').text()).toContain('Next: WEB-7 (heavy) would go to b')
  live = { machines: [], next: { task: 'WEB-7', title: 'Fix the header', weight: 'heavy', hold: 'Waits for room', why: 'Keep the board busy is off' } }
  await b.setProps({ project: { ...project, paused: [] } })
  await vi.waitFor(() => expect(b.find('[data-testid="pm-next"]').text()).toContain('Next: WEB-7 (heavy) waits: Keep the board busy is off'))
})
