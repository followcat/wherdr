import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { advanceTick } from '../server/utils/pmAdvance'
import { actionsSettled } from '../server/utils/pmBoard'
import { mechanicTick } from '../server/utils/pmMechanic'
import { cleanTask } from '../server/utils/pmCleanup'
import { startTask } from '../server/utils/pmLaunch'
import { READ_SEP } from '../shared/pm/advance'
import { github } from '../shared/pm/examples'
import { initialState, onEvent, planSteps } from '../shared/pm/steps'
import type { Run } from '../shared/pm/run'

// A project on the wherdr host whose task runs on machine B: everything done
// for that run (signal read, actions, reviewer, login check, cleanup) goes to B.
let dir = '', calls: [string, Record<string, unknown>][] = []
let ready = 'clone ok https://github.com/o/r\npush ok\nagent:claude ok\ndisk ok 9999999'
const terms: Record<string, Record<string, string>> = {}
const machines = () => [{ key: '', local: true, label: 'host' }, { key: 'b', local: false, status: 'online', label: 'machine-b' }]
const call = async (method: string, p: Record<string, unknown>) => {
  calls.push([method, p])
  if (method === 'terminal.list') return { terminals: Object.entries(terms).map(([address, labels]) => ({ address, labels })) }
  if (method === 'terminal.label') Object.assign(terms[p.terminal as string] ?? {}, p.labels)
  if (method === 'terminal.run') { terms['b/t2'] = {}; return { address: 'b/t2' } }
  if (method === 'terminal.get') return { state: 'running' }
  if (method !== 'machine.exec') return {}
  const script = (p.argv as string[])[2]!
  if (script.includes('wherdr-ready-check')) return { code: 0, stdout: Buffer.from(ready).toString('base64') }
  const out = script.includes('get-url origin') ? 'git@github.com:o/r.git' : script.includes('command -v') ? 'claude' : script.includes(READ_SEP) ? ['abc1234', '5', '', ''].join(`\n${READ_SEP}\n`)
    : script.includes('gh pr create') ? 'https://github.com/o/r/pull/9'
      : script.includes('$HOME') ? '/h' : script.includes('worktree list') ? '1 1 0 0' : ''
  // The login check fails: the task stays waiting, nothing restarts.
  return { code: script.includes('--contains') || script.includes('auth status') ? 1 : 0, stdout: Buffer.from(out).toString('base64') }
}
const store = () => createPmStore(dir)
const deps = () => ({ store: store(), call, machines, launchWatchMs: 0 }) as unknown as Parameters<typeof advanceTick>[0]
const worker = (more: Partial<Run> = {}): Run => ({ id: 'r1', task: 'CO-1', role: 'worker', program: 'claude', model: 'sonnet', machine: 'b', worktree: '/h/.wherdr/pm/worktrees/CO-1', branch: 'task/CO-1', instructions: '/h/.wherdr/pm/tasks/CO-1/instructions.md', terminal: 'b/t1', attempt: 1, state: 'running', startedAt: 1, ...more })
const execs = () => calls.filter(([m]) => m === 'machine.exec' || m === 'terminal.run').map(([, p]) => p.on)

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-run-machine-'))
  calls = []
  for (const k of Object.keys(terms)) delete terms[k]
  await store().setEnabled(true)
  await store().saveTemplate(github)
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

async function setup(machine = '') {
  await store().addProject({ key: 'CO', machine, path: '/src', template: 'github' }, async (_m, p) => p)
  return store().addTask({ project: 'CO', title: 'Fix', type: 'simple' })
}
// B's clone under its home (~ is made B's home folder, /h here).
const allowB = () => store().updateProject('CO', { machines: ['b'], clones: { b: '~/src-b' } })
const worktreeCall = () => calls.find(([m, p]) => m === 'machine.exec' && (p.argv as string[])[2]!.includes('worktree add'))?.[1]

it('starts a task of a two-machine project on either; a started task goes back to its own', async () => {
  const t = await setup()
  await allowB()
  await expect(startTask(deps(), t.id, { on: 'c' })).rejects.toThrow('not allowed for the project')
  // B not ready: refused with each failed check, the task left to do, no worktree made.
  ready = 'clone ok https://github.com/o/r\npush fail fatal: Authentication failed\nagent:claude fail Not logged in'
  await expect(startTask(deps(), t.id, { on: 'b' })).rejects.toThrow('machine-b is not ready for this project: push rights: fatal: Authentication failed; claude login: not logged in')
  expect(await store().task(t.id)).toMatchObject({ state: 'todo' })
  expect(worktreeCall()).toBeUndefined()
  ready = 'clone ok https://github.com/o/r\npush ok\nagent:claude ok\ndisk ok 9999999'
  const started = await startTask(deps(), t.id, { on: 'b' })
  expect(started).toMatchObject({ state: 'working', machine: 'b' })
  expect(worktreeCall()).toMatchObject({ on: 'machine-b', argv: expect.arrayContaining(['/h/src-b']) })
  expect((await store().runs()).at(-1)).toMatchObject({ machine: 'b' })

  // Resume (stopped, a retry): back on B, never home. Its worker ended first: never two.
  const endRuns = async () => { for (const r of await store().runs()) await store().saveRun({ ...r, state: 'ended', endedBy: 'stopped' }) }
  await endRuns()
  await store().saveTask({ ...started, state: 'waiting' })
  calls = []
  expect(await startTask(deps(), t.id)).toMatchObject({ state: 'working', machine: 'b' })
  expect(worktreeCall()).toMatchObject({ on: 'machine-b' })
  await endRuns()
  await store().saveTask({ ...started, state: 'waiting' })
  await expect(startTask(deps(), t.id, { on: '' })).rejects.toThrow('stays there')

  // Another task with no machine asked: the home machine, its own clone.
  const home = await store().addTask({ project: 'CO', title: 'Docs', type: 'simple' })
  calls = []
  expect(await startTask(deps(), home.id)).toMatchObject({ machine: '' })
  expect(worktreeCall()).not.toHaveProperty('on')
  expect(worktreeCall()!.argv).toContain('/src')
})

it('reads the signal, runs the PR action and starts the reviewer on the run\'s machine', async () => {
  const t = await setup()
  const plan = planSteps(github, { type: 'simple' })
  const first = onEvent(plan, initialState(), { kind: 'start' }, 1).state
  await store().saveRun(worker())
  await store().saveTask({ ...t, state: 'working', run: 'r1', step: { ...first, told: first.since } })
  terms['b/t1'] = { 'wherdr.report': 'done' }
  await advanceTick(deps()) // the signal, then the PR (started outside the tick)
  await actionsSettled()
  await advanceTick(deps()) // the reviewer
  const task = (await store().task(t.id))!
  expect(task.step!.proofs.pr?.link).toBe('https://github.com/o/r/pull/9')
  expect(calls.find(([m]) => m === 'terminal.run')![1]).toMatchObject({ on: 'machine-b', labels: { 'wherdr.role': 'reviewer' } })
  expect(execs().length).toBeGreaterThan(3)
  expect(execs().every(on => on === 'machine-b')).toBe(true)
})

it('checks the login of a task waiting on it on the run\'s machine', async () => {
  const t = await setup()
  await store().saveRun(worker())
  await store().saveTask({ ...t, state: 'waiting', waitKind: 'auth', waiting: 'The agent is not logged in', run: 'r1', step: { at: 0, started: true, since: 1, proofs: {}, rounds: {} } })
  await mechanicTick(deps())
  const login = calls.find(([m, p]) => m === 'machine.exec' && (p.argv as string[])[2]!.includes('auth status'))
  expect(login?.[1]).toMatchObject({ on: 'machine-b', argv: expect.arrayContaining(['claude']) })
})

it('cleans up on the run\'s machine, in its clone there; a machine with no known clone keeps its worktree, with why', async () => {
  const t = await setup()
  const done = { ...t, state: 'done' as const, run: 'r1', step: { at: 9, started: true, since: 1, done: true, proofs: {}, rounds: {} } }
  await store().saveRun(worker({ state: 'ended' }))
  await store().saveTask(done)
  await cleanTask(deps(), t.id)
  expect(execs()).toEqual([])
  expect((await store().task(t.id))!.cleanup).toEqual({ skipped: 'wherdr knows no clone of the project on its machine (no longer allowed for the project)' })

  // B allowed, with its clone: removed there, in that clone.
  await allowB()
  await cleanTask(deps(), t.id)
  expect(execs().length).toBeGreaterThan(1)
  expect(execs().every(on => on === 'machine-b')).toBe(true)
  expect(calls.filter(([, p]) => String((p.argv as string[])[2]).includes('git -C')).every(([, p]) => (p.argv as string[]).includes('/h/src-b'))).toBe(true)
  expect((await store().task(t.id))!.cleanup).toEqual({ done: true })
})
