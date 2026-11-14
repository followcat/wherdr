import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import NotificationRules from '~/components/NotificationRules.vue'
import SettingsView from '~/components/SettingsView.vue'
import { desk, herdrState } from '~/composables/useHerdr'
import { notificationClock, notificationRules } from '~/composables/useNotificationRules'
import { LEVEL_EVENTS, defaultNotifications, type NotificationException, type NotificationSettings } from '#shared/notificationRules'
import type { Pane } from '#shared/types'
import { pick, selectValue } from '../helpers/select'

const pane = (id: string, p: Partial<Pane> = {}): Pane => ({ id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null, ...p })
const MAIN = 'default/top/'
const agent = (id: string, label: string, opts: Partial<NotificationException> = {}): NotificationException =>
  ({ kind: 'conversation', machine: '', id, label, events: [...LEVEL_EVENTS.finished], subagents: false, until: null, ...opts })
const exception = (id: string, opts: Partial<NotificationException> = {}): NotificationException =>
  ({ kind: 'coordinator', machine: '', id, label: 'Example', events: [...LEVEL_EVENTS.finished], subagents: false, until: null, ...opts })
const policy = (events: NotificationSettings['default']['events'], ...exceptions: NotificationException[]): NotificationSettings =>
  ({ version: 2, default: { events, subagents: false }, exceptions })

async function mount(settings: NotificationSettings) {
  notificationRules.value = settings
  notificationClock.value = Date.now()
  herdrState.value = { ok: true, workspaces: [], panes: [
    pane('w1:p1', { title: 'First agent' }), pane('w3:p1', { title: 'Standalone agent' }), pane('w4:p1', { agent: null, title: 'A shell' }),
  ] }
  const w = await mountSuspended(NotificationRules)
  await flushPromises()
  return w
}
afterEach(() => {
  notificationRules.value = defaultNotifications()
  herdrState.value = { ok: false, workspaces: [], panes: [] }
})

describe('notification settings: a default and exceptions', () => {
  it('sets the default level, with no Sub-agents switch', async () => {
    const w = await mount(policy([]))
    const level = w.find('[data-testid="notification-default"]')
    expect(selectValue(level, 'notification-level')).toBe('muted')
    await pick(level, 'notification-level', 'all')
    expect(notificationRules.value.default.events).toEqual(LEVEL_EVENTS.all)
    expect(w.find('[data-testid="notification-default"] [role="switch"]').exists()).toBe(false)
    w.unmount()
  })

  it('adds an exception for an agent conversation, never a shell', async () => {
    const w = await mount(policy([]))
    await w.find('.notification-add').trigger('click')
    const picker = w.find('[data-testid="notification-picker"]')
    expect(picker.text()).toContain('First agent')
    expect(picker.text()).toContain('Standalone agent')
    expect(picker.text()).not.toContain('A shell')
    await picker.findAll('button').find(b => b.text() === 'Standalone agent')!.trigger('click')
    // Default Muted: the new exception starts at "Needs you + finished".
    expect(notificationRules.value.exceptions).toEqual([expect.objectContaining({ kind: 'conversation', id: 'w3:p1', events: LEVEL_EVENTS.finished })])
    const card = w.find('[data-testid="notification-exception"]')
    expect(card.text()).toContain('Louder than the default (Muted)')
    w.unmount()
  })

  it('shows a quieter exception, removes it back to the default, and removes all', async () => {
    const w = await mount(policy(LEVEL_EVENTS.all, exception('default/project/shop', { events: [] })))
    const card = w.find('[data-testid="notification-exception"]')
    expect(card.text()).toContain('Quieter than the default (All activity)')
    expect(card.text()).toContain('Back to the default: All activity')
    await card.find('.settings-action').trigger('click')
    expect(notificationRules.value.exceptions).toEqual([])
    notificationRules.value = policy([], exception(MAIN), exception('default/project/shop'))
    await flushPromises()
    await w.find('.notification-reset').trigger('click')
    expect(notificationRules.value.exceptions).toEqual([])
    w.unmount()
  })

  it('after a timed mute ends, the agent can be added again and the old record goes', async () => {
    const w = await mount(policy([], agent('w3:p1', 'Standalone agent', { events: null, until: Date.now() - 1000 })))
    expect(w.findAll('[data-testid="notification-exception"]')).toHaveLength(0)
    await w.find('.notification-add').trigger('click')
    const again = w.find('[data-testid="notification-picker"]').findAll('button').find(b => b.text() === 'Standalone agent')
    expect(again).toBeTruthy()
    await again!.trigger('click')
    expect(notificationRules.value.exceptions).toEqual([expect.objectContaining({ id: 'w3:p1', events: LEVEL_EVENTS.finished, until: null })])
    w.unmount()
  })

  it('sorts exceptions by machine then name, not muted first', async () => {
    const w = await mount(policy([], exception('default/project/shop', { events: [] }), { ...exception('w3:p1'), kind: 'conversation', label: 'Standalone agent' }, exception(MAIN)))
    const names = w.findAll('[data-testid="notification-exception"] .notification-rule-head b').map(b => b.text())
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(names).toHaveLength(3)
    w.unmount()
  })

  it('shows an older main coordinator exception as Alfred’s, and a removed machine as Unknown machine', async () => {
    const w = await mount(policy([], exception(MAIN, { machine: '0a1b2c3d', label: 'Main coordinator' }), agent('0a1b2c3d/w3:p9', 'Gone agent', { machine: '0a1b2c3d' })))
    const heads = w.findAll('[data-testid="notification-exception"] .notification-rule-head').map(h => h.text())
    expect(heads[0]).toMatch(/^Coordinator\s*Alfred/)
    expect(heads[1]).toMatch(/^Unknown machine · Conversation\s*Gone agent/)
    expect(notificationRules.value.exceptions).toContainEqual(expect.objectContaining({ kind: 'coordinator', machine: '', id: '/top/', label: 'Alfred' }))
    w.unmount()
  })

  it('an exception has its own level and Customize', async () => {
    const w = await mount(policy([], exception(MAIN)))
    const card = w.find('[data-testid="notification-exception"]')
    await pick(card, 'notification-level', 'needs-you')
    expect(notificationRules.value.exceptions[0]!.events).toEqual(['needs-you'])
    const message = card.findAll('input[type="checkbox"]').find(i => i.element.parentElement!.textContent!.includes('New message'))!
    await message.setValue(true)
    expect(notificationRules.value.exceptions[0]!.events).toEqual(['needs-you', 'message'])
    expect(selectValue(card, 'notification-level')).toBe('custom')
    w.unmount()
  })
})

it('orders the Notifications section: Do not disturb, default, exceptions, this device', async () => {
  // Computer layout: on a phone, Settings re-routes after mounting (history), past the test's end.
  const wasDesk = desk.value
  desk.value = true
  const w = await mountSuspended(SettingsView, { route: '/settings?section=notifications', global: { stubs: { UTooltip: { template: '<span><slot /></span>' } } } })
  const html = w.html()
  const at = (id: string) => html.indexOf(`data-testid="${id}"`)
  expect(at('notification-quiet')).toBeGreaterThan(-1)
  expect(at('notification-quiet')).toBeLessThan(at('notification-default'))
  expect(at('notification-default')).toBeLessThan(at('notification-exceptions'))
  expect(at('notification-exceptions')).toBeLessThan(at('push-card'))
  expect(w.find('[data-testid="notification-quiet"]').text()).toContain('Turns off every notification, no exceptions')
  expect(w.find('[data-testid="push-card"]').text()).toContain('What notifies is set above')
  w.unmount()
  desk.value = wasDesk
})
