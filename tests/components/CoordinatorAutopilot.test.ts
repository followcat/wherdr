import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, setResponseStatus } from 'h3'
import CoordinatorAutopilot from '~/components/CoordinatorAutopilot.vue'
import type { CoordinatorView } from '#shared/pm/coordinator'
import type { Wake } from '#shared/pm/wakes'

const posts: Record<string, unknown>[] = []
registerEndpoint('/api/pm/coordinators', () => [])
let refuse = ''
// Registered when this file runs: another file's mock of the same URL (DecisionsView) is not used.
beforeAll(() => registerEndpoint('/api/pm/autopilot', { method: 'POST', handler: async (e) => {
  const body = await readBody(e)
  posts.push(body)
  if (refuse) { setResponseStatus(e, 400); return { code: 'bad_input', error: refuse } }
  return body.autopilot ? { autopilot: body.autopilot } : {}
} }))

const autopilot = { on: false, goal: 'Ship 2.1', every: '2h', events: ['done', 'stuck'], perDay: 10, atOnce: 2 } as const
const wake = (id: string, more: Partial<Wake>): Wake => ({ id, coordinator: 'CO', reasons: ['CO-1 (Fix it): done', 'CO-2 (Add it): stuck'], createdAt: Date.UTC(2026, 10, 5, 4, 0), tries: 1, ...more })
const view = (more: Partial<CoordinatorView> = {}): CoordinatorView => ({
  project: 'CO', name: 'Company', agent: { program: 'claude', model: 'opus' }, terminal: 'host/t1',
  autopilot: { ...autopilot, events: [...autopilot.events] }, limits: { started: 3, perDay: 10, startLeft: 1, working: 1, atOnce: 2 },
  wakes: [
    wake('aaaaaaa3', { }),
    wake('aaaaaaa2', { deliveredAt: 2, idleSince: 3 }),
    wake('aaaaaaa1', { deliveredAt: 2, ackedAt: 3, endedAt: 3, ended: 'ack' }),
    wake('aaaaaaa0', { deliveredAt: 2, tries: 2, endedAt: 3, ended: 'unanswered' }),
  ],
  ...more,
})
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
const mount = async (c = view()) => (w = await mountSuspended(CoordinatorAutopilot, { props: { c } }))
afterEach(() => { w?.unmount(); w = null; posts.length = 0; refuse = '' })

it('shows today\'s counters against the limits, and the switch saves the autopilot as it is', async () => {
  const b = await mount()
  expect(b.find('[data-testid="autopilot-counters"]').text()).toBe('3/10 today · 1/2 at once')
  expect(b.text()).toContain('Autopilot · Off')
  expect(b.find('[data-testid="autopilot-old-defaults"]').text()).toBe('Older defaults: clear the fields for unlimited and Auto')
  expect((b.find('textarea#ap-goal-CO').element as HTMLTextAreaElement).value).toBe('Ship 2.1')
  await b.find('[data-testid="autopilot-on"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', autopilot: { ...autopilot, on: true } }]))
})

it('saves the goal, interval, events and limits edited', async () => {
  const b = await mount()
  await b.find('textarea#ap-goal-CO').setValue('  Fix the board first ')
  await b.find('input#ap-every-CO').setValue('30m')
  await b.find('input#ap-at-CO').setValue(' daily 08:00 ')
  await b.find('input#ap-day-CO').setValue('4')
  await b.find('[data-testid="autopilot-event-ready"]').trigger('click')
  await b.find('[data-testid="autopilot-event-stuck"]').trigger('click')
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', autopilot: { ...autopilot, goal: '  Fix the board first ', every: '30m', at: 'daily 08:00', perDay: 4, events: ['done', 'ready'] } }]))
})

it('with Tasks / day empty, has no daily limit: counts today alone and saves no cap', async () => {
  const b = await mount(view({ limits: { started: 12, perDay: null, startLeft: 1, working: 1, atOnce: 2 } }))
  expect(b.find('[data-testid="autopilot-counters"]').text()).toBe('12 today · 1/2 at once')
  await b.find('input#ap-day-CO').setValue('')
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', autopilot: { ...autopilot, perDay: null, at: '', events: [...autopilot.events] } }]))
  b.unmount()
  expect((await mount(view({ autopilot: { ...autopilot, events: [], perDay: null, atOnce: null } }))).find('[data-testid="autopilot-old-defaults"]').exists()).toBe(false)
})

// Today at hh:mm (local), for the timeline.
const at = (h: number, m = 0, days = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime() }

it('shows the day: wakes sent and skipped with their reasons, the tasks started, the next wake and the pace', async () => {
  const b = await mount(view({
    autopilot: { ...autopilot, on: true, events: [...autopilot.events], hours: { from: 8, to: 20 } }, nextWake: at(23, 50),
    wakes: [
      wake('aaaaaaa2', { kind: 'health', reasons: ['CO-3 waits for you'], createdAt: at(0, 3), tries: 2, deliveredAt: 2, endedAt: 3, ended: 'unanswered' }),
      wake('aaaaaaa1', { reasons: ['Scheduled wake (every 2h). Your goal: Ship 2.1.'], createdAt: at(0, 2), deliveredAt: 2, ackedAt: 3, endedAt: 3, ended: 'ack' }),
    ],
    skips: [{ at: at(0, 1), what: 'autopilot', why: 'Scheduled wake: the worker\'s account is ahead of its pace' }, { at: at(22, 0, -1), what: 'autopilot', why: 'Scheduled wake: nothing to do' }],
    started: [{ task: 'CO-4', title: 'Add the export', at: at(0, 4) }],
    pace: { account: 'claude:ab12 Pro', used: 41, limit: 54, label: 'line' },
  }))
  expect(b.find('[data-testid="autopilot-next-wake"]').text()).toMatch(/^Next wake (23:50|11:50)/)
  const rows = b.findAll('[data-testid="autopilot-event"]').map(r => [r.attributes('data-kind'), r.find('.tl-what').text(), r.find('.tl-why').text(), r.find('.tl-state').exists() ? r.find('.tl-state').text() : ''])
  expect(rows).toEqual([
    ['started', 'Started', 'CO-4 Add the export', ''],
    ['sent', 'Health check', 'CO-3 waits for you', 'no answer'],
    ['sent', 'Scheduled', 'Scheduled wake (every 2h). Your goal: Ship 2.1.', 'handled'],
    ['skipped', 'Skipped', 'the worker\'s account is ahead of its pace', ''],
    ['skipped', 'Skipped', 'nothing to do', ''],
  ])
  expect(b.find('.tl-day').text()).toBe('Yesterday')
  expect(b.findAll('[data-testid="autopilot-event"]')[1]!.classes()).toContain('problem')
  expect(b.findAll('.tl-shade').map(s => s.attributes('style'))).toEqual(['left: 33.333333333333336%; width: 50%;'])
  expect(b.find('[data-testid="autopilot-pace"] .tl-pace-text').text()).toBe('week 41% / line 54% · go')
  await b.find('[data-testid="autopilot-run-now"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', runNow: true }]))
  await vi.waitFor(() => expect(b.text()).toContain('Queued: it goes as soon as the coordinator is idle.'))
})

it('saves the hours, and a pace that waits says what for', async () => {
  const b = await mount(view({ pace: { account: 'codex', used: null, limit: null, label: 'line', wait: 'ahead of the target line until Fri 00:00' } }))
  expect(b.find('[data-testid="autopilot-pace"] .tl-pace-text').text()).toBe('waits: ahead of the target line until Fri 00:00')
  await b.find('input#ap-from-CO').setValue('22')
  await b.find('input#ap-to-CO').setValue('6')
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', autopilot: { ...autopilot, at: '', events: [...autopilot.events], hours: { from: 22, to: 6 } } }]))
})

it('cannot run a coordinator that is not started', async () => {
  const b = await mount(view({ terminal: undefined, wakes: [] }))
  expect(b.find('[data-testid="autopilot-run-now"]').attributes('disabled')).toBeDefined()
  expect(b.text()).toContain('Start the coordinator to wake it.')
  expect(b.text()).toContain('Nothing yet today.')
})

it('shows Active, or Asleep with its last wake when there is nothing to do', async () => {
  const on = { ...autopilot, on: true, events: [...autopilot.events] }
  const woke = new Date(); woke.setHours(9, 5, 0, 0)
  let b = await mount(view({ autopilot: on }))
  expect(b.find('[data-testid="autopilot-state"]').text()).toBe('Autopilot · Active')
  b.unmount()
  b = await mount(view({ autopilot: on, asleep: 'idle', wokeAt: woke.getTime() }))
  const state = b.find('[data-testid="autopilot-state"]')
  expect(state.text()).toMatch(/^Autopilot · Asleep · nothing to do · woke 09:05/)
  expect(state.attributes('data-asleep')).toBeDefined()
  b.unmount()
  b = await mount(view({ autopilot: on, asleep: 'limit' }))
  expect(b.find('[data-testid="autopilot-state"]').text()).toBe('Autopilot · Asleep · new work limit reached until tomorrow')
  b.unmount()
  // Off: never asleep.
  b = await mount(view({ asleep: 'idle' }))
  expect(b.find('[data-testid="autopilot-state"]').text()).toBe('Autopilot · Off')
})

it('saves "look for new work" only when on, with its daily limit', async () => {
  const b = await mount()
  expect(b.find('[data-testid="autopilot-look-per-day"]').exists()).toBe(false)
  await b.find('[data-testid="autopilot-look-for-work"]').trigger('click')
  expect((b.find('input#ap-look-CO').element as HTMLInputElement).value).toBe('3')
  await b.find('input#ap-look-CO').setValue('5')
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', autopilot: { ...autopilot, at: '', lookForWork: true, lookPerDay: 5 } }]))
})

it('keeps unsaved edits across reloads, takes changes saved elsewhere, and shows the save state', async () => {
  const b = await mount()
  const goal = () => (b.find('textarea#ap-goal-CO').element as HTMLTextAreaElement).value
  const every = () => (b.find('input#ap-every-CO').element as HTMLInputElement).value
  await b.find('textarea#ap-goal-CO').setValue('Half typed')
  expect(b.find('[data-testid="autopilot-unsaved"]').exists()).toBe(true)
  // A reload: a new object, the same saved values.
  await b.setProps({ c: view() })
  expect(goal()).toBe('Half typed')
  // Saved elsewhere: the untouched field follows, the edited one stays.
  await b.setProps({ c: view({ autopilot: { ...autopilot, every: '4h', goal: 'Other', events: [...autopilot.events] } }) })
  expect([goal(), every()]).toEqual(['Half typed', '4h'])
  // A refusal shows under its field, and the edits stay.
  refuse = 'every: a duration like 30m or 2h'
  await b.find('input#ap-every-CO').setValue('soon')
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  await vi.waitFor(() => expect(b.find('[data-testid="autopilot-error-every"]').text()).toBe(refuse), { timeout: 5000 })
  expect(b.find('[data-testid="autopilot-unsaved"]').exists()).toBe(true)
  refuse = ''
  await b.find('input#ap-every-CO').setValue('1h')
  // Save is off while the refused save still loads.
  await vi.waitFor(() => expect(b.find('[data-testid="autopilot-save"]').attributes('disabled')).toBeUndefined(), { timeout: 5000 })
  await b.find('[data-testid="autopilot-save"]').trigger('submit')
  // A slow CI runner can take over a second to save.
  await vi.waitFor(() => expect(b.find('[data-testid="autopilot-saved"]').exists()).toBe(true), { timeout: 5000 })
  expect(b.find('[data-testid="autopilot-error-every"]').exists()).toBe(false)
})
