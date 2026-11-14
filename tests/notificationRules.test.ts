import { describe, expect, it } from 'vitest'
import { LEVEL_EVENTS, NOTIFICATION_EVENTS, NotificationPresence, compareEvents, coordinatorKey, coordinatorTarget, defaultNotifications, levelOf,
  migrateCoordinatorExceptions, notificationEvents, paneNotificationSource, parseNotificationSettings, tidyNotificationExceptions,
  type NotificationException, type NotificationSettings, type NotificationSource } from '../shared/notificationRules'
import type { MachineLinks } from '../shared/boardLinks'

const MAIN = coordinatorKey({ session: 'default', level: 'top' })
const SHOP = coordinatorKey({ session: 'default', level: 'project', repo: 'shop' })
const main: NotificationSource = { machine: '', conversation: 'w1:p1', coordinator: MAIN }
const shopCoordinator: NotificationSource = { machine: '', project: 'shop', conversation: 'w1:p2', coordinator: SHOP }
const agent: NotificationSource = { machine: '', project: 'example', conversation: 'w3:p1' }
const worker: NotificationSource = { machine: '', project: 'shop', conversation: 'w2:p1', subagent: true }
const exception = (id: string, opts: Partial<NotificationException> = {}): NotificationException => ({
  kind: id.includes(':') ? 'conversation' : 'coordinator', machine: '', id, label: 'Example', events: [...LEVEL_EVENTS.finished], subagents: false, until: null, ...opts,
})
const settings = (events: readonly string[], ...exceptions: NotificationException[]): NotificationSettings =>
  ({ version: 2, default: { events: [...events] as NotificationSettings['default']['events'], subagents: false }, exceptions })

describe('one scale of levels', () => {
  it('orders muted, needs you, needs you + finished, all activity', () => {
    expect(levelOf([])).toBe('muted')
    expect(levelOf(['needs-you'])).toBe('needs-you')
    expect(levelOf(['finished', 'needs-you'])).toBe('finished')
    expect(levelOf([...NOTIFICATION_EVENTS])).toBe('all')
    expect(levelOf(['message'])).toBe('custom')
  })
  it('says whether an exception is louder or quieter than the default', () => {
    expect(compareEvents(LEVEL_EVENTS.finished, [])).toBe(1)
    expect(compareEvents([], LEVEL_EVENTS.all)).toBe(-1)
    expect(compareEvents(['finished', 'needs-you'], LEVEL_EVENTS.finished)).toBe(0)
    expect(compareEvents(['message'], ['needs-you'])).toBeNull()
  })
})

describe('a default and exceptions', () => {
  it('applies the default to everything; fresh settings are needs you + finished, sub-agents off', () => {
    const s = defaultNotifications()
    for (const source of [main, shopCoordinator, agent]) expect(notificationEvents(s, source)).toEqual(LEVEL_EVENTS.finished)
    expect(notificationEvents(s, worker)).toEqual([])
    expect(notificationEvents(s, { machine: '' })).toEqual(LEVEL_EVENTS.finished)
  })
  it('default muted + main coordinator → needs you + finished', () => {
    const s = settings([], exception(MAIN))
    expect(notificationEvents(s, main)).toEqual(LEVEL_EVENTS.finished)
    expect(notificationEvents(s, shopCoordinator)).toEqual([])
    expect(notificationEvents(s, agent)).toEqual([])
    expect(notificationEvents(s, worker)).toEqual([])
  })
  it('default all activity + coordinator X → muted', () => {
    const s = settings(LEVEL_EVENTS.all, exception(SHOP, { events: [] }))
    expect(notificationEvents(s, shopCoordinator)).toEqual([])
    expect(notificationEvents(s, main)).toEqual(LEVEL_EVENTS.all)
    expect(notificationEvents(s, agent)).toEqual(LEVEL_EVENTS.all)
  })
  it('keys a coordinator exception on its identity, not its pane: a recreated coordinator keeps it', () => {
    const s = settings([], exception(MAIN))
    expect(notificationEvents(s, { ...main, conversation: 'w9:p7' })).toEqual(LEVEL_EVENTS.finished)
    // One coordinator of each across machines: its exception follows it.
    expect(notificationEvents(s, { ...main, machine: 'abcd' })).toEqual(LEVEL_EVENTS.finished)
  })
  it('a standalone agent exception follows its conversation', () => {
    const s = settings([], exception('w3:p1', { events: ['message'] }))
    expect(notificationEvents(s, agent)).toEqual(['message'])
    expect(notificationEvents(s, { ...agent, conversation: 'w3:p2' })).toEqual([])
  })
  it.each(NOTIFICATION_EVENTS)('customizes %s independently', event => {
    expect(notificationEvents(settings([], exception(MAIN, { events: [event] })), main)).toEqual([event])
  })
})

describe('the Sub-agents switch', () => {
  it('off: task agents are silent; on: they notify at the default level', () => {
    const s = settings(LEVEL_EVENTS.all)
    expect(notificationEvents(s, worker)).toEqual([])
    s.default.subagents = true
    expect(notificationEvents(s, worker)).toEqual(LEVEL_EVENTS.all)
  })
  it('board events notify even with sub-agents off', () => {
    expect(notificationEvents(settings(LEVEL_EVENTS.finished), { ...worker, board: true })).toEqual(LEVEL_EVENTS.finished)
  })
  it('an exception with sub-agents on takes its board’s task agents along; off leaves them on the default', () => {
    const s = settings([], exception(SHOP, { events: LEVEL_EVENTS.all, subagents: true }))
    expect(notificationEvents(s, worker)).toEqual(LEVEL_EVENTS.all)
    expect(notificationEvents(s, { ...worker, project: 'other' })).toEqual([])
    s.exceptions[0]!.subagents = false
    expect(notificationEvents(s, worker)).toEqual([])
  })
  it('the main coordinator’s sub-agents switch covers every project without its own exception', () => {
    const s = settings(LEVEL_EVENTS.all, exception(MAIN, { events: [], subagents: true }), exception(SHOP, { events: ['needs-you'], subagents: true }))
    s.default.subagents = true
    expect(notificationEvents(s, worker)).toEqual(['needs-you'])
    expect(notificationEvents(s, { ...worker, project: 'other' })).toEqual([])
  })
  it('a board event follows its project coordinator’s exception', () => {
    const s = settings(LEVEL_EVENTS.all, exception(SHOP, { events: [] }))
    expect(notificationEvents(s, { machine: '', project: 'shop', board: true, session: 'default' })).toEqual([])
    expect(notificationEvents(s, { machine: '', project: 'shop', board: true, session: 'other' })).toEqual(LEVEL_EVENTS.all)
    expect(notificationEvents(s, { machine: '', project: 'other', board: true, session: 'default' })).toEqual(LEVEL_EVENTS.all)
    // No pane or space linked: its session is unknown, so the default decides.
    expect(notificationEvents(s, { machine: '', project: 'shop', board: true })).toEqual(LEVEL_EVENTS.all)
  })
})

describe('review cases', () => {
  it('a project exception with sub-agents off sends its tasks to the default, not to the main coordinator’s exception', () => {
    const s = settings([], exception(MAIN, { events: LEVEL_EVENTS.all, subagents: true }), exception(SHOP, { events: ['needs-you'], subagents: false }))
    expect(notificationEvents(s, worker)).toEqual([])
    expect(notificationEvents(s, { ...worker, project: 'other' })).toEqual(LEVEL_EVENTS.all)
  })
  it('a project coordinator’s exception does not reach the tasks of another Herdr session', () => {
    const s = settings([], exception(SHOP, { events: LEVEL_EVENTS.all, subagents: true }))
    const boards: MachineLinks[] = [{ machine: '', coordinators: [
      { level: 'project', repo: 'shop', session: 'default', pane: 'w1:p2', workspace: 'w1' },
      { level: 'project', repo: 'shop', session: 'other', pane: 'abcd~w1:p2', workspace: 'abcd~w1' },
    ], tasks: [
      { id: 'shop/1', repo: 'shop', n: 1, key: 'SHOP-1', title: 'A', panes: [{ id: 'w2:p1', role: 'worker' }], workspace: 'w2', stage: 'working', progress: null, msg: '', since: null },
      { id: 'shop/2', repo: 'shop', n: 2, key: 'SHOP-2', title: 'B', panes: [{ id: 'abcd~w2:p1', role: 'worker' }], workspace: 'abcd~w2', stage: 'working', progress: null, msg: '', since: null },
    ] }]
    const other = paneNotificationSource({ id: 'abcd~w2:p1', workspace: 'abcd~w2' }, { workspaces: [] }, boards, '')
    expect(other).toMatchObject({ subagent: true, session: 'other' })
    expect(notificationEvents(s, other)).toEqual([])
    const mine = paneNotificationSource({ id: 'w2:p1', workspace: 'w2' }, { workspaces: [] }, boards, '')
    expect(notificationEvents(s, mine)).toEqual(LEVEL_EVENTS.all)
  })
  it('a migrated rule on a task agent never bypasses the Sub-agents switch, and is dropped once the board names it', () => {
    const s = parseNotificationSettings(JSON.stringify({ defaults: [], muteSubagents: true, rules: [
      { scope: 'conversation', mode: 'on', machine: '', id: 'w2:p1', label: 'Worker', events: ['message'], until: null },
    ] }))
    expect(notificationEvents(s, worker)).toEqual([])
    const boards: MachineLinks[] = [{ machine: '', coordinators: [], tasks: [
      { id: 'shop/1', repo: 'shop', n: 1, key: 'SHOP-1', title: 'A', panes: [{ id: 'w2:p1', role: 'worker' }], workspace: 'w2', stage: 'working', progress: null, msg: '', since: null },
    ] }]
    expect(tidyNotificationExceptions(s, boards)!.exceptions).toEqual([])
  })
  it('drops an ended timed mute that left nothing behind', () => {
    const s = settings([], exception(MAIN, { events: null, until: 1000 }), exception('w3:p1'))
    expect(tidyNotificationExceptions(s, [], 2000)!.exceptions.map(e => e.id)).toEqual(['w3:p1'])
    expect(tidyNotificationExceptions(s, [], 500)).toBeNull()
  })
})

describe('timed mutes', () => {
  it('mutes until then, and then the exception’s own level', () => {
    const s = settings([], exception(MAIN, { until: 5000 }))
    expect(notificationEvents(s, main, 4999)).toEqual([])
    expect(notificationEvents(s, main, 5000)).toEqual(LEVEL_EVENTS.finished)
  })
  it('a mute with no exception before it goes back to the default', () => {
    const s = settings(LEVEL_EVENTS.all, exception(MAIN, { events: null, until: 5000 }))
    expect(notificationEvents(s, main, 4999)).toEqual([])
    expect(notificationEvents(s, main, 5000)).toEqual(LEVEL_EVENTS.all)
  })
  it('a timed mute of a coordinator with sub-agents on silences its tasks too, for that time', () => {
    const s = settings(LEVEL_EVENTS.all, exception(SHOP, { events: null, subagents: true, until: 5000 }))
    s.default.subagents = true
    expect(notificationEvents(s, worker, 4999)).toEqual([])
    expect(notificationEvents(s, worker, 5000)).toEqual(LEVEL_EVENTS.all)
  })
})

describe('saved settings', () => {
  it('rejects malformed settings and sanitizes unknown events and duplicate targets', () => {
    expect(parseNotificationSettings('{')).toEqual(defaultNotifications())
    const s = parseNotificationSettings(JSON.stringify({ version: 2, default: { events: ['message', 'other'], subagents: true }, exceptions: [
      exception(MAIN), exception(MAIN, { events: [] }), { ...exception(SHOP), until: -1 }, { kind: 'machine', machine: '', id: 'x', label: '' },
    ] }))
    expect(s.default).toEqual({ events: ['message'], subagents: true })
    expect(s.exceptions).toEqual([exception(MAIN, { events: [] })])
  })
  it('round-trips', () => {
    const s = settings(LEVEL_EVENTS.all, exception(MAIN, { events: null, until: 9e12, subagents: true }), exception('w3:p1'))
    expect(parseNotificationSettings(JSON.stringify(s))).toEqual(s)
  })
})

describe('migration of #156 rules', () => {
  const old = (rules: object[], extra: object = {}) => parseNotificationSettings(JSON.stringify({ defaults: [], muteSubagents: true, rules, ...extra }))
  const rule = (scope: string, mode: string, opts: object = {}) => ({ scope, mode, machine: '', id: scope === 'conversation' ? 'w1:p1' : scope === 'project' ? 'shop' : '', label: 'Main coordinator', events: [...NOTIFICATION_EVENTS], until: null, ...opts })
  it('“Only main coordinators” (machine muted + main on) becomes default muted + one exception', () => {
    const s = old([rule('machine', 'muted'), rule('conversation', 'on', { events: ['needs-you', 'finished'] })])
    expect(s.default).toEqual({ events: [], subagents: false })
    expect(s.exceptions).toEqual([{ kind: 'conversation', machine: '', id: 'w1:p1', label: 'Main coordinator', events: ['needs-you', 'finished'], subagents: false, until: null }])
  })
  it('without rules, keeps what coordinators did (needs you + finished), or the chosen default', () => {
    expect(old([]).default.events).toEqual(LEVEL_EVENTS.finished)
    expect(old([], { defaults: [...NOTIFICATION_EVENTS], muteSubagents: false }).default).toEqual({ events: LEVEL_EVENTS.all, subagents: true })
  })
  it('drops project rules and timed machine rules, keeps timed and permanent conversation mutes', () => {
    const s = old([rule('project', 'muted'), rule('machine', 'on', { until: 9e12 }), rule('conversation', 'muted', { until: 9e12 }), rule('conversation', 'muted', { id: 'w3:p1' })])
    expect(s.default.events).toEqual(LEVEL_EVENTS.finished)
    expect(s.exceptions).toEqual([
      expect.objectContaining({ id: 'w1:p1', events: null, until: 9e12 }),
      expect.objectContaining({ id: 'w3:p1', events: [], until: null }),
    ])
  })
  it('moves a migrated coordinator’s pane exception to its stable identity', () => {
    const s = old([rule('conversation', 'on', { events: ['needs-you'] }), rule('conversation', 'muted', { id: 'w3:p1' })])
    const boards: MachineLinks[] = [{ machine: '', tasks: [], coordinators: [{ level: 'top', session: 'default', pane: 'w1:p1', workspace: 'w1' }] }]
    const next = tidyNotificationExceptions(s, boards)!
    expect(next.exceptions).toEqual([
      expect.objectContaining({ kind: 'coordinator', id: MAIN, events: ['needs-you'] }),
      expect.objectContaining({ kind: 'conversation', id: 'w3:p1' }),
    ])
    expect(tidyNotificationExceptions(next, boards)).toBeNull()
    // The same intent as before the move, and after a restart on a new pane.
    expect(notificationEvents(next, main)).toEqual(['needs-you'])
    expect(notificationEvents(next, { ...main, conversation: 'w8:p1' })).toEqual(['needs-you'])
  })
})

describe('coordinator exceptions of the older model', () => {
  const name = (p: string) => p === '_main' ? 'Alfred' : `${p} coordinator`
  const old = (id: string, opts: Partial<NotificationException> = {}) => exception(id, { machine: '0a1b2c3d', label: 'Main coordinator', ...opts })
  it('move to Alfred or a project coordinator by key, with its current name, merged; the rest go', () => {
    const s = settings([], old('default/top/', { events: [] }), old('other/top/'), old('default/machine/'),
      old('default/project/SHOP', { events: ['needs-you'] }), old('default/project/GONE'), exception('w1:p1'))
    const next = migrateCoordinatorExceptions(s, ['SHOP'], name)!
    expect(next.exceptions).toEqual([
      exception(coordinatorTarget('_main'), { label: 'Alfred' }),
      exception(coordinatorTarget('SHOP'), { label: 'SHOP coordinator', events: ['needs-you'] }),
      exception('w1:p1'),
    ])
    expect(migrateCoordinatorExceptions(next, ['SHOP'], name)).toBeNull()
    // They now apply to today's coordinator panes, wherever they run.
    expect(notificationEvents(next, { machine: 'm2', conversation: 'w5:p1', coordinator: coordinatorTarget('_main') })).toEqual(LEVEL_EVENTS.finished)
    expect(notificationEvents(next, { machine: '', conversation: 'w6:p1', coordinator: coordinatorTarget('SHOP') })).toEqual(['needs-you'])
  })
  it('keep project ones while the projects are unknown, and drop a deleted project’s', () => {
    const s = settings([], old('default/project/SHOP'))
    expect(migrateCoordinatorExceptions(s, null, name)).toBeNull()
    const current = settings([], exception(coordinatorTarget('SHOP')))
    expect(migrateCoordinatorExceptions(current, ['SHOP'], name)).toBeNull()
    expect(migrateCoordinatorExceptions(current, [], name)!.exceptions).toEqual([])
  })
})

describe('visible conversation leases', () => {
  it('suppresses every device while any recent viewing lease exists', () => {
    const p = new NotificationPresence()
    p.heartbeat('desktop', 'w1:p1', true, 1000)
    p.heartbeat('phone', 'w1:p1', true, 15000)
    expect(p.viewed('w1:p1', 30999)).toBe(true)
    expect(p.viewed('w1:p1', 44999)).toBe(true)
    expect(p.viewed('w1:p1', 45000)).toBe(false)
  })
  it('does not renew a hidden tab, with a grace period after leaving', () => {
    const p = new NotificationPresence()
    p.heartbeat('desktop', 'w1:p1', true, 1000)
    p.heartbeat('desktop', 'w1:p1', false, 15000)
    expect(p.viewed('w1:p1', 30999)).toBe(true)
    p.heartbeat('desktop', 'w1:p1', false, 31000)
    expect(p.viewed('w1:p1', 31000)).toBe(false)
  })
  it('expires a crashed client without a disconnect or hide message', () => {
    const p = new NotificationPresence()
    p.heartbeat('desktop', 'w1:p1', true, 0)
    expect(p.viewed('w1:p2', 1)).toBe(false)
    expect(p.viewed('w1:p1', 30000)).toBe(false)
  })
  it('moves a viewing lease to the newly opened conversation', () => {
    const p = new NotificationPresence()
    p.heartbeat('desktop', 'w1:p1', true, 0)
    p.heartbeat('desktop', 'w1:p2', true, 1000)
    expect(p.viewed('w1:p1', 1000)).toBe(false)
    expect(p.viewed('w1:p2', 1000)).toBe(true)
  })
})

describe('board identities', () => {
  const boards: MachineLinks[] = [{ machine: '', coordinators: [
    { level: 'top', session: 'default', pane: 'w1:p1', workspace: 'w1' },
    { level: 'project', session: 'default', repo: 'example', pane: 'w1:p2', workspace: 'w1' },
    { level: 'machine', session: 'default', pane: 'w1:p3', workspace: 'w1' },
  ], tasks: [{ id: 'example/1', repo: 'example', n: 1, key: 'APP-1', title: 'Example',
    panes: [{ id: 'w2:p1', role: 'worker' }, { id: 'w2:p2', role: 'reviewer' }, { id: 'w2:p3', role: 'attempt' }],
    workspace: 'w2', stage: 'working', progress: null, msg: '', since: null,
  }] }]
  it.each([['w1:p1', 'default/top/'], ['w1:p2', 'default/project/example'], ['w1:p3', 'default/machine/']])('recognizes coordinator %s as %s, by board metadata', (id, key) => {
    expect(paneNotificationSource({ id, workspace: 'w1' }, { workspaces: [] }, boards).coordinator).toBe(key)
  })
  it.each(['w2:p1', 'w2:p2', 'w2:p3', 'w2:p4'])('mutes worker, reviewer, attempt and helper %s', id => {
    expect(paneNotificationSource({ id, workspace: 'w2' }, { workspaces: [] }, boards)).toMatchObject({ subagent: true, project: 'example' })
  })
  it('uses the base machine for an ordinary conversation in another session', () => {
    expect(paneNotificationSource({ id: 'abcd~w3:p1', workspace: 'abcd~w3' }, { workspaces: [] }, [], '')).toEqual({ machine: '', project: undefined, conversation: 'abcd~w3:p1' })
  })
})
