// A project's On state change command (shared/pm/onState.ts, server/utils/pmOnState.ts):
// each event once with its environment, its result in the task's log, the user's only.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { issueToken } from '../server/utils/pmCoordinator'
import { updateProject } from '../server/utils/pmProject'
import { runOnState } from '../server/utils/pmOnState'
import { stateChanges, type TaskStateName } from '../shared/pm/onState'
import type { Task } from '../shared/pm/run'
import type { StepState } from '../shared/pm/steps'

const step = (s: Partial<StepState> = {}): StepState => ({ at: 0, started: true, proofs: {}, rounds: {}, ...s })
const task = (t: Partial<Task> = {}): Task => ({ id: 'CO-1', project: 'CO', title: 'Fix the login', description: '', type: 'feature', state: 'working', tags: ['ABC-123'], createdAt: 1, ...t })

describe('stateChanges', () => {
  it('names each change once: started, waits, done, failed, stopped', () => {
    const todo = task({ state: 'todo' })
    expect(stateChanges(todo, task({ step: step() }))).toEqual(['started'])
    expect(stateChanges(task({ step: step() }), task({ step: step({ yourTurn: { reason: 'user', badge: 'Review' } }) }))).toEqual(['waits'])
    expect(stateChanges(task({ step: step() }), task({ step: step({ done: true }) }))).toEqual(['done'])
    expect(stateChanges(task({ step: step() }), task({ step: step({ done: true, abandoned: true }) }))).toEqual(['failed'])
    expect(stateChanges(task({ step: step() }), task({ step: step(), stopped: { by: 'user', why: 'x', at: 1 } }))).toEqual(['stopped'])
    // Seen before (stateRan): never again.
    expect(stateChanges(task({ step: step() }), task({ step: step({ done: true }), stateRan: { done: 1 } }))).toEqual([])
    expect(stateChanges(task({ step: step() }), task({ step: step({ x: 1 } as Partial<StepState>) }))).toEqual([])
  })
})

describe('the On state change command', () => {
  let dir = '', store: ReturnType<typeof createPmStore>
  const told: [string, TaskStateName[]][] = []
  const runs: { argv: string[], timeout: number }[] = []
  let answer: { code: number | null, stdout: string, stderr?: string, timed_out?: boolean } = { code: 0, stdout: '' }
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  const deps = () => ({
    store,
    machines: () => [{ key: '', label: 'host', local: true, status: 'online' }] as never,
    call: async <T>(_m: string, p: object): Promise<T> => {
      const { argv, timeout } = p as { argv: string[], timeout: number }
      if (argv[2] === 'printf %s "$HOME"') return { code: 0, stdout: b64('/home/u') } as T
      runs.push({ argv, timeout })
      return answer as T
    },
  })
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-onstate-'))
    store = createPmStore(dir)
    await store.setEnabled(true)
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Company', machine: '', path: '/src/co', addedAt: 1 }] }))
    told.length = 0, runs.length = 0, answer = { code: 0, stdout: '' }
    store.onStateChanges((t, s) => { told.push([t.id, s]) })
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))
  const settle = () => new Promise(r => setImmediate(r))

  it('runs once when a task is done, with its id and tag in the environment, its result in the log', async () => {
    await updateProject(store, 'CO', { onStateChange: { command: 'jira-sync', events: ['done'] } })
    await store.saveTask(task({ step: step() }))
    await store.saveTask(task({ step: step({ done: true }) }))
    await store.saveTask(task({ step: step({ done: true }) }))
    await settle()
    expect(told).toEqual([['CO-1', ['started']], ['CO-1', ['done']]])
    answer = { code: 0, stdout: b64('moved ABC-123 to Done\nmore') }
    for (const [, s] of told) await runOnState(deps(), (await store.task('CO-1'))!, s)
    // Only the picked event runs, in the clone, 30 s at most, the command never in the line.
    expect(runs).toHaveLength(1)
    const { argv, timeout } = runs[0]!
    expect(timeout).toBe(30)
    expect(argv.slice(4)).toEqual(['/src/co', 'WHERDR_TASK_ID=CO-1', 'WHERDR_TASK_TAG=ABC-123', 'WHERDR_TASK_TITLE=Fix the login', 'WHERDR_TASK_STATE=done', 'WHERDR_TASK_PR=', 'WHERDR_PROJECT=CO', 'sh', '-c', 'jira-sync'])
    expect((await store.task('CO-1'))!.log!.at(-1)!.text).toBe('on state change (done): exit 0: moved ABC-123 to Done / more')
  })

  it('keeps an event seen when an older copy of the task is saved', async () => {
    const started = await store.saveTask(task({ step: step() }))
    await store.saveTask({ ...started, step: step({ yourTurn: { reason: 'user', badge: 'Review' } }) })
    await store.logTask(started, 'engine', 'an older copy')
    await store.updateTask('CO-1', t => ({ ...t, step: step({ yourTurn: { reason: 'user', badge: 'Review' } }) }))
    await settle()
    expect(told.map(([, s]) => s)).toEqual([['started'], ['waits']])
  })

  it('logs a failure and a timeout, never tried again; no setting runs nothing', async () => {
    await runOnState(deps(), task(), ['done'])
    expect(runs).toHaveLength(0)
    await store.saveTask(task({ step: step() }))
    await updateProject(store, 'CO', { onStateChange: { command: 'false', events: ['started', 'failed'] } })
    answer = { code: 1, stdout: '', stderr: b64('no ticket') }
    await runOnState(deps(), task(), ['started'])
    answer = { code: null, stdout: '', timed_out: true }
    await runOnState(deps(), task(), ['stopped'])
    expect(runs).toHaveLength(2)
    expect((await store.task('CO-1'))!.log!.slice(-2).map(l => l.text)).toEqual(['on state change (started): exit 1: no ticket', 'on state change (stopped): timed out after 30 s'])
  })

  it('is set by the user only: a coordinator\'s token is refused', async () => {
    const token = await issueToken(store, 'CO')
    await expect(updateProject(store, 'CO', { onStateChange: { command: 'x', events: ['done'] } }, `Bearer ${token}`)).rejects.toThrow('Only the user sets the On state change command')
    expect((await store.project('CO'))?.onStateChange).toBeUndefined()
  })
})
