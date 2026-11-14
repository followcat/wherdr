import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanAutomation, firesOn, firingKind, firingTask, globMatch, scheduleWords, taskEvents, type Automation } from '../shared/pm/automations'
import type { Task } from '../shared/pm/run'
import type { Quotas } from '../shared/types'
import { createPmStore } from '../server/utils/pmStore'
import { issueToken, runCommand } from '../server/utils/pmCoordinator'
import { company } from '../shared/pm/examples'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

// The engine's start of a task, without herdr-core.
const started: string[] = []
vi.mock('../server/utils/pmLaunch', async orig => ({
  ...(await orig<object>()),
  startTask: async (deps: { store: ReturnType<typeof createPmStore> }, id: string) => {
    started.push(id)
    return deps.store.saveTask({ ...(await deps.store.task(id))!, state: 'working' })
  },
}))
// The quota readings the pace reads; none by default (quota unknown).
const quotas = vi.hoisted(() => ({ q: null as Quotas | null }))
vi.mock('../server/utils/quotas', async orig => ({ ...(await orig<object>()), readQuotas: async () => quotas.q ?? { claude: null, codex: null } }))
const { answerAutomationProposal, automationTick, fireAutomation } = await import('../server/utils/pmAutomations')

const at = (d: number, h = 0, mi = 0) => new Date(2026, 10, d, h, mi).getTime()
const task = (id: string, more: Partial<Task> = {}): Task => ({ id, project: 'CO', title: 'Fix', description: '', type: 'feature', state: 'working', createdAt: 0, ...more })
const auto = (more: Partial<Automation>): Automation => ({ id: 'a', name: 'A', prompt: 'Do it', on: true, ...more })

describe('automations', () => {
  it('checks the user\'s form; a switch-on or a new schedule counts from now', () => {
    const r = cleanAutomation({ name: 'v3: test cleanup', prompt: ' Clean ', schedule: 'daily 04:17', on: false, extra: 1 }, undefined, 5)
    expect(r).toEqual({ automation: { id: 'v3-test-cleanup', name: 'v3: test cleanup', prompt: 'Clean', on: false, schedule: 'daily 04:17', last: 5 } })
    const old = { ...(r as { automation: Automation }).automation, last: 5, firings: [{ at: 5, by: 'user' as const }] }
    expect(cleanAutomation({ ...old, on: true }, old, 9)).toMatchObject({ automation: { id: 'v3-test-cleanup', last: 9, firings: old.firings } })
    expect(cleanAutomation({ ...old, prompt: 'Other' }, old, 9)).toMatchObject({ automation: { last: 5 } })
    expect(cleanAutomation({ name: 'x', prompt: 'p' }, undefined, 0)).toEqual({ error: expect.stringMatching(/schedule or an event/) })
    expect(cleanAutomation({ name: 'x', prompt: 'p', schedule: 'daily 4', event: 'merged' }, undefined, 0)).toHaveProperty('error')
    expect(cleanAutomation({ name: 'x', prompt: 'p', schedule: 'sometimes' }, undefined, 0)).toEqual({ error: expect.stringMatching(/^schedule:/) })
    expect(cleanAutomation({ name: 'x', prompt: 'p', event: 'pushed' }, undefined, 0)).toHaveProperty('error')
  })

  it('sees each event once, from the second look, never "added" for its own tasks', () => {
    const before = [task('CO-1'), task('CO-2'), task('CO-3', { step: { at: 1, started: true, proofs: {}, rounds: {} } })]
    const first = taskEvents(before, undefined)
    expect(first.events).toEqual([])
    const after = [
      task('CO-1', { state: 'waiting', waiting: 'boom' }), // failed, needs you
      task('CO-2', { step: { at: 3, started: true, done: true, proofs: {}, rounds: {} }, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/7' }] }),
      task('CO-3', { step: { at: 2, started: true, proofs: {}, rounds: { review: 1 }, yourTurn: { reason: 'user', badge: 'Merge the PR' } } }),
      task('CO-4'), task('CO-5', { auto: 'a' }),
    ]
    const r = taskEvents(after, first.seen)
    expect(r.events.map(e => `${e.task.id} ${e.event}`)).toEqual(['CO-1 failed', 'CO-1 needs-you', 'CO-2 merged', 'CO-3 approval', 'CO-3 review-failed', 'CO-3 needs-you', 'CO-4 added'])
    expect(taskEvents(after, r.seen).events).toEqual([])
  })

  it('fires on its event, with the filter on title or branch, never on a task an automation added', () => {
    expect(globMatch('feature/*', 'Feature/login')).toBe(true)
    expect(globMatch('feature/*', 'a feature/login')).toBe(false)
    const ev = (t: Task) => ({ event: 'merged' as const, task: t })
    const a = auto({ event: 'merged', filter: 'docs*' })
    expect(firesOn(a, ev(task('CO-1', { title: 'Docs: install' })))).toBe(true)
    expect(firesOn(a, ev(task('CO-1', { title: 'Fix' })))).toBe(false)
    expect(firesOn(auto({ event: 'merged', filter: 'task/CO-1' }), ev(task('CO-1')))).toBe(true)
    expect(firesOn({ ...a, on: false }, ev(task('CO-1', { title: 'Docs' })))).toBe(false)
    expect(firesOn({ ...a, filter: undefined }, ev(task('CO-1', { auto: 'a' })))).toBe(false)
    expect(firesOn({ ...a, filter: undefined }, ev(task('CO-1', { auto: 'other' })))).toBe(false)
    expect(firesOn({ ...a, event: 'failed' }, ev(task('CO-1', { title: 'Docs' })))).toBe(false)
    // A task added then a start that failed is a failure; held for room, it waits.
    expect([{ error: 'boom', task: 'CO-1' }, { error: 'No room', task: 'CO-1', held: true as const }, { error: 'paced: limit' }, {}].map(f => firingKind({ at: 0, by: 'schedule', ...f })))
      .toEqual(['failed', 'waits', 'skipped', 'fired'])
    expect(firingTask(auto({ type: 'study' }), 'CO', 'feature', at(5, 4, 17), 'CO-1 (Fix): merged'))
      .toEqual({ project: 'CO', title: 'A · 2026-11-05 04:17', type: 'study', auto: 'a', origin: 'automation', addedBy: 'automation', description: 'Do it\n\nTriggered by CO-1 (Fix): merged.' })
  })
})

describe('the engine', () => {
  let dir = '', store: ReturnType<typeof createPmStore>
  const deps = () => ({ store }) as unknown as CoreAdminDeps & { store: typeof store }
  const save = (list: Automation[]) => store.changeAutomations('CO', f => ({ file: { ...f, automations: list }, out: 0 }))
  beforeEach(async () => {
    started.length = 0
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-auto-'))
    store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(company)
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Co', machine: '', path: '/r', template: 'company', addedAt: 1 }] }))
  })
  afterEach(() => { quotas.q = null; return fs.rm(dir, { recursive: true, force: true }) })

  it('a slot missed while down fires once on start, after a restart too', async () => {
    await save([auto({ id: 'clean', name: 'Clean', schedule: 'daily 04:17', last: at(1, 5) }), auto({ id: 'off', schedule: 'daily 04:17', on: false, last: at(1, 5) })])
    expect(await automationTick(deps(), at(2, 4))).toEqual([])
    store = createPmStore(dir) // wherdr starts again three days later
    expect(await automationTick(deps(), at(5, 10))).toEqual(['CO-1'])
    expect(await automationTick(deps(), at(5, 11))).toEqual([])
    expect(started).toEqual(['CO-1'])
    const t = (await store.task('CO-1'))!
    expect(t).toMatchObject({ title: 'Clean · 2026-11-05 10:00', type: 'feature', auto: 'clean', state: 'working', description: 'Do it\n\nTriggered by the schedule daily 04:17.' })
    const [a] = (await store.automations('CO')).automations
    expect(a).toMatchObject({ last: at(5, 10), firings: [{ at: at(5, 10), by: 'schedule', task: 'CO-1' }] })
  })

  it('a slot held by the pace is noted as fired, with why; run now is never held', async () => {
    const now = at(5, 10)
    // The account at its limit until tomorrow.
    quotas.q = { codex: null, claude: { at: now, five: null, week: null, limited: { resetsAt: at(6, 0) } }, accounts: [{ key: 'claude:ab12cd34', program: 'claude', machines: [''] }] }
    await save([auto({ id: 'clean', name: 'Clean', schedule: 'daily 04:17', last: at(4, 5) })])
    expect(await automationTick(deps(), now)).toEqual([expect.stringMatching(/^paced: the account hit its limit until /)])
    expect(await store.tasks()).toEqual([])
    expect((await store.automations('CO')).automations[0]).toMatchObject({ last: now, firings: [{ at: now, by: 'schedule', error: expect.stringMatching(/^paced:/) }] })
    // No catch-up nor retry in a loop.
    expect(await automationTick(deps(), at(5, 11))).toEqual([])
    expect(await fireAutomation(deps(), 'CO', 'clean', at(5, 12))).toMatchObject({ by: 'user', task: 'CO-1' })
    expect((await store.task('CO-1'))!.origin).toBe('automation')
  })

  it('fires on an event of another task; run now fires one that is off', async () => {
    await store.addTask({ project: 'CO', title: 'Old', type: 'feature' })
    await save([auto({ id: 'watch', event: 'added', filter: 'docs*' }), auto({ id: 'manual', schedule: 'daily 09:00', on: false, last: 0 })])
    expect(await automationTick(deps(), 1000)).toEqual([]) // first look: notes only
    await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.addTask({ project: 'CO', title: 'Docs: install', type: 'feature' })
    expect(await automationTick(deps(), 2000)).toEqual(['CO-4'])
    // Its own task is not an "added" event: no loop.
    expect(await automationTick(deps(), 3000)).toEqual([])
    expect((await store.task('CO-4'))!.description).toContain('Triggered by CO-3 (Docs: install): added.')
    expect(await fireAutomation(deps(), 'CO', 'manual', 4000)).toMatchObject({ by: 'user', task: 'CO-5' })
    expect((await store.automations('CO')).automations[1]).toMatchObject({ last: 0, firings: [{ task: 'CO-5' }] })
  })

  it('the coordinator reads them; adding or changing one is the user\'s', async () => {
    const token = await issueToken(store, 'CO')
    const cli = (argv: string[]) => runCommand(deps(), token, { argv })
    await save([auto({ id: 'clean', name: 'Clean', schedule: 'daily 04:17', on: false })])
    expect(await cli(['automation', 'list'])).toMatchObject({ automations: ['off  clean  daily 04:17  Clean'] })
    expect(await cli(['automation', 'show', 'clean'])).toMatchObject({ automation: { prompt: 'Do it' } })
    await expect(cli(['automation', 'show', 'nope'])).rejects.toThrow('Unknown automation')
    for (const verb of ['add', 'on', 'run', 'remove']) await expect(cli(['automation', verb, 'clean'])).rejects.toThrow(/Only the user switches/)
  })

  it('automation propose: refused in a wake; accepted, it applies; refused, nothing changes', async () => {
    const token = await issueToken(store, 'CO')
    const turn = async (kind: 'user' | 'wake') => store.saveCoordinator({ ...(await store.coordinator('CO'))!, turn: { kind, at: Date.now(), said: 'Clean the tests every weekday' } })
    const propose = (argv: string[], input?: object) => runCommand(deps(), token, { argv: ['automation', 'propose', ...argv], ...(input ? { input: JSON.stringify(input) } : {}) })
    const answer = async (accept: boolean) => answerAutomationProposal(deps(), 'CO', (await store.automations('CO')).proposals!.find(p => !p.outcome)!.id, accept)
    await save([auto({ id: 'clean', name: 'Clean', schedule: 'daily 04:17', on: false, firings: [{ at: 1, by: 'user', task: 'CO-1' }] })])
    await turn('wake')
    await expect(propose([], { name: 'Docs', prompt: 'Check', event: 'merged' })).rejects.toThrow(/only in a turn that comes from the user/)
    await turn('user')
    await expect(propose([], { name: 'Docs', prompt: 'Check', type: 'nope', event: 'merged' })).rejects.toThrow(/type: one of/)
    // New: accepted, it is added switched on.
    expect(await propose([], { name: 'Docs check', prompt: 'Check the docs', event: 'merged', filter: 'docs*', on: false })).toMatchObject({ proposed: { action: 'add', by: 'CO', said: 'Clean the tests every weekday' } })
    expect((await store.automations('CO')).automations).toHaveLength(1)
    await answer(true)
    expect((await store.automations('CO')).automations[1]).toMatchObject({ id: 'docs-check', on: true, event: 'merged', filter: 'docs*' })
    // A change: refused, nothing changes; accepted, it keeps its switch and firings.
    await propose(['clean'], { name: 'Clean', prompt: 'Remove dead tests', schedule: '0 9 * * 1-5' })
    await answer(false)
    expect((await store.automations('CO')).automations[0]).toMatchObject({ prompt: 'Do it', schedule: 'daily 04:17' })
    await propose(['clean'], { name: 'Clean', prompt: 'Remove dead tests', schedule: '0 9 * * 1-5' })
    await answer(true)
    expect((await store.automations('CO')).automations[0]).toMatchObject({ prompt: 'Remove dead tests', on: false, firings: [{ task: 'CO-1' }] })
    expect(Object.fromEntries(['0 9 * * 1-5', 'daily 09:00', 'mon,thu 09:00', '0 9,14 * * *', '0 9 1 * *', '*/15 * * * *', '0 */2 * * *', '30 9-17 * * 1-5', '5,20 * * * *', '0 0 * 1 *', '0 9 1 * 1', '0 9 1 * 0-6', '0 9 1 * */1', '*/15 * 1 * 1-5', 'every 2h']
      .map(x => [x, scheduleWords(x)]))).toEqual({
      '0 9 * * 1-5': 'every weekday at 9:00', 'daily 09:00': 'every day at 9:00', 'mon,thu 09:00': 'every Monday and Thursday at 9:00',
      '0 9,14 * * *': 'every day at 9:00 and 14:00', '0 9 1 * *': 'at 9:00 on day 1 of the month', '*/15 * * * *': 'every 15 minutes',
      '0 */2 * * *': 'every 2 hours at :00', '30 9-17 * * 1-5': 'every hour at :30 from 9:00 to 17:59 on weekdays', '5,20 * * * *': 'at minutes 5 and 20',
      '0 0 * 1 *': 'every day at 0:00 in January', '0 9 1 * 1': 'at 9:00 on day 1 of the month or on Monday', '0 9 1 * 0-6': 'every day at 9:00', '0 9 1 * */1': 'every day at 9:00', '*/15 * 1 * 1-5': 'every 15 minutes on day 1 of the month or on weekdays', 'every 2h': 'every 2 hours',
    })
    // A removal; the outcomes stay for automation list.
    await propose(['docs-check', '--remove'])
    await answer(true)
    expect((await store.automations('CO')).automations.map(a => a.id)).toEqual(['clean'])
    await expect(answer(true)).rejects.toThrow()
    expect((await runCommand(deps(), token, { argv: ['automation', 'list'] }) as { proposals: string[] }).proposals.map(l => l.split('  ').slice(0, 2).join(' ')))
      .toEqual(['accepted add docs-check', 'refused change clean', 'accepted change clean', 'accepted remove docs-check'])
  })
})
