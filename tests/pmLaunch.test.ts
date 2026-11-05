import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore, type PmStore } from '../server/utils/pmStore'
import { reconcileRuns, startTask, wherdrBase, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { uploadShot } from '../server/utils/pmBoard'
import { agentLine, publicTask, reconcile, workerPlan, type Run, type Task } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'

const template: Template = {
  id: 'vibe', instructions: 'Small commits.', prefs: { agent: 'claude', model: 'opus' },
  taskTypes: {
    simple: { steps: [{ id: 'todo' }, { id: 'work', holder: 'worker', ends: 'report', instructions: 'Run the tests.' }] },
    fast: { prefs: { model: 'sonnet' }, steps: ['work'] },
    talk: { steps: [{ id: 'pick', ends: 'user' }] },
  },
  steps: { work: { id: 'work', holder: 'worker', ends: 'report' } },
}
const task = (over: Partial<Task> = {}): Task => ({ id: 'WEB-1', project: 'WEB', title: 'T', description: 'D', type: 'simple', state: 'todo', createdAt: 0, ...over })

describe('worker plan and command line', () => {
  it('pins the nearest agent and model, and says why a task cannot start', () => {
    expect(workerPlan(template, task())).toEqual({ program: 'claude', model: 'opus' })
    expect(workerPlan(template, task({ type: 'fast' }))).toEqual({ program: 'claude', model: 'sonnet' })
    expect(workerPlan(template, task({ prefs: { model: 'haiku' } }))).toEqual({ program: 'claude', model: 'haiku' })
    expect(workerPlan(template, task({ type: 'talk' }))).toEqual({ reason: 'Task type "talk" has no worker step' })
    expect(workerPlan({ ...template, prefs: { agent: 'claude' } }, task())).toMatchObject({ reason: expect.stringMatching(/^No model set/) })
    expect(workerPlan(template, task({ prefs: { agent: 'pi' } }))).toMatchObject({ reason: expect.stringContaining('"pi"') })
    expect(workerPlan(template, task({ prefs: { model: 'x; rm -rf ~' } }))).toMatchObject({ reason: expect.stringMatching(/^Invalid model/) })
  })

  it('quotes everything after the program', () => {
    expect(agentLine('codex', 'gpt-5', "/h/it's.md")).toBe(`exec codex '--model' 'gpt-5' 'Read /h/it'\\''s.md and follow it.'`)
  })
})

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, task: 'WEB-1', role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'task/WEB-1',
  instructions: '/i.md', attempt: 1, state: 'running', startedAt: 0, ...over,
})

describe('reconcile', () => {
  it('finds runs by their labels, only this install\'s, and skips ended runs', () => {
    const labels = (r: string, install = 'me') => ({ 'wherdr.install': install, 'wherdr.run': r })
    const found = reconcile(
      [run('a'), run('b', { state: 'starting' }), run('c'), run('d'), run('e', { state: 'ended' })],
      [{ address: 't1', labels: labels('a') }, { address: 'pi/t2', labels: labels('b') }, { address: 't3', labels: labels('c'), state: 'finished' }, { address: 't4', labels: labels('d', 'other') }],
      'me')
    expect(found.map(f => [f.run.id, f.state, 'terminal' in f ? f.terminal : null])).toEqual([
      ['a', 'running', 't1'], ['b', 'running', 'pi/t2'], ['c', 'exit', null], ['d', 'lost', null],
    ])
  })
})

// A fake herdr-core: one remote machine per test (kindsOf caches by machine).
let dir = '', n = 0
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-launch-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

async function setup(opts: { installed?: string[], exits?: (number | null)[], template?: Template, screen?: string } = {}) {
  const store: PmStore = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(opts.template ?? template)
  const machine = `m${++n}`
  await store.addProject({ key: 'WEB', machine, path: '/home/u/web', template: 'vibe' }, async (_m, p) => p)
  await store.addTask({ project: 'WEB', title: 'Fix it', type: 'simple' })
  const runs: Record<string, unknown>[] = [], files: Record<string, string> = {}
  const exits = [...(opts.exits ?? [])]
  const states: Record<string, number | null | undefined> = {}
  const call = async (method: string, p: Record<string, unknown>) => {
    if (method === 'machine.exec') {
      const [, , script, , ...args] = p.argv as string[]
      if (script!.includes('command -v')) return { code: 0, stdout: Buffer.from(args.filter(a => (opts.installed ?? ['claude']).includes(a)).join('\n')).toString('base64') }
      if (script!.includes('$HOME')) return { code: 0, stdout: Buffer.from('/home/u').toString('base64') }
      if (p.input) files[args[0]!] = Buffer.from(p.input as string, 'base64').toString()
      return { code: 0, stdout: '' }
    }
    if (method === 'terminal.run') { runs.push(p); const a = `${machine}/t${runs.length}`; states[a] = exits.shift(); return { address: a } }
    if (method === 'terminal.get') return states[p.terminal as string] === undefined ? { state: 'running' } : { state: 'finished', exit_code: states[p.terminal as string] }
    if (method === 'terminal.read') return { text: opts.screen ?? 'claude: bad flag\n' }
    throw new Error(`unexpected ${method}`)
  }
  const deps = {
    call, store, machines: () => [{ key: machine, label: machine, local: false, status: 'online' }],
    panes: () => [], workspaces: () => [], settle: async () => {}, recent: async () => [], remember: async () => {}, launchWatchMs: 0,
  } as unknown as PmLaunchDeps
  return { store, deps, runs, files, machine }
}

describe('startTask', () => {
  it('starts a labelled agent in a worktree, model pinned, autoupdate off, instructions in a file', async () => {
    const { store, deps, runs, files } = await setup()
    const t = await startTask(deps, 'WEB-1')
    // The board follows it: the engine has it in its worker's step.
    expect(t).toMatchObject({ state: 'working', step: { started: true, at: 1 } })
    expect(runs).toHaveLength(1)
    const install = await store.install()
    expect(runs[0]).toMatchObject({
      cwd: '/home/u/.wherdr/pm/worktrees/WEB-1', env: { DISABLE_AUTOUPDATER: '1' }, no_parent: true,
      labels: { 'wherdr.install': install, 'wherdr.task': 'WEB-1', 'wherdr.run': t.run, 'wherdr.role': 'worker' },
    })
    expect(runs[0]!.line).toContain(`exec claude '--model' 'opus' 'Read /home/u/.wherdr/pm/tasks/WEB-1/instructions.md and follow it.'`)
    expect(files['/home/u/.wherdr/pm/tasks/WEB-1/instructions.md']).toMatch(/# WEB-1: Fix it[\s\S]*Small commits\.\nRun the tests\./)
    expect((await store.runs())[0]).toMatchObject({ id: t.run, state: 'running', terminal: expect.stringMatching(/\/t1$/) })
    await expect(startTask(deps, 'WEB-1')).rejects.toMatchObject({ code: 'busy' })
  })

  it('a visual task: the instructions file says how to upload the screenshots, with the task\'s key, and that upload passes', async () => {
    const visual = { ...template, taskTypes: { simple: { steps: [{ id: 'todo' }, { id: 'work', holder: 'worker' as const, ends: 'report' as const, evidence: ['screenshots' as const], screenshots: 'before-after' as const }] } } }
    const { store, deps, files } = await setup({ template: visual })
    await startTask({ ...deps, origin: 'https://wherdr.example.ts.net' }, 'WEB-1')
    const token = (await store.task('WEB-1'))!.shotToken!
    expect(token).toMatch(/^[a-f0-9]{32}$/)
    const text = files['/home/u/.wherdr/pm/tasks/WEB-1/instructions.md']!
    expect(text).toContain('## Screenshots')
    const cmd = `curl -fsS -X POST -H 'Content-Type: image/png' -H 'X-Wherdr-Shot-Token: ${token}' --data-binary @shot.png 'https://wherdr.example.ts.net/api/pm/shot?task=WEB-1&phase=before'`
    expect(text).toContain(cmd)
    expect(text).toContain(cmd.replace('phase=before', 'phase=after'))
    // What the command sends is taken; the browser never sees the key.
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2])
    await expect(uploadShot(store, 'WEB-1', 'before', png, 'image/png', token)).resolves.toMatchObject({ phase: 'before' })
    expect(JSON.stringify((await store.overview()).tasks)).not.toContain(token)
    expect(JSON.stringify(publicTask((await store.task('WEB-1'))!))).not.toContain(token)
  })

  it('agents reach wherdr on loopback from its own machine, else at the app address or the user\'s', () => {
    expect(wherdrBase('', 'https://b.example', 'https://a.example/', '7683')).toBe('http://127.0.0.1:7683')
    expect(wherdrBase('m1', 'https://b.example', 'https://a.example/', '7683')).toBe('https://a.example')
    expect(wherdrBase('m1', 'https://b.example', '', '7683')).toBe('https://b.example')
  })

  it('a missing program: waiting with the reason, no terminal', async () => {
    const { deps, runs, machine } = await setup({ installed: [] })
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting', waiting: `claude is not installed on ${machine}` })
    expect(runs).toHaveLength(0)
  })

  it('an agent that stops on its login: the task waits for the login (the engine restarts it once back)', async () => {
    const { deps } = await setup({ exits: [1, 1], screen: 'Invalid API key · Please run /login\n' })
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting', waitKind: 'auth' })
  })

  it('an agent that exits at once gets one more attempt, never a third', async () => {
    const { store, deps, runs } = await setup({ exits: [1, 1, 1] })
    const t = await startTask(deps, 'WEB-1')
    expect(t).toMatchObject({ state: 'waiting', waiting: expect.stringContaining('exit code 1') })
    expect(t.waitKind).toBeUndefined() // not a login
    expect(runs).toHaveLength(2)
    expect((await store.runs()).map(r => [r.attempt, r.state])).toEqual(expect.arrayContaining([[1, 'ended'], [2, 'ended']]))
  })

  it('a program the shell cannot find is not started again', async () => {
    const { deps, runs } = await setup({ exits: [127] })
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting' })
    expect(runs).toHaveLength(1)
  })
})

describe('reconcileRuns after a restart', () => {
  it('keeps a run whose terminal is there, and puts a task whose terminal is gone in waiting', async () => {
    const { store, deps } = await setup()
    const t = await startTask(deps, 'WEB-1')
    const install = await store.install()
    const restarted = createPmStore(dir)
    const list = (terminals: unknown[]) => ({ ...deps, store: restarted, call: async () => ({ terminals }) }) as unknown as PmLaunchDeps
    await reconcileRuns(list([{ address: 'm/t9', labels: { 'wherdr.install': install, 'wherdr.run': t.run } }]))
    expect((await restarted.runs())[0]).toMatchObject({ id: t.run, terminal: 'm/t9', state: 'running' })
    expect(await restarted.task('WEB-1')).toMatchObject({ state: 'working' })
    await reconcileRuns(list([]))
    expect(await restarted.task('WEB-1')).toMatchObject({ state: 'waiting', waiting: expect.stringContaining('gone') })
    expect((await restarted.runs())[0]).toMatchObject({ state: 'ended', endedBy: 'lost' })
  })
})
