// The engine end to end: four tasks of one project started together, run by
// the real ticks (advance, mechanic, merge queue, sentinel) over real git
// repos, a fake GitHub and fake agents, on a fake clock (one tick a minute).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { mechanicTick } from '../server/utils/pmMechanic'
import { ACTION_LIMIT_MS, actionRunning, actionsSettled, userStep } from '../server/utils/pmBoard'
import { SENTINEL_MS, statedReason } from '../shared/pm/sentinel'
import { taskPlan } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'
import { makeWorld, type Work } from './helpers/simWorld'

const steps = (merge: Template['taskTypes'][string]['steps'][number]) => [{ id: 'todo', column: 'To do' },
  { id: 'work', column: 'Working', holder: 'worker' as const, ends: 'report' as const },
  { id: 'pr', column: 'Working', holder: 'none' as const, ends: 'action' as const, action: { kind: 'github.pr' as const, base: 'main' } },
  merge, { id: 'done', column: 'Done' }]
const flow: Template = {
  id: 'flow', prefs: { agent: 'claude', model: 'sonnet' },
  taskTypes: {
    engine: { steps: steps({ id: 'merge', column: 'Working', holder: 'none', ends: 'action', action: { kind: 'github.merge' } }) },
    approve: { steps: steps({ id: 'merge', column: 'Working', holder: 'none', ends: 'user', userLabel: 'Merge', action: { kind: 'github.merge' } }) },
  },
}

// WH-1 also changes docs/llms.txt, its merge hangs once; WH-2 waits for the
// user's approval, its PR unreadable once; WH-3 changes WH-2's file, so it
// waits for it and conflicts once WH-2 merged; WH-4's CI is red until its worker fixes it.
const tasks: { title: string, type: string, files: string[], work: Work }[] = [
  { title: 'Index entry', type: 'engine', files: ['src/a.txt', 'docs/llms.txt'], work: { 'src/a.txt': 'a', 'docs/llms.txt': '- [A](docs/a.md): a.' } },
  { title: 'Shared, approved', type: 'approve', files: ['src/shared.txt'], work: { 'src/shared.txt': 'from WH-2' } },
  { title: 'Shared, engine', type: 'engine', files: ['src/shared.txt'], work: { 'src/shared.txt': 'from WH-3' } },
  { title: 'Red CI', type: 'engine', files: ['src/d.txt', 'docs/llms.txt'], work: { 'src/d.txt': 'BROKEN' } },
]
const TICK = 60_000, BUDGET = 90 // ticks

describe('engine simulation', () => {
  let world: Awaited<ReturnType<typeof makeWorld>> | undefined
  afterEach(async () => {
    await world?.gh.close()
    await actionsSettled() // the hung merge, failed once its call is cut
    vi.useRealTimers()
    await world?.close()
  })

  it('takes four tasks of one project from to-do to done, never leaving one without an owner or a reason', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.now()
    let unread = false, hung = false
    world = await makeWorld({
      // WH-2's PR, read by the mechanic (no action running): unreadable once.
      failRead: b => (b === 'task/WH-2' && !actionRunning('WH-2') && !unread && world!.gh.prs.some(p => p.head === b) ? (unread = true, 'gh: HTTP 502 Bad Gateway') : undefined),
      hang: b => b === 'task/WH-1' && !hung && (hung = true),
    })
    const store = createPmStore(`${world.home}/pm`)
    await store.setEnabled(true)
    await store.saveTemplate(flow)
    await store.addProject({ key: 'WH', machine: '', path: world.repo, base: 'main', template: 'flow' }, async (_m, p) => p)
    const deps = { call: world.call, store, machines: () => [{ key: '', label: 'local', local: true, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    const work: Record<string, Work> = {}
    for (const t of tasks) work[(await store.addTask({ project: 'WH', ...t })).id] = t.work
    const ids = Object.keys(work)
    for (const id of ids) await startTask(deps, id)
    expect((await store.task('WH-3'))!.sameFiles).toBe('WH-2')
    expect((await store.task('WH-4'))!.sameFiles).toBeUndefined() // docs/llms.txt is merged alone

    const wf = (await store.workflow('WH'))!, p = (await store.projects())[0]!
    const unowned = new Map<string, number>(), worst: Record<string, number> = {}, silent: Record<string, number> = {}
    let ticks = 0, after = 3, cut = false // after: ticks once all are done
    const doneAt = new Set<string>(), undone: string[] = []
    for (; ticks < BUDGET; ticks++) {
      vi.setSystemTime(now += TICK)
      await world.runAgents(store, work)
      // The user approves WH-2's merge once it asks.
      const two = (await store.task('WH-2'))!
      if (two.step?.yourTurn?.reason === 'user' && !two.step.approved) await userStep(deps, 'WH-2')
      await mechanicTick(deps, now)
      // The step actions this tick started end before the next one, but the hung merge.
      for (let i = 0; i < 500 && ids.some(id => actionRunning(id) && !(id === 'WH-1' && hung && !world!.gh.merged.includes('task/WH-1'))); i++) await new Promise(r => setTimeout(r, 10))
      // All done: the hung merge's call fails at last; its late result must not undo WH-1's merge.
      if (doneAt.size === ids.length && !cut) { cut = true; world.gh.cut(); await actionsSettled() }
      const all = await Promise.all(ids.map(id => store.task(id)))
      for (const t of all) {
        if (doneAt.has(t!.id) && !t!.step?.done) undone.push(`${t!.id} at ${t!.step?.at}: ${t!.log!.at(-1)!.text}`)
        if (t!.step?.done) doneAt.add(t!.id)
        if (!t!.step?.started || t!.step.done) { unowned.delete(t!.id); continue }
        // Owned: its action runs, or it says why it waits (its agent holding the step counts).
        if (actionRunning(t!.id) || statedReason(t!, taskPlan(wf, t!, p))) unowned.delete(t!.id)
        else unowned.set(t!.id, unowned.get(t!.id) ?? now)
        worst[t!.id] = Math.max(worst[t!.id] ?? 0, now - (unowned.get(t!.id) ?? now))
        silent[t!.id] = Math.max(silent[t!.id] ?? 0, now - (t!.log?.at(-1)?.at ?? t!.createdAt))
      }
      if (all.every(t => t!.step?.done) && !after--) break
    }

    const done = await Promise.all(ids.map(id => store.task(id)))
    const logs = Object.fromEntries(done.map(t => [t!.id, t!.log!.map(l => l.text)]))
    expect(done.map(t => [t!.id, t!.step?.done]), JSON.stringify(logs, null, 1)).toEqual(ids.map(id => [id, true]))
    expect(undone, 'a done task left done').toEqual([])
    // Merged in a sensible order: WH-3 after WH-2, whose file it shares.
    const order = world.gh.merged.map(b => b.slice('task/'.length))
    expect([...order].sort()).toEqual(ids)
    expect(order.indexOf('WH-3')).toBeGreaterThan(order.indexOf('WH-2'))
    // Each fault happened, and the engine got past it.
    expect(unread && hung).toBe(true)
    expect(world.gh.conflicts).toContain('task/WH-3')
    expect(logs['WH-4']!.some(l => l.startsWith('ci-to-agent'))).toBe(true)
    const main = (f: string) => world!.git(world!.repo, 'show', `origin/main:${f}`)
    world.git(world.repo, 'fetch', '-q', 'origin')
    expect(main('src/shared.txt').split('\n').sort()).toEqual(['from WH-2', 'from WH-3', 'shared'])
    expect(main('src/d.txt')).toBe('fixed')
    expect(main('docs/llms.txt')).toContain('[A](docs/a.md)')
    // Never without an owner, a running action or a written reason past the sentinel's limit.
    for (const id of ids) expect(worst[id], `${id} unowned`).toBeLessThanOrEqual(SENTINEL_MS + TICK)
    // Its log never silent while it waits longer than an action may hold it (the hung merge), and a tick to say so.
    for (const id of ids) expect(silent[id], `${id} silent`).toBeLessThanOrEqual(ACTION_LIMIT_MS + 2 * TICK)
    expect(logs['WH-1']!.some(l => l.includes('its result is dropped'))).toBe(true)
  })
})
