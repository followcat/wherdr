import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore, type PmStore } from '../server/utils/pmStore'
import { FETCH_BRANCH_SCRIPT, WORKTREE_SCRIPT, reconcileRuns, startTask, wherdrBase, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { uploadShot } from '../server/utils/pmBoard'
import { agentLine, duplicateAgents, publicTask, reconcile, workerPlan, type Run, type Task } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'
import { wherdr } from '../shared/pm/examples'
import { planSteps } from '../shared/pm/steps'
import { dueText } from '../shared/pm/advance'
import { startFileWaits } from '../server/utils/pmFiles'
import { startHeld } from '../server/utils/pmMechanic'
import { resumeInterrupted } from '../server/utils/pmRecovery'
import { CoreError } from '../server/utils/core'

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
    expect(agentLine('codex', 'gpt-5', "/h/it's.md")).toBe(`exec codex '-c' 'check_for_update_on_startup=false' '--model' 'gpt-5' 'Read /h/it'\\''s.md and follow it.'`)
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

describe('duplicateAgents', () => {
  it('two live agents of one role on a task: the tracked one stays, the other ends', () => {
    const t = (address: string, r: string, role = 'worker', state?: string) => ({ address, state, labels: { 'wherdr.install': 'me', 'wherdr.task': 'WEB-1', 'wherdr.run': r, 'wherdr.role': role } })
    const runs = [run('a', { startedAt: 1 }), run('b', { startedAt: 2 })]
    // The task's run stays, even the older one.
    expect(duplicateAgents([t('t1', 'a'), t('t2', 'b')], runs, [{ id: 'WEB-1', run: 'a' }], 'me'))
      .toEqual([{ task: 'WEB-1', role: 'worker', keep: t('t1', 'a'), end: [t('t2', 'b')] }])
    // Not the task's run (a reviewer's): the newest worker run stays.
    expect(duplicateAgents([t('t1', 'a'), t('t2', 'b')], runs, [{ id: 'WEB-1', run: 'x' }], 'me')[0]!.keep.address).toBe('t2')
    // One per role, a finished one: nothing to end.
    expect(duplicateAgents([t('t1', 'a'), t('t2', 'b', 'reviewer'), t('t3', 'c', 'worker', 'finished')], runs, [], 'me')).toEqual([])
  })
})

// A fake herdr-core: one remote machine per test (kindsOf caches by machine).
let dir = '', n = 0
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-launch-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

async function setup(opts: { installed?: string[], exits?: (number | null)[], template?: Template, screen?: string, tmpFreeKb?: number, exec?: (script: string) => string | undefined, fails?: (script: string) => number | undefined } = {}) {
  const store: PmStore = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(opts.template ?? template)
  const machine = `m${++n}`
  await store.addProject({ key: 'WEB', machine, path: '/home/u/web', template: 'vibe' }, async (_m, p) => p)
  await store.addTask({ project: 'WEB', title: 'Fix it', type: 'simple' })
  const runs: Record<string, unknown>[] = [], files: Record<string, string> = {}, execs: { script: string, args: string[] }[] = []
  const exits = [...(opts.exits ?? [])]
  const states: Record<string, number | null | undefined> = {}
  const call = async (method: string, p: Record<string, unknown>) => {
    if (method === 'machine.exec') {
      const [, , script, , ...args] = p.argv as string[]
      execs.push({ script: script!, args })
      const failed = opts.fails?.(script!)
      if (failed) return { code: failed, stdout: '' }
      if (script!.includes('command -v')) return { code: 0, stdout: Buffer.from(args.filter(a => (opts.installed ?? ['claude']).includes(a)).join('\n')).toString('base64') }
      if (script!.includes('printf %s "$HOME"')) return { code: 0, stdout: Buffer.from('/home/u').toString('base64') }
      if (script!.includes('df -Pk /tmp')) return { code: 0, stdout: Buffer.from(String(opts.tmpFreeKb ?? 9e6)).toString('base64') }
      if (p.input) files[args[0]!] = Buffer.from(p.input as string, 'base64').toString()
      return { code: 0, stdout: Buffer.from(opts.exec?.(script!) ?? '').toString('base64') }
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
  return { store, deps, runs, files, machine, execs }
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
      cwd: '/home/u/.wherdr/pm/worktrees/WEB-1', env: { DISABLE_AUTOUPDATER: '1', TMPDIR: '/home/u/.wherdr/pm/worktrees/WEB-1/.wherdr-tmp' }, no_parent: true,
      labels: { 'wherdr.install': install, 'wherdr.task': 'WEB-1', 'wherdr.run': t.run, 'wherdr.role': 'worker' },
    })
    expect(runs[0]!.line).toContain(`exec claude '--model' 'opus' '--session-id' '${(await store.runs())[0]!.session}' 'Read /home/u/.wherdr/pm/tasks/WEB-1/instructions.md and follow it.'`)
    expect(files['/home/u/.wherdr/pm/tasks/WEB-1/instructions.md']).toMatch(/# WEB-1: Fix it[\s\S]*Small commits\.\nRun the tests\./)
    expect((await store.runs())[0]).toMatchObject({ id: t.run, state: 'running', terminal: expect.stringMatching(/\/t1$/) })
    await expect(startTask(deps, 'WEB-1')).rejects.toMatchObject({ code: 'busy' })
  })

  it('a start waits behind a started task that touches the same files, unless the user starts it anyway; the engine starts it once they are free', async () => {
    const { store, deps, runs, files } = await setup()
    const first = { ...(await store.task('WEB-1'))!, state: 'working' as const, step: { at: 1, started: true, since: 1, proofs: {}, rounds: {} }, changed: ['app/x.vue'] }
    await store.saveTask(first)
    await store.addTask({ project: 'WEB', title: 'Other', type: 'simple', files: ['app/'] })
    expect(await startTask(deps, 'WEB-2')).toMatchObject({ state: 'todo', sameFiles: 'WEB-1' })
    expect(runs).toHaveLength(0)
    // Still behind it: nothing starts.
    expect(await startFileWaits(deps)).toEqual([])
    await store.saveTask({ ...first, step: { ...first.step, done: true } })
    expect(await startFileWaits(deps)).toEqual(['WEB-2'])
    expect(await store.task('WEB-2')).toMatchObject({ state: 'working' })
    expect((await store.task('WEB-2'))!.sameFiles).toBeUndefined()
    expect(files['/home/u/.wherdr/pm/tasks/WEB-2/instructions.md']).toContain('to /home/u/.wherdr/pm/tasks/WEB-2/files.txt, one per line (a folder covers what is in it). Planned so far: app.')
    // The user's "Start anyway" goes beside it.
    await store.saveTask({ ...first, id: 'WEB-1', step: first.step })
    await store.addTask({ project: 'WEB', title: 'Third', type: 'simple', files: ['app/x.vue'] })
    expect(await startTask(deps, 'WEB-3', { anyway: true })).toMatchObject({ state: 'working' })
  })

  it('a task stopped at its review starts no new worker: the review is told again by the next advance pass', async () => {
    const { store, deps, runs } = await setup({ template: { ...wherdr, id: 'vibe' } })
    const stopped = { ...(await store.task('WEB-1'))!, state: 'waiting' as const, waiting: 'The reviewer (claude) stopped right after starting', step: { at: 3, started: true, since: 5, told: 5, proofs: {}, rounds: {} } }
    await store.saveTask(stopped)
    // Its worker still runs (kept until idle): no worker is started, so nothing to refuse.
    await store.saveRun(run('w1', { terminal: 'm/t0' }))
    const t = await startTask(deps, 'WEB-1', { by: 'user' })
    expect(runs).toHaveLength(0)
    expect(t).toMatchObject({ state: 'working', waiting: undefined, step: { at: 3 } })
    expect(t.step!.told).toBeUndefined()
    expect(dueText(planSteps(wherdr, { type: 'simple' }), t.step)).toMatchObject({ holder: 'reviewer' })
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

  it.each([false, true])('a task that continues a branch starts from it when the remote has it, else from the base, saying so (gone: %s)', async (gone) => {
    const worktree = (execs: { script: string, args: string[] }[]) => execs.find(e => e.script === WORKTREE_SCRIPT)!.args.slice(1)
    const { store, deps, files, execs } = await setup({ fails: s => gone && s === FETCH_BRANCH_SCRIPT ? 2 : undefined })
    await store.addTask({ project: 'WEB', title: 'Dark mode', type: 'simple', fromBranch: 'work/2-dark-mode' })
    const t = await startTask(deps, 'WEB-2')
    expect(execs.find(e => e.script === FETCH_BRANCH_SCRIPT)!.args).toEqual(['/home/u/web', 'work/2-dark-mode'])
    const text = files['/home/u/.wherdr/pm/tasks/WEB-2/instructions.md']!
    if (!gone) {
      expect(t.branch).toBe('work/2-dark-mode')
      expect(worktree(execs)).toEqual(['/home/u/.wherdr/pm/worktrees/WEB-2', 'work/2-dark-mode', '', 'origin/work/2-dark-mode'])
      expect(text).not.toMatch(/no longer on the remote/)
    } else {
      expect(t.branch).not.toBe('work/2-dark-mode')
      expect(worktree(execs)).toEqual(['/home/u/.wherdr/pm/worktrees/WEB-2', t.branch, '', ''])
      const line = 'Branch `work/2-dark-mode` is no longer on the remote: this task starts from the base branch instead.'
      expect(text).toContain(line)
      expect(t.log!.map(l => l.text)).toContain(line)
    }
  })

  it('a task whose branch to continue cannot be fetched (remote unreachable) waits, without a worktree', async () => {
    const { store, deps, execs } = await setup({ fails: s => s === FETCH_BRANCH_SCRIPT ? 1 : undefined })
    await store.addTask({ project: 'WEB', title: 'Dark mode', type: 'simple', fromBranch: 'feature/c++' })
    expect(await startTask(deps, 'WEB-2')).toMatchObject({ state: 'waiting', waiting: expect.stringMatching(/Could not fetch branch `feature\/c\+\+`/) })
    expect(execs.some(e => e.script === WORKTREE_SCRIPT)).toBe(false)
  })

  it('a nearly full /tmp on the machine: waiting with the reason, no terminal', async () => {
    const { deps, runs } = await setup({ tmpFreeKb: 100 * 1024 })
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting', waiting: expect.stringMatching(/\/tmp .* only 100 MB free/) })
    expect(runs).toHaveLength(0)
  })

  it('a failing worktree setup command: the task waits for the user with its output, no terminal', async () => {
    const exec = (s: string) => (s.includes('ls-files') ? 'share no node_modules differs\nneed' : s.includes('sh -c "$cmd"') ? 'run 1 4\nout npm ERR! boom' : undefined)
    const { store, deps, runs } = await setup({ template: { ...template, worktree: { command: 'npm ci' } }, exec })
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting', waiting: expect.stringMatching(/`npm ci` exited with code 1\. Last output:\nnpm ERR! boom$/) })
    expect(runs).toHaveLength(0)
    expect((await store.task('WEB-1'))!.log!.at(-1)!.text).toBe('worktree setup: not shared node_modules (package-lock.json differs from the clone\'s); ran npm ci (exit code 1)')
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

  it('two starts at once (the user and the engine\'s chain): one worker, the other refused as already starting', async () => {
    const { deps, runs } = await setup()
    const [a, b] = await Promise.allSettled([startTask(deps, 'WEB-1', { by: 'user' }), startTask(deps, 'WEB-1')])
    expect(a).toMatchObject({ status: 'fulfilled', value: { state: 'working' } })
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'busy', message: expect.stringContaining('already starting') } })
    expect(runs).toHaveLength(1)
  })

  it('a waiting task whose worker still runs gets no second one, even revived; once it ended, it starts', async () => {
    const { store, deps, runs } = await setup()
    const t = await startTask(deps, 'WEB-1')
    await store.saveTask({ ...(await store.task('WEB-1'))!, state: 'waiting', waiting: 'a question' })
    await expect(startTask(deps, 'WEB-1', { by: 'user' })).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('still running') })
    await expect(startTask(deps, 'WEB-1', { revive: true })).rejects.toMatchObject({ code: 'busy' })
    await store.saveRun({ ...(await store.runs()).find(r => r.id === t.run)!, state: 'ended', endedBy: 'stopped' })
    expect(await startTask(deps, 'WEB-1', { by: 'user' })).toMatchObject({ state: 'working' })
    expect(runs).toHaveLength(2)
  })

  it('a start held for room, then started by the user: the hold is cleared, the held start fires as busy (dropped by startHeld)', async () => {
    const { store, deps, runs, machine } = await setup()
    await store.saveTask({ ...(await store.task('WEB-1'))!, held: 'No room' })
    const [user, held] = await Promise.allSettled([startTask(deps, 'WEB-1', { by: 'user' }), startTask(deps, 'WEB-1', { on: machine })])
    expect(user).toMatchObject({ status: 'fulfilled', value: { state: 'working' } })
    expect(held).toMatchObject({ status: 'rejected', reason: { code: 'busy' } })
    expect((await store.task('WEB-1'))!.held).toBeUndefined()
    await expect(startTask(deps, 'WEB-1', { on: machine })).rejects.toMatchObject({ code: 'busy' })
    expect(runs).toHaveLength(1)
  })

  // The engine's start finds its machine offline: to do, held (never a failure for the user), started by the next tick once it is back.
  const offlineAt = (deps: PmLaunchDeps, machine: string) => {
    let online = false
    deps.machines = () => [{ key: machine, label: machine, local: false, status: online ? 'online' : 'offline' }] as never
    return () => { online = true }
  }

  it('an engine start on an unreachable machine joins its open offline incident, which starts it once the machine is back', async () => {
    const { store, deps, runs, machine } = await setup()
    // Another task's agent on that machine, gone with an offline incident the engine tracks.
    const other = await store.saveTask({ ...(await store.addTask({ project: 'WEB', title: 'Other', type: 'simple' })), state: 'waiting', run: 'r9' })
    const [i] = await store.addIncidents([{ at: 1, machine, label: machine, cause: 'offline', evidence: [], tasks: [other.id], runs: ['r9'] }])
    const back = offlineAt(deps, machine)
    expect(await startTask(deps, 'WEB-1')).toMatchObject({ state: 'waiting', waiting: `Waits for ${machine} (unreachable, incident ${i!.id}): wherdr starts it once it is back`, recovery: { incident: i!.id, cause: 'offline', machine, waits: true } })
    expect((await store.incidents())[0]!.tasks).toEqual([other.id, 'WEB-1'])
    expect((await resumeInterrupted(deps)).resumed).toEqual([])
    back()
    expect((await resumeInterrupted(deps)).resumed).toEqual(['WEB-1'])
    const t = (await store.task('WEB-1'))!
    expect(t).toMatchObject({ state: 'working' })
    expect([t.held, t.waiting]).toEqual([undefined, undefined])
    expect(t.log!.at(-1)!.text).toBe(`started after incident ${i!.id}: ${machine} is back`)
    expect(runs).toHaveLength(1)
  })

  it('a start once its files are free, its machine out of reach midway (herdr-core answers unreachable): held, started by the next tick once it is back', async () => {
    const { store, deps, runs } = await setup()
    const first = await store.saveTask({ ...(await store.task('WEB-1'))!, state: 'working', step: { at: 1, started: true, since: 1, proofs: {}, rounds: {} }, changed: ['app/x.vue'] })
    await store.addTask({ project: 'WEB', title: 'Other', type: 'simple', files: ['app/'] })
    expect(await startTask(deps, 'WEB-2')).toMatchObject({ state: 'todo', sameFiles: 'WEB-1' })
    // The inventory still says online; herdr-core's answer says otherwise.
    const call = deps.call, label = deps.machines()[0]!.label
    let down = true
    deps.call = (async (method: string, p: { argv?: string[] }, ...rest: unknown[]) => {
      if (down && method === 'machine.exec' && p.argv?.[2] === WORKTREE_SCRIPT) throw new CoreError('unreachable', 'machine unreachable')
      return (call as (...a: unknown[]) => unknown)(method, p, ...rest)
    }) as never
    await store.saveTask({ ...first, step: { ...first.step!, done: true } })
    expect(await startFileWaits(deps)).toEqual(['WEB-2'])
    expect(await store.task('WEB-2')).toMatchObject({ state: 'todo', held: `Waits for ${label} (unreachable)` })
    expect((await store.task('WEB-2'))!.log!.at(-1)!.text).toBe(`could not start: Waits for ${label} (unreachable)`)
    down = false
    expect(await startHeld(deps)).toEqual(['WEB-2'])
    const t = (await store.task('WEB-2'))!
    expect(t.state).toBe('working')
    expect([t.held, t.waiting, t.sameFiles, t.machineWait]).toEqual([undefined, undefined, undefined, undefined])
    expect(t.log!.at(-1)!.text).toBe('started: a machine is back')
    expect(runs).toHaveLength(1)
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
    // Recorded as an incident, with the facts it used.
    expect(await restarted.incidents()).toMatchObject([{ tasks: ['WEB-1'], runs: [t.run], evidence: [expect.stringContaining('terminal not found')] }])
  })
})
