// server/utils/projectsTasks.ts with the launcher replaced by recorded output:
// which commands run, one at a time per machine, how sparingly, in which
// session and what a failure looks like.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localFs } from '../server/utils/fsx'

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'recordings/herdr-projects-1.2.1', name), 'utf8')

// A HOME with a board on disk: the task files wherdr reads beside the CLI.
const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-tasks-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
function taskFile(id: string, t: Record<string, unknown>) {
  const dir = path.join(home, '.herdr-projects/data/tasks', ...id.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, ...t }))
}

// The local machine, and a named session of it ("review"): one board.
const machine = { key: '', label: 'devbox', local: true, status: 'online', home, session: 'default', exec: null, sock: () => null, fs: localFs, info: () => ({ key: '' }) }
const remote = { ...machine, key: 'remote', label: 'workstation', local: false, info: () => ({ key: 'remote' }) }
const session = { ...machine, key: 'abcd1234', session: 'review', info: () => ({ key: 'abcd1234', baseKey: '' }) }
const info = { status: 'ready', version: '1.2.1', launcher: '/plugins/herdr-projects/bin/run.sh' }
let infoFails = false
const infoAsked: boolean[] = []
const panes: { id: string, machine?: string, agent?: string, cwd?: string, status?: string, name?: string }[] = []
vi.mock('../server/utils/machines', () => ({ allMachines: () => [machine, session], baseMachines: () => [machine], machineOfPane: () => ({ ...machine, transcripts: { locate: async () => ({ file: path.join(home, 'timer-transcript.jsonl') }) } }) }))
vi.mock('../server/utils/actions', () => ({ machineFor: (k: unknown) => (k === session.key ? session : k === 'remote' ? remote : machine) }))
vi.mock('../server/utils/projectsPlugin', () => ({ projectsPluginInfo: async (_m: unknown, fresh = false) => {
  infoAsked.push(fresh)
  if (infoFails) throw new Error('Herdr did not answer')
  return info
} }))
vi.mock('../server/utils/state', () => ({
  findPane: (id: string) => panes.find(p => p.id === id) || null,
  getState: () => ({ panes }),
}))
vi.mock('../server/utils/env', () => ({ HERDR_BIN: 'herdr', HERDR_CHILD_ENV: {}, DATA_DIR: path.join(home, 'wherdr-data'), log: () => {} }))
// The agents installed on the machine (server/utils/agentAvailability.ts).
let installed: string[] = ['claude', 'codex']
vi.mock('../server/utils/agentAvailability', () => ({ installedAgentKinds: async () => installed }))
// `show --json -- <id>`: the task's settings, worker.agent among them.
// Each task's own worker.agent, as 1.x keeps it: `delegate --worker.agent` writes
// it (1.2.1 start.rs delegate_with), `set`/`unset --task` change it.
let own: Record<string, string> = {}
let ownEffort: Record<string, string> = {}
// `board.agents` in the same reply (how many work at once); null: left out.
let boardAgents: number | null = null
const taskSettings = (value: string, place: string, from: string, effortOf?: string) => JSON.stringify({ settings: [
  { name: 'worker.agent', kind: 'work', value, from, place, own: false, note: '' },
  { name: 'worker.effort', kind: 'work', ...(effortOf ? { value: effortOf, from: 'this task', place: 'task' } : { value: 'default', from: 'built in', place: 'builtin' }), own: false, note: '' },
  ...(boardAgents === null ? [] : [{ name: 'board.agents', kind: 'board', value: boardAgents, from: 'you', place: 'you', own: false, note: '' }]),
], problems: [] })

const T = await import('../server/utils/projectsTasks')
const SA = await import('../server/utils/startAgents')

let calls: string[][]
// `show --repo` (a repo's key): kept apart, so `calls` stays the Board's own commands.
let shows: string[][] = []
let keysOf: Record<string, string> = {}
let active = 0
let maxActive = 0
let delay = 0
let showDelay = 0
let detailsReply: string | null = null
let listReply: { code: number, stdout: string, stderr: string } | null = null
// `coordinator [--machine | --project=R] status --json`, by its flag ('' for the Coordinator).
let coordStatus: Record<string, { state: string, pane: string, error?: string, queued?: number }> = {}
let clock = Date.now()
const later = (ms = 60_000) => { clock += ms; vi.setSystemTime(clock) }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  later()
  calls = []
  shows = []
  keysOf = { demo: 'DEMO' }
  active = maxActive = 0
  delay = 0
  showDelay = 0
  listReply = null
  detailsReply = null
  coordStatus = {}
  installed = ['claude', 'codex']
  own = {}
  ownEffort = {}
  boardAgents = null
  T.resetModelsCache()
  rmSync(path.join(home, 'wherdr-data'), { recursive: true, force: true })
  SA.resetStartAgents()
  infoFails = false
  info.status = 'ready'
  panes.length = 0
  T.resetTasksCache()
  rmSync(path.join(home, '.herdr-projects'), { recursive: true, force: true })
  T.setRunner(async (_m, launcher, args) => {
    expect(launcher).toBe('/plugins/herdr-projects/bin/run.sh')
    if (args[0] === 'show' && args[2] === '--') {
      calls.push(args)
      const mine = own[args[3]!]
      const level = ownEffort[args[3]!]
      return { code: 0, stdout: mine ? taskSettings(mine, 'task', 'this task', level) : taskSettings('claude', 'repo', 'your entry for demo', level), stderr: '' }
    }
    const id = args.at(-1)!
    if (args[0] === 'delegate' && args[1]?.startsWith('--worker.agent=')) own[id] = args[1].slice('--worker.agent='.length)
    if (args[0] === 'set' && args[3] === 'worker.agent') own[args[1]!.slice('--task='.length)] = args[4]!
    if (args[0] === 'unset' && args[3] === 'worker.agent') delete own[args[1]!.slice('--task='.length)]
    const effortArg = args[0] === 'delegate' ? args.find(a => a.startsWith('--worker.effort=')) : undefined
    if (effortArg) ownEffort[id] = effortArg.slice('--worker.effort='.length)
    if (args[0] === 'set' && args[3] === 'worker.effort') ownEffort[args[1]!.slice('--task='.length)] = args[4]!
    if (args[0] === 'unset' && args[3] === 'worker.effort') delete ownEffort[args[1]!.slice('--task='.length)]
    // 1.x refuses a model it does not take, and names those it does.
    if (args[0] === 'delegate' && args.includes('--worker.agent=codex/gpt-9')) return { code: 1, stdout: '', stderr: 'unknown model codex/gpt-9 for worker.agent.\nAccepted: codex/gpt-6-sol, codex/gpt-6-luna\n' }
    if (args[0] === 'models') {
      calls.push(args)
      if (args[1] === 'codex') return { code: 0, stdout: 'Models for codex:\ncodex/gpt-6-sol\ncodex/gpt-6-luna\nEffort (worker.effort and the like): low, high, ultra; gpt-6-luna only low, high.\n', stderr: '' }
      if (args[1] === 'claude') return { code: 0, stdout: '', stderr: '' }
      return { code: 2, stdout: '', stderr: `error: unknown agent ${args[1]}` }
    }
    if (args[0] === 'show') {
      shows.push(args)
      await new Promise(r => setTimeout(r, showDelay))
      const repo = args[1]!.replace('--repo=', '')
      return { code: 0, stdout: JSON.stringify({ settings: [{ name: 'repo.key', value: keysOf[repo] ?? 'none', note: '' }], problems: [] }), stderr: '' }
    }
    calls.push(args)
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(r => setTimeout(r, delay))
    active--
    if (args[0] === 'list') return listReply || { code: 0, stdout: fixture('list.json'), stderr: '' }
    // A failed task's details say what failed (1.2.1 failure_of): demo/6 its agent, demo/7 its setup.
    if (args[0] === 'details' && detailsReply) return { code: 0, stdout: detailsReply, stderr: '' }
    if (args[0] === 'details' && (args[3] === 'demo/6' || args[3] === 'demo/7')) {
      return { code: 0, stdout: JSON.stringify({ task: { id: args[3], title: 'Broke', stage: 'failed' }, failure: { stage: args[3] === 'demo/6' ? 'agent' : 'setup', title: 'Failed', detail: 'x', auth: false } }), stderr: '' }
    }
    if (args[0] === 'details') return { code: 0, stdout: fixture('details-approval.json'), stderr: '' }
    if (args[0] === 'coordinator' && args.at(-1) === 'status') {
      const flag = args.length > 3 ? args[1]! : ''
      return { code: 0, stdout: JSON.stringify({ name: 'x', agent: 'claude', ...(coordStatus[flag] || { state: 'none', pane: '' }) }), stderr: '' }
    }
    if (args[0] === 'approve') return { code: 1, stdout: '', stderr: 'demo/1: its pull request\'s checks failed\nmore' }
    // 1.x refuses a wait in a circle, and says so (after.rs checked).
    if (args[0] === 'delegate' && args.includes('--after=demo/5')) return { code: 1, stdout: '', stderr: 'DEMO-5 cannot wait for that: tasks would wait on each other (DEMO-5 → DEMO-5). Nothing was changed.' }
    return { code: 0, stdout: `${args[args.length - 2]}: sent\n`, stderr: '' }
  })
})
afterEach(() => {
  vi.useRealTimers()
  T.setRunner(null)
})

type Board = { version: string, machines: { machine: string, status: string, tasks: { id: string, group: string }[], at?: number, error?: string, stale?: boolean }[] }
const read = async (since?: string) => (await T.readTasksBoard(since)) as Board

describe('the Board read', () => {
  it('lists every machine\'s tasks, then reuses the list for a few seconds', async () => {
    const r = await read()
    expect(r.machines[0]).toMatchObject({ machine: '', status: 'ready', version: '1.2.1', at: clock })
    expect(r.machines[0]!.tasks).toHaveLength(4)
    expect(calls).toEqual([['list', '--json']])
    expect(await T.readTasksBoard(r.version)).toEqual({ same: true, version: r.version })
    expect(calls).toHaveLength(1)
    later(T.REUSE_MS + 1)
    await read()
    expect(calls).toHaveLength(2)
  })

  it('one board per machine: its named sessions add no second list nor second read', async () => {
    const r = await read()
    expect(r.machines.map(m => m.machine)).toEqual([''])
    expect(calls).toEqual([['list', '--json']])
  })

  it('checks the plugin afresh when the Board opens, not on every poll', async () => {
    infoAsked.length = 0
    const r = await read()
    await read(r.version)
    // Fresh once, when the Board opens; the poll and the command's launcher use the cache.
    expect(infoAsked[0]).toBe(true)
    expect(infoAsked.slice(1).every(f => !f)).toBe(true)
  })

  it('a machine without herdr-projects 1.2.1 runs nothing and says so', async () => {
    info.status = 'old'
    const r = await read()
    expect(r.machines[0]).toMatchObject({ status: 'old', tasks: [] })
    expect(calls).toEqual([])
  })
})

describe('a read that fails is said, with the last tasks dated and marked', () => {
  it('a refusal or a time-out, before any good read: the error, no tasks', async () => {
    T.setRunner(async (_m, _l, args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'herdr-projects did not answer within 30 s' } })
    const r = await read()
    expect(r.machines[0]).toMatchObject({ status: 'ready', tasks: [], error: 'herdr-projects did not answer within 30 s' })
    expect(r.machines[0]!.stale).toBeFalsy()
  })

  it('output that is not the list: the error, and the tasks of the last good read, marked with when', async () => {
    const good = await read()
    const goodAt = good.machines[0]!.at
    later(T.REUSE_MS + 1)
    listReply = { code: 0, stdout: 'Not JSON at all', stderr: '' }
    const r = await read()
    expect(r.machines[0]).toMatchObject({ error: 'herdr-projects list: not JSON', stale: true, at: goodAt })
    expect(r.machines[0]!.tasks).toHaveLength(4)
  })

  it('Herdr not answering for the plugin: the machine stays, with the error', async () => {
    await read()
    later(T.REUSE_MS + 1)
    infoFails = true
    const r = await read()
    expect(r.machines[0]).toMatchObject({ machine: '', status: 'error', error: 'Herdr did not answer', stale: true })
    expect(r.machines[0]!.tasks).toHaveLength(4)
  })
})

describe('a slow read: never an empty Board, and the client asked to come back soon', () => {
  afterEach(() => T.setReadWaits(null))
  type Pending = Board['machines'][number] & { pending?: boolean }

  it('a first read slower than the deadline is waited for, never answered empty', async () => {
    T.setReadWaits({ deadline: 30, first: 3000 })
    delay = 150
    const m = (await read()).machines[0] as Pending
    expect(m.tasks).toHaveLength(4)
    expect(m.stale).toBeFalsy()
  })

  it('past the deadline with an earlier list: that list, stale and pending', async () => {
    await read()
    later(T.REUSE_MS + 1)
    T.setReadWaits({ deadline: 30, first: 3000 })
    delay = 300
    const m = (await read()).machines[0] as Pending
    expect(m).toMatchObject({ stale: true, pending: true })
    expect(m.tasks).toHaveLength(4)
  })

  it('a first read slower than the longest wait: no tasks yet, pending', async () => {
    T.setReadWaits({ deadline: 30, first: 100 })
    delay = 400
    const m = (await read()).machines[0] as Pending
    expect(m).toMatchObject({ tasks: [], stale: true, pending: true })
  })

  it('repo keys slower than their short wait: the tasks first, pending, then named', async () => {
    keysOf = { demo: 'APP' }
    showDelay = 1500
    const first = (await read()).machines[0] as Pending & { tasks: { repoKey?: string }[] }
    expect(first.tasks).toHaveLength(4)
    expect(first.pending).toBe(true)
    expect(first.tasks.some(t => t.repoKey)).toBe(false)
    await vi.waitFor(() => expect(T.repoKeyOf('', 'demo')).toBe('APP'), { timeout: 3000 })
    T.resetTasksCache(true)
    const next = (await read()).machines[0] as Pending & { tasks: { repoKey?: string }[] }
    expect(next.pending).toBeUndefined()
    expect(next.tasks.every(t => t.repoKey === 'APP')).toBe(true)
  })

  it('a list reused while its keys are still read stays pending, so the Board asks again soon', async () => {
    keysOf = { demo: 'APP' }
    showDelay = 1500
    expect(((await read()).machines[0] as Pending).pending).toBe(true)
    // Within REUSE_MS: the same list, the keys still not read.
    const again = (await read()).machines[0] as Pending & { tasks: { repoKey?: string }[] }
    expect(again.pending).toBe(true)
    expect(again.tasks.some(t => t.repoKey)).toBe(false)
    await vi.waitFor(() => expect(T.repoKeyOf('', 'demo')).toBe('APP'), { timeout: 3000 })
    const named = (await read()).machines[0] as Pending & { tasks: { repoKey?: string }[] }
    expect(named.pending).toBeUndefined()
    expect(named.tasks.every(t => t.repoKey === 'APP')).toBe(true)
  })
})

describe('done tasks: when they were made', () => {
  it('a done task from `list --json` carries when it was made, read once from its file', async () => {
    listReply = { code: 0, stdout: JSON.stringify([
      { id: 'demo/9', state: 'done', title: 'Done late', stage: 'done' }, { id: 'demo/3', state: 'idle', title: 'To do', stage: 'todo' },
      { id: 'demo/2', state: 'done', title: 'No file', stage: 'done' },
    ]), stderr: '' }
    taskFile('demo/9', { title: 'Done late', stage: 'done', created: 5000 })
    taskFile('demo/3', { title: 'To do', stage: 'todo', created: 4000 })
    const r = await read()
    const byId = Object.fromEntries(r.machines[0]!.tasks.map(t => [t.id, t.created]))
    // Done only (the others are ordered by repo and number); no file, no time.
    expect(byId).toEqual({ 'demo/9': 5000, 'demo/3': undefined, 'demo/2': undefined })
    // Known: not read again, even when the file changes.
    taskFile('demo/9', { title: 'Done late', stage: 'done', created: 1 })
    later()
    const again = await read()
    expect(calls.filter(c => c[0] === 'list').length).toBe(2)
    expect(again.machines[0]!.tasks.find(t => t.id === 'demo/9')!.created).toBe(5000)
  })
})

describe('the global search source', () => {
  it('the Board\'s list, its keys and each description from the task files, read once', async () => {
    listReply = { code: 0, stdout: JSON.stringify([{ id: 'demo/4', state: 'idle', title: 'Login page', stage: 'todo' }, { id: 'demo/5', state: 'idle', title: 'Other', stage: 'todo' }]), stderr: '' }
    taskFile('demo/4', { title: 'Login page', stage: 'todo', description: 'The session cookie expires too early.' })
    const boards = await T.searchableBoards(5000)
    expect(boards).toEqual([{ machine: '', tasks: [
      { row: expect.objectContaining({ id: 'demo/4', repoKey: 'DEMO' }), description: 'The session cookie expires too early.' },
      { row: expect.objectContaining({ id: 'demo/5' }), description: '' },
    ] }])
    // Within the Board's reuse window: no second read.
    await T.searchableBoards(5000)
    expect(calls.filter(c => c[0] === 'list')).toHaveLength(1)
  })
})

describe('task identity across endpoints', () => {
  it('list and details retain the worker, reviewer and recorded takeover', async () => {
    const raw = { title: 'Improve search', stage: 'reviewing', agent: 'codex', app: 'claude', on: 'codex/gpt', handovers: [{ role: 'worker', from: 'claude', to: 'codex/gpt' }], link: { pane: 'w1:p1', reviewer: { pane: 'w1:p4', kind: 'omp' } } }
    taskFile('demo/1', raw)
    listReply = { code: 0, stdout: JSON.stringify([{ ...raw, id: 'demo/1' }]), stderr: '' }
    detailsReply = JSON.stringify({ task: { id: 'demo/1', ...raw } })
    const expected = { agent: 'codex', reviewer: 'omp', from: 'claude' }
    expect((await read()).machines[0]!.tasks[0]!.identity).toEqual(expected)
    expect((await T.taskDetails('', 'demo/1')).identity).toEqual(expected)
  })
})

describe('actions on a task', () => {
  it('puts the user\'s words after --, so they are never read as flags', async () => {
    await read()
    await T.tellTask('', 'demo/3', '--delegate now')
    await T.tellCoordinator('', '--now please')
    expect(calls.slice(1)).toEqual([['tell', '--', 'demo/3', '--delegate now'], ['coordinator', '--', 'tell', '--now please']])
  })

  it('a named session reaches its machine\'s board, in the same queue', async () => {
    await read()
    await T.tellTask(session.key, 'demo/3', 'from the review session')
    expect(calls.at(-1)).toEqual(['tell', '--', 'demo/3', 'from the review session'])
  })

  it('refuses what the task cannot take, before running anything', async () => {
    await read()
    calls = []
    await expect(T.tellTask('', 'demo/4', 'hi')).rejects.toThrow(/no agent/)
    await expect(T.approveTask('', 'demo/2')).rejects.toThrow(/does not wait/)
    await expect(T.tellTask('', '../x', 'hi')).rejects.toThrow(/Invalid task/)
    await expect(T.tellTask('', 'demo/2', 'hi')).rejects.toThrow(/no agent/)
    await expect(T.tellTask('', 'demo/3', '   ')).rejects.toThrow(/Nothing to send/)
    expect(calls).toEqual([])
  })

  it('gives the first line of a refusal', async () => {
    await read()
    await expect(T.approveTask('', 'demo/1')).rejects.toThrow('demo/1: its pull request\'s checks failed')
  })

  it('never offers the pane of another session: a task linked to a session wherdr has not opened', async () => {
    // Its file names the "other" session; w1:p1 there is not the w1:p1 of the default session.
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { socket: '/h/.config/herdr/sessions/other/herdr.sock', pane: 'w1:p1' } })
    panes.push({ id: 'w1:p1', machine: '', agent: 'claude', cwd: '/elsewhere' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
  })

  it('a link without a socket: the machine\'s own session, as herdr-projects reads it', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { pane: 'w1:p1' } })
    panes.push({ id: 'w1:p1', machine: '', agent: 'claude' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBe('w1:p1')
  })

  it('the pane of the session the task names, when wherdr has it open', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { socket: '/h/.config/herdr/sessions/review/herdr.sock', pane: 'w1:p1' } })
    panes.push({ id: 'w1:p1', machine: '', agent: 'claude' }, { id: 'abcd1234~w1:p1', machine: 'abcd1234', agent: 'claude' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBe('abcd1234~w1:p1')
  })

  // WHR-75: a reviewer that shows a dialog (1.x reviewneeds) waits on its own pane.
  it('names the reviewer\'s pane while a review runs, in the task\'s session', async () => {
    detailsReply = JSON.stringify({ task: { id: 'demo/1', title: 'Fix login redirect', stage: 'reviewneeds', msg: 'The reviewer shows a dialog: open it and answer' } })
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'reviewneeds', link: { pane: 'w1:p1', reviewer: { pane: 'w1:p4', tab: 'w1:t2', kind: 'codex' } } })
    panes.push({ id: 'w1:p1', machine: '', agent: 'claude' }, { id: 'w1:p4', machine: '', agent: 'codex' })
    expect(await T.taskDetails('', 'demo/1')).toMatchObject({ pane: 'w1:p1', reviewer: { pane: 'w1:p4' } })
    // In a named session wherdr has open: that session's pane.
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'reviewneeds', link: { socket: '/h/.config/herdr/sessions/review/herdr.sock', pane: 'w1:p1', reviewer: { pane: 'w1:p4' } } })
    expect((await T.taskDetails('', 'demo/1')).reviewer).toEqual({ pane: 'abcd1234~w1:p4' })
    // In a session wherdr has not opened: linked, but not reachable.
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'reviewneeds', link: { socket: '/h/.config/herdr/sessions/other/herdr.sock', pane: 'w1:p1', reviewer: { pane: 'w1:p4' } } })
    expect((await T.taskDetails('', 'demo/1')).reviewer).toEqual({ pane: null })
  })

  it('no reviewer outside a review, nor one with no pane named', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { pane: 'w1:p1', reviewer: { pane: 'w1:p4' } } })
    expect((await T.taskDetails('', 'demo/1')).reviewer).toBeNull()
    detailsReply = JSON.stringify({ task: { id: 'demo/1', title: 'Fix login redirect', stage: 'reviewing' } })
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'reviewing', link: { pane: 'w1:p1', reviewer: null } })
    expect((await T.taskDetails('', 'demo/1')).reviewer).toBeNull()
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'reviewing', link: { pane: 'w1:p1', reviewer: { pane: 'not a pane' } } })
    expect((await T.taskDetails('', 'demo/1')).reviewer).toBeNull()
  })

  it('no task file: no pane, even with a single agent in its worktree in the board\'s session', async () => {
    panes.push({ id: 'w5:p1', machine: '', agent: 'codex', cwd: '/home/user/code/demo-wt/1' })
    const d = await T.taskDetails('', 'demo/1')
    expect(d).toMatchObject({ id: 'demo/1', pane: null })
    expect(calls.at(-1)).toEqual(['details', '--json', '--', 'demo/1'])
  })

  it('an unreadable task file: no pane, even with a single agent in its worktree', async () => {
    taskFile('demo/1', {})
    writeFileSync(path.join(home, '.herdr-projects/data/tasks/demo/1/task.json'), '{ "link": { "pane": "w2:')
    panes.push({ id: 'w9:p1', machine: '', agent: 'codex', cwd: '/home/user/code/demo-wt/1' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
  })

  it('a task file without a link: no pane, even with a single agent in its worktree', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval' })
    panes.push({ id: 'w9:p1', machine: '', agent: 'codex', cwd: '/home/user/code/demo-wt/1' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: null })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
  })

  it('a link that is not a pane id: no pane, even with a single agent in its worktree', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { pane: 'not a pane' } })
    panes.push({ id: 'w9:p1', machine: '', agent: 'codex', cwd: '/home/user/code/demo-wt/1' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
  })

  it('a linked pane that is gone gives no pane, never another agent in the same worktree', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', link: { pane: 'w2:p1' } })
    // An unrelated agent, in another session, on the same folder.
    panes.push({ id: 'abcd1234~w8:p1', machine: 'abcd1234', agent: 'claude', cwd: '/home/user/code/demo-wt/1' })
    panes.push({ id: 'w9:p1', machine: '', agent: 'codex', cwd: '/home/user/code/demo-wt/1' })
    expect((await T.taskDetails('', 'demo/1')).pane).toBeNull()
  })

  it('the closing note comes from the task file, which 1.2.1 details leave it out of', async () => {
    taskFile('demo/1', { title: 'Fix login redirect', stage: 'approval', summary: 'Redirect fixed, two tests added.' })
    expect((await T.taskDetails('', 'demo/1')).summary).toBe('Redirect fixed, two tests added.')
  })

  it('runs one command at a time on a machine, whichever session asks', async () => {
    delay = 20
    vi.useRealTimers()
    await Promise.all([T.taskDetails('', 'demo/1'), T.tellCoordinator(session.key, 'a'), T.tellCoordinator('', 'b')])
    expect(maxActive).toBe(1)
  })
})

describe('the user\'s PATH for herdr-projects on this machine', () => {
  it('finds the agents in user folders, even from a login service\'s short PATH', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-launcher-'))
    try {
      mkdirSync(path.join(home, '.local/bin'), { recursive: true })
      mkdirSync(path.join(home, 'pd'), { recursive: true })
      writeFileSync(path.join(home, 'pd/env.json'), JSON.stringify({ PATH: '/login/only/bin' }))
      const env = T.launcherEnv(home, '/tmp/h.sock', { HERDR_PROJECTS_DATA_DIR: path.join(home, 'pd') })
      const dirs = String(env.PATH).split(':')
      expect(dirs).toContain(path.join(home, '.local/bin'))
      expect(dirs).toContain('/login/only/bin')
      expect(env).toMatchObject({ HERDR_BIN_PATH: 'herdr', NO_COLOR: '1', HERDR_SOCKET_PATH: '/tmp/h.sock' })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('the session on an SSH machine', () => {
  // The script as the remote shell runs it, with a launcher that says what it gets.
  const env = (name: string, extra: Record<string, string> = {}) => execFileSync('sh', ['-c', T.REMOTE_TASKS_SCRIPT, 'sh', '/opt/herdr', name, 'sh', '-c',
    'printf "%s|%s|%s|%s" "$HERDR_BIN_PATH" "${HERDR_SESSION-unset}" "${HERDR_SOCKET_PATH-unset}" "$1"', 'x', '--keep a'],
  { encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } })

  it('names the machine\'s own session, and never a forwarded socket', () => {
    expect(env('review', { HERDR_SOCKET_PATH: '/tmp/forwarded.sock' })).toBe('/opt/herdr|review|unset|--keep a')
  })
  it('completes the remote PATH first, as on this machine (not a login shell there)', async () => {
    const { USER_PATH_SH } = await import('../bin/lib/userpath.mjs')
    expect(T.REMOTE_TASKS_SCRIPT.startsWith(USER_PATH_SH)).toBe(true)
    const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-remote-'))
    try {
      mkdirSync(path.join(home, '.cargo/bin'), { recursive: true })
      const out = execFileSync('sh', ['-c', T.REMOTE_TASKS_SCRIPT, 'sh', '/opt/herdr', '', 'sh', '-c', 'printf %s "$PATH"'],
        { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } })
      expect(out.split(':')).toContain(path.join(home, '.cargo/bin'))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  it('the default session: none named', () => {
    expect(env('default', { HERDR_SESSION: 'stale' })).toBe('/opt/herdr|unset|unset|--keep a')
    expect(env('')).toBe('/opt/herdr|unset|unset|--keep a')
  })
})

describe('an agent in a user folder, from an SSH command', () => {
  it('is found by herdr-projects, and the arguments reach the launcher as they were', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-remote-'))
    try {
      const claude = path.join(home, '.local/bin/claude')
      mkdirSync(path.dirname(claude), { recursive: true })
      writeFileSync(claude, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 })
      // sshd's default PATH, without the user's own folders.
      const run = (session: string, cmd: string, ...args: string[]) => execFileSync('/bin/sh', ['-c', T.REMOTE_TASKS_SCRIPT, 'sh', '/opt/herdr', session, '/bin/sh', '-c', cmd, 'x', ...args],
        { encoding: 'utf8', env: { HOME: home, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } })
      expect(run('', 'command -v claude && claude --version')).toBe(`${claude}\n2.1.0 (Claude Code)\n`)
      expect(run('review', 'printf "%s|%s|%s" "$HERDR_BIN_PATH" "$HERDR_SESSION" "$1"', '$(id) --keep a')).toBe('/opt/herdr|review|$(id) --keep a')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('task keys', () => {
  it('names a task by its repo\'s key, asked once per repo with show --repo, and again after a while', async () => {
    keysOf = { demo: 'APP' }
    await read()
    await vi.waitFor(() => expect(shows).toEqual([['show', '--repo=demo', '--json']]))
    T.resetTasksCache(true)
    const r = await read()
    expect(r.machines[0]!.tasks.every(t => (t as { repoKey?: string }).repoKey === 'APP')).toBe(true)
    // Read again: the key is not asked again.
    T.resetTasksCache(true)
    await read()
    expect(shows).toHaveLength(1)
    expect(T.repoKeyOf('', 'demo')).toBe('APP')
  })
})

describe('archived tasks: their list, their sheet and Restore', () => {
  const board = JSON.stringify([
    { id: 'demo/4', state: 'done', title: 'Old cleanup', stage: 'done' },
    { id: 'demo/8', state: 'done', title: 'Put away', stage: 'done', archivedAt: 1760000000 },
    { id: 'demo/9', state: 'done', title: 'Put away later', stage: 'done', archivedAt: 1760000500 },
  ])
  beforeEach(() => { listReply = { code: 0, stdout: board, stderr: '' } })

  it('lists them with list --json --archived, newest first, and only them', async () => {
    const r = await T.archivedTasks('')
    expect(r.machine).toBe('')
    expect(r.tasks.map(t => [t.id, t.archived])).toEqual([['demo/9', true], ['demo/8', true]])
    expect(calls).toEqual([['list', '--json', '--archived']])
  })

  it('details say archived from the task file', async () => {
    taskFile('demo/8', { title: 'Put away', stage: 'done', archivedAt: 1760000000 })
    expect(await T.taskDetails('', 'demo/8')).toMatchObject({ archived: true })
    taskFile('demo/4', { title: 'Old cleanup', stage: 'done' })
    expect(await T.taskDetails('', 'demo/4')).toMatchObject({ archived: false })
  })

  it('restores an archived task (its file says so), and refuses one that is not', async () => {
    taskFile('demo/8', { title: 'Put away', stage: 'done', archivedAt: 1760000000 })
    taskFile('demo/4', { title: 'Old cleanup', stage: 'done' })
    await read()
    calls = []
    await T.taskCommand('', 'demo/8', 'restore')
    expect(calls).toEqual([['restore', '--', 'demo/8']])
    calls = []
    await expect(T.taskCommand('', 'demo/4', 'restore')).rejects.toThrow(/not archived/)
    expect(calls).toEqual([])
    // An archived task takes nothing else (1.x: "Restore it before making changes").
    await expect(T.taskCommand('', 'demo/8', 'archive')).rejects.toThrow(/cannot be archived/)
  })

  it('no task file: the archived list says whether it is archived', async () => {
    await T.taskCommand('', 'demo/9', 'restore')
    expect(calls).toEqual([['list', '--json', '--archived'], ['restore', '--', 'demo/9']])
  })
})

describe('start, stop, retry, archive, add, and the three coordinators', () => {
  // A board with a task of each kind these act on.
  const board = JSON.stringify([
    { id: 'demo/5', state: 'idle', title: 'In the backlog', stage: 'todo' },
    { id: 'demo/6', state: 'error', app: 'claude', title: 'Broke', stage: 'failed' },
    { id: 'demo/7', state: 'error', app: 'claude', title: 'Setup broke', stage: 'failed' },
    { id: 'demo/3', state: 'working', app: 'codex', title: 'Add dark mode toggle', stage: 'working' },
    { id: 'demo/4', state: 'done', title: 'Old cleanup', stage: 'done' },
  ])
  beforeEach(() => { listReply = { code: 0, stdout: board, stderr: '' } })

  it('runs each command with the task\'s id after --', async () => {
    await read()
    await T.taskCommand('', 'demo/5', 'delegate')
    await read()
    await T.taskCommand('', 'demo/3', 'stop')
    await read()
    await T.taskCommand('', 'demo/6', 'retry')
    await read()
    await T.taskCommand('', 'demo/4', 'archive')
    expect(calls.filter(c => c[0] !== 'list')).toEqual([['delegate', '--', 'demo/5'], ['stop', '--', 'demo/3'], ['details', '--json', '--', 'demo/6'], ['retry', '--', 'demo/6'], ['archive', '--', 'demo/4']])
  })

  // WHR-38, WHR-13: 1.x keeps an old failure on a task that has moved on.
  it('a failure the task moved on from is marked stale, and never sent to its agent', async () => {
    const at = 1_792_500_000_000
    listReply = { code: 0, stdout: JSON.stringify([{ id: 'demo/8', state: 'blocked', kind: 'question', app: 'claude', title: 'PR base', stage: 'asks', msg: 'Rebase on v2?' }]), stderr: '' }
    detailsReply = JSON.stringify({ task: { id: 'demo/8', title: 'PR base', stage: 'asks', msg: 'Rebase on v2?' }, failure: { stage: 'pr', title: 'The agent\'s pull request merges into another branch', detail: 'x', auth: false, agentCanFix: true, at } })
    taskFile('demo/8', { stage: 'asks', at: at + 120_000, armedAt: at + 56_000 })
    await read()
    expect(await T.taskDetails('', 'demo/8')).toMatchObject({ failureAt: at, failureStale: true })
    await expect(T.taskCommand('', 'demo/8', 'fix')).rejects.toThrow('This failure needs the human first')
    expect(calls.filter(c => c[0] === 'fix')).toEqual([])
    // The same failure, just recorded: current, sent.
    taskFile('demo/8', { stage: 'asks', at: at + 30 })
    expect(await T.taskDetails('', 'demo/8')).toMatchObject({ failureStale: false })
    await T.taskCommand('', 'demo/8', 'fix')
    expect(calls.filter(c => c[0] === 'fix')).toEqual([['fix', '--', 'demo/8']])
  })

  // WHR-85: `review <id>` sends a failed review back; refused on anything else.
  it('sends a failed review back to its agent, and only a failed one', async () => {
    const review = (pass: boolean) => ({ meets: false, pass, findings: [{ severity: 'major', subject: 'Missing test' }] })
    listReply = { code: 0, stdout: JSON.stringify([
      { id: 'demo/13', state: 'blocked', kind: 'permission', app: 'claude', title: 'Failed review', stage: 'approval', review: review(false) },
      { id: 'demo/14', state: 'blocked', kind: 'permission', app: 'claude', title: 'Passed review', stage: 'approval', review: review(true) },
    ]), stderr: '' }
    await read()
    await T.taskCommand('', 'demo/13', 'review')
    expect(calls.filter(c => c[0] === 'review')).toEqual([['review', '--', 'demo/13']])
    await read()
    await expect(T.taskCommand('', 'demo/14', 'review')).rejects.toThrow('This task has no failed review to send back')
    expect(calls.filter(c => c[0] === 'review')).toEqual([['review', '--', 'demo/13']])
  })

  it.each([['limit.time', '4h'], ['limit.tokens', '3m'], ['limit.tokens', 'none']])('sets only the chosen %s on the target machine and invalidates the list', async (name, value) => {
    const usedMachines: string[] = []
    T.setRunner(async (m, _launcher, args) => {
      calls.push(args)
      usedMachines.push(m.key)
      return { code: 0, stdout: args[0] === 'list' ? JSON.stringify([{ id: 'demo/10', stage: 'stopped', state: 'blocked' }]) : args[0] === 'details' ? JSON.stringify({ task: { id: 'demo/10' }, limits: { stopped: { what: name.slice(6) } } }) : 'Resuming', stderr: '' }
    })
    await T.raiseTaskLimit('remote', 'demo/10', name, value)
    expect(calls.filter(c => c[0] === 'set')).toEqual([['set', name, value, '--task', 'demo/10']])
    expect(calls.some(c => c[0] === 'retry')).toBe(false)
    expect(usedMachines.every(m => m === 'remote')).toBe(true)
    await T.taskCommand('remote', 'demo/10', 'retry')
    expect(calls.filter(c => c[0] === 'list')).toHaveLength(2)
  })

  it.each(['tokens', undefined])('refuses a ceiling that cannot lift a %s stop before changing settings', async stopped => {
    T.setRunner(async (_m, _launcher, args) => {
      calls.push(args)
      return { code: 0, stderr: '', stdout: args[0] === 'list'
        ? JSON.stringify([{ id: 'demo/10', stage: 'stopped', state: 'blocked' }])
        : JSON.stringify({ task: { id: 'demo/10' }, limits: { stopped: { what: stopped } } }) }
    })
    await expect(T.raiseTaskLimit('remote', 'demo/10', 'limit.time', '4h')).rejects.toThrow('Invalid settings')
    expect(calls.some(c => c[0] === 'set' || c[0] === 'retry')).toBe(false)
  })

  it('exposes a CLI refusal and rejects unrelated settings and provider quota waits', async () => {
    T.setRunner(async (_m, _launcher, args) => {
      calls.push(args)
      if (args[0] === 'details') return { code: 0, stdout: JSON.stringify({ task: { id: 'demo/10' }, limits: { stopped: { what: 'time' } } }), stderr: '' }
      return args[0] === 'list'
        ? { code: 0, stdout: JSON.stringify([{ id: 'demo/10', stage: 'stopped', state: 'blocked' }, { id: 'demo/11', stage: 'asks', state: 'blocked', msg: 'Provider quota' }]), stderr: '' }
        : { code: 1, stdout: '', stderr: 'Invalid duration: choose 4h' }
    })
    await expect(T.raiseTaskLimit('', 'demo/10', 'limit.time', 'bad')).rejects.toThrow('Invalid duration: choose 4h')
    await expect(T.raiseTaskLimit('', 'demo/11', 'limit.tokens', '3m')).rejects.toThrow()
    await expect(T.raiseTaskLimit('', 'demo/10', 'merge.by', 'itself')).rejects.toThrow()
    expect(calls.filter(c => c[0] === 'set')).toHaveLength(1)
    expect(calls.some(c => c[0] === 'retry')).toBe(false)
  })

  it('Finish takes the work as it is where 1.x finish does, and is refused elsewhere', async () => {
    listReply = { code: 0, stdout: JSON.stringify([
      { id: 'demo/10', state: 'blocked', app: 'claude', title: 'Limit', stage: 'stopped', msg: 'Stopped at its 2h limit' },
      { id: 'demo/11', state: 'working', app: 'claude', title: 'Stuck', stage: 'working', msg: 'Finishing' },
      { id: 'demo/12', state: 'working', app: 'claude', title: 'Busy', stage: 'working', msg: 'Running tests' },
    ]), stderr: '' }
    await read()
    await T.taskCommand('', 'demo/10', 'finish')
    await read()
    await T.taskCommand('', 'demo/11', 'finish')
    await read()
    await expect(T.taskCommand('', 'demo/12', 'finish')).rejects.toThrow('This task has nothing to finish as it is')
    expect(calls.filter(c => c[0] === 'finish')).toEqual([['finish', '--', 'demo/10'], ['finish', '--', 'demo/11']])
  })

  it('finishes a waiting conversation on its own machine, without approval', async () => {
    listReply = { code: 0, stdout: JSON.stringify([
      { id: 'demo/20', chat: true, state: 'blocked', app: 'codex', stage: 'asks' },
      { id: 'demo/21', chat: true, state: 'working', app: 'codex', stage: 'working' },
      { id: 'demo/22', chat: true, state: 'done', app: 'codex', stage: 'done' },
      { id: 'demo/23', chat: true, state: 'blocked', app: 'codex', stage: 'approval' },
    ]), stderr: '' }
    const sent: Array<{ machine: string, args: string[] }> = []
    T.setRunner(async (m, _launcher, args) => {
      sent.push({ machine: m.key, args })
      return args[0] === 'list' ? listReply : { code: 0, stdout: 'Conversation ended', stderr: '' }
    })
    await T.taskCommand('remote', 'demo/20', 'finish')
    expect(sent).toContainEqual({ machine: 'remote', args: ['finish', '--', 'demo/20'] })
    for (const id of ['demo/21', 'demo/22']) await expect(T.taskCommand('remote', id, 'finish')).rejects.toThrow('nothing to finish')
    await expect(T.approveTask('remote', 'demo/23')).rejects.toThrow('does not wait for approval')
  })

  // The task's worker.agent as 1.x resolves it now.
  const resolved = async (id: string) => { const before = calls.length; const o = await T.taskStartOptions('', id); calls.splice(before); return o.agent }
  // herdr-projects keeps the list a moment: an action dropped it, the next read is fresh.
  const settle = async () => { later(T.REUSE_MS + 1); await read(); await new Promise(r => setTimeout(r, 20)) }
  const working = (id: string) => JSON.stringify(JSON.parse(board).map((t: { id: string }) => (t.id === id ? { ...t, state: 'working', app: 'codex', stage: 'working' } : t)))

  it('Start with another agent: passed for this start only; the task\'s default comes back once the run is over', async () => {
    await read()
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    expect(calls).toEqual([['show', '--json', '--', 'demo/5'], ['delegate', '--worker.agent=codex', '--', 'demo/5']])
    // 1.x keeps it as the task's own setting while the run lasts (a restart of its agent reads it again).
    expect(own['demo/5']).toBe('codex')
    listReply = { code: 0, stdout: working('demo/5'), stderr: '' }
    await settle()
    expect(own['demo/5']).toBe('codex')
    expect(calls.some(c => c[0] === 'unset' || c[0] === 'set')).toBe(false)
    // The run is over (back in the backlog): what the task had is put back.
    listReply = { code: 0, stdout: board, stderr: '' }
    calls = []
    await settle()
    await vi.waitFor(() => expect(own['demo/5']).toBeUndefined())
    expect(calls).toContainEqual(['unset', '--task=demo/5', '--', 'worker.agent'])
    expect(await resolved('demo/5')).toMatchObject({ value: 'claude', place: 'repo' })
    // Nothing left to put back: the next plain Start runs alone.
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate')
    expect(calls.filter(c => c[0] !== 'list')).toEqual([['delegate', '--', 'demo/5']])
  })

  it('done: the default comes back too', async () => {
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    listReply = { code: 0, stdout: JSON.stringify(JSON.parse(board).map((t: { id: string }) => (t.id === 'demo/5' ? { ...t, state: 'done', stage: 'done' } : t))), stderr: '' }
    await settle()
    await vi.waitFor(() => expect(own['demo/5']).toBeUndefined())
  })

  it('the next Start (and what Start offers) puts the default back first, whatever the list said', async () => {
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    // What Start offers: the task's own default, not the earlier pick.
    expect(await resolved('demo/5')).toMatchObject({ value: 'claude', place: 'repo' })
    expect(own['demo/5']).toBeUndefined()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    await read()
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate')
    expect(calls.filter(c => c[0] !== 'list')).toEqual([
      ['show', '--json', '--', 'demo/5'], ['unset', '--task=demo/5', '--', 'worker.agent'], ['delegate', '--', 'demo/5'],
    ])
    expect(own['demo/5']).toBeUndefined()
  })

  it('a task with its own agent gets it back (set), and a value someone set since is left alone', async () => {
    own['demo/5'] = 'pi'
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    expect(await resolved('demo/5')).toMatchObject({ value: 'pi', place: 'task' })
    // Picked again, then changed by hand meanwhile: that choice stays.
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    own['demo/5'] = 'claude'
    calls = []
    expect(await T.taskStartOptions('', 'demo/5')).toMatchObject({ agent: { value: 'claude', place: 'task' } })
    expect(calls.some(c => c[0] === 'set' || c[0] === 'unset')).toBe(false)
  })

  it('picking the agent the task already has as its own changes nothing to put back', async () => {
    own['demo/5'] = 'codex'
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    expect(await resolved('demo/5')).toMatchObject({ value: 'codex', place: 'task' })
  })

  it('kept across a restart of wherdr (its data folder)', async () => {
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex')
    expect(JSON.parse(readFileSync(path.join(home, 'wherdr-data/start-agents.json'), 'utf8'))['|demo/5']).toMatchObject({ agent: 'codex', prev: null })
    SA.resetStartAgents()
    expect(await resolved('demo/5')).toMatchObject({ value: 'claude', place: 'repo' })
    expect(JSON.parse(readFileSync(path.join(home, 'wherdr-data/start-agents.json'), 'utf8'))).toEqual({})
  })

  it('no agent picked: nothing is written down nor put back', async () => {
    await read()
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate', '')
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', null)
    expect(calls.filter(c => c[0] !== 'list')).toEqual([['delegate', '--', 'demo/5'], ['delegate', '--', 'demo/5']])
    expect(await SA.startAgentsOf('')).toEqual([])
  })

  it('refuses an agent not installed on the task\'s machine, a malformed one, or one on another command, before running anything', async () => {
    await read()
    calls = []
    await expect(T.taskCommand('', 'demo/5', 'delegate', 'pi')).rejects.toThrow('pi is not installed on devbox')
    await expect(T.taskCommand('', 'demo/5', 'delegate', '--now')).rejects.toThrow(/is not installed/)
    await expect(T.taskCommand('', 'demo/5', 'delegate', 'codex --merge.by=itself')).rejects.toThrow(/is not installed/)
    await expect(T.taskCommand('', 'demo/5', 'delegate', { kind: 'codex' })).rejects.toThrow(/is not installed/)
    await expect(T.taskCommand('', 'demo/3', 'stop', 'codex')).rejects.toThrow(/Only Start takes an agent/)
    expect(calls).toEqual([])
  })

  it('Start with a model and an effort: both for this start only, put back once the run is over', async () => {
    await read()
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate', 'codex/gpt-6-sol', null, 'ultra')
    expect(calls).toEqual([['show', '--json', '--', 'demo/5'], ['delegate', '--worker.agent=codex/gpt-6-sol', '--worker.effort=ultra', '--', 'demo/5']])
    expect([own['demo/5'], ownEffort['demo/5']]).toEqual(['codex/gpt-6-sol', 'ultra'])
    calls = []
    expect(await resolved('demo/5')).toMatchObject({ value: 'claude', place: 'repo' })
    expect([own['demo/5'], ownEffort['demo/5']]).toEqual([undefined, undefined])
    // The program of a model is what must be installed; a malformed effort is refused first.
    await read()
    calls = []
    await expect(T.taskCommand('', 'demo/5', 'delegate', 'pi/openai/gpt-5')).rejects.toThrow('pi is not installed on devbox')
    await expect(T.taskCommand('', 'demo/5', 'delegate', 'codex/gpt-6-sol', null, '--now')).rejects.toThrow('Invalid effort')
    await expect(T.taskCommand('', 'demo/3', 'stop', null, null, 'low')).rejects.toThrow('Invalid effort')
    expect(calls).toEqual([])
  })

  it('a model the CLI does not take: its refusal, every line, as it says it', async () => {
    await read()
    await expect(T.taskCommand('', 'demo/5', 'delegate', 'codex/gpt-9')).rejects.toThrow('unknown model codex/gpt-9 for worker.agent.\nAccepted: codex/gpt-6-sol, codex/gpt-6-luna')
  })

  it('a model on another machine: the command runs there', async () => {
    const sent: Array<{ machine: string, args: string[] }> = []
    T.setRunner(async (m, _launcher, args) => {
      sent.push({ machine: m.key, args })
      if (args[0] === 'list') return { code: 0, stdout: board, stderr: '' }
      if (args[0] === 'show') return { code: 0, stdout: taskSettings('claude', 'repo', 'x'), stderr: '' }
      if (args[0] === 'models') return { code: 0, stdout: 'codex/gpt-6-sol\n', stderr: '' }
      return { code: 0, stdout: 'started', stderr: '' }
    })
    await T.readTasksBoard()
    expect((await T.taskStartModels('remote', 'codex')).models).toEqual(['gpt-6-sol'])
    await T.taskCommand('remote', 'demo/5', 'delegate', 'codex/gpt-6-sol', null, 'high')
    expect(sent).toContainEqual({ machine: 'remote', args: ['models', 'codex'] })
    expect(sent).toContainEqual({ machine: 'remote', args: ['delegate', '--worker.agent=codex/gpt-6-sol', '--worker.effort=high', '--', 'demo/5'] })
  })

  it('models <program>: read once per machine and program, read again on demand; nothing read is not kept', async () => {
    calls = []
    const m = await T.taskStartModels('', 'codex')
    expect(m).toEqual({ program: 'codex', models: ['gpt-6-sol', 'gpt-6-luna'], efforts: ['low', 'high', 'ultra'], only: [{ models: ['gpt-6-luna'], levels: ['low', 'high'] }] })
    await T.taskStartModels('', 'codex')
    expect(calls).toEqual([['models', 'codex']])
    await T.taskStartModels('', 'codex', true)
    expect(calls).toHaveLength(2)
    expect((await T.taskStartModels('', 'claude')).models).toEqual([])
    await T.taskStartModels('', 'claude')
    expect(calls.filter(c => c[1] === 'claude')).toHaveLength(2)
    await expect(T.taskStartModels('', 'gemini')).rejects.toThrow('error: unknown agent gemini')
    await expect(T.taskStartModels('', '--now')).rejects.toThrow('Invalid agent')
    await expect(T.taskStartModels('', 'codex/x')).rejects.toThrow('Invalid agent')
  })

  it('what Start offers: the task\'s worker.agent as show resolves it, and the installed agents', async () => {
    installed = ['claude', 'codex', 'omp']
    expect(await T.taskStartOptions('', 'demo/5')).toEqual({
      agent: { value: 'claude', kind: 'claude', place: 'repo', from: 'your entry for demo' },
      agents: ['claude', 'codex', 'omp'],
      slots: null,
    })
    expect(calls).toEqual([['show', '--json', '--', 'demo/5']])
    await expect(T.taskStartOptions('', '../x')).rejects.toThrow(/Invalid task/)
  })

  // Queue: board.agents (the same show) against the tasks in a slot stage on the list.
  it('Start options say the board\'s slots: board.agents, the tasks at work and those queued', async () => {
    boardAgents = 2
    listReply = { code: 0, stdout: JSON.stringify([
      ...JSON.parse(board),
      { id: 'demo/20', state: 'working', app: 'claude', title: 'Reviewing', stage: 'reviewing' },
      { id: 'demo/21', state: 'working', title: 'Queued', stage: 'queued', queue: 1 },
      { id: 'demo/22', state: 'working', title: 'Waits', stage: 'after' },
    ]), stderr: '' }
    await read()
    calls = []
    expect((await T.taskStartOptions('', 'demo/5')).slots).toEqual({ max: 2, busy: 2, waiting: 1 })
    // The list just read is reused: one show, no list.
    expect(calls).toEqual([['show', '--json', '--', 'demo/5']])
  })

  it('Start after…: delegate --after with the tasks named, checked first; the board\'s refusal is said as it is', async () => {
    await read()
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate', null, ['DEMO-3', 'vm-str:ELA-3', 'demo/4'])
    expect(calls.filter(c => c[0] === 'delegate')).toEqual([['delegate', '--after=DEMO-3,vm-str:ELA-3,demo/4', '--', 'demo/5']])
    await read()
    await T.taskCommand('', 'demo/5', 'delegate', 'codex', ['DEMO-3'])
    expect(calls.filter(c => c[0] === 'delegate').at(-1)).toEqual(['delegate', '--worker.agent=codex', '--after=DEMO-3', '--', 'demo/5'])
    await read()
    await expect(T.taskCommand('', 'demo/5', 'delegate', null, ['demo/5'])).rejects.toThrow('DEMO-5 cannot wait for that: tasks would wait on each other (DEMO-5 → DEMO-5). Nothing was changed.')
    calls = []
    for (const bad of [['--now'], ['DEMO-3 --merge.by=itself'], [], 'DEMO-3', [3], Array.from({ length: 21 }, (_, i) => `DEMO-${i + 1}`)]) {
      await expect(T.taskCommand('', 'demo/5', 'delegate', null, bad)).rejects.toThrow('Invalid tasks to wait for')
    }
    await expect(T.taskCommand('', 'demo/3', 'stop', null, ['DEMO-4'])).rejects.toThrow('Invalid tasks to wait for')
    expect(calls).toEqual([])
  })

  it('Stop waiting: after --clear on the task', async () => {
    listReply = { code: 0, stdout: JSON.stringify([...JSON.parse(board), { id: 'demo/22', state: 'working', title: 'Waits', stage: 'after' }]), stderr: '' }
    await read()
    calls = []
    expect(await T.clearTaskAfter('', 'demo/22')).toEqual({ ok: true, msg: '--: sent' })
    expect(calls).toEqual([['after', '--clear', '--', 'demo/22']])
    await expect(T.clearTaskAfter('', 'demo/99')).rejects.toThrow('This task does not wait for other tasks')
    await expect(T.clearTaskAfter('', '../x')).rejects.toThrow('Invalid task')
  })

  it('a failed task: what failed (details) decides between Retry and Start, as 1.2.1 send_error does', async () => {
    await read()
    calls = []
    // Its setup failed, no agent ever on it: retry is refused, Start runs.
    await expect(T.taskCommand('', 'demo/7', 'retry')).rejects.toThrow(/nothing to retry/)
    await T.taskCommand('', 'demo/7', 'delegate')
    // Its agent failed: Start is refused, Retry is not.
    await read()
    await expect(T.taskCommand('', 'demo/6', 'delegate')).rejects.toThrow(/cannot be started/)
    expect(calls.filter(c => c[0] !== 'list' && c[0] !== 'details')).toEqual([['delegate', '--', 'demo/7']])
  })

  it('right after another action (the list dropped): reads the list again, then acts', async () => {
    await read()
    await T.addTask('', { title: 'New one' })
    calls = []
    await T.taskCommand('', 'demo/5', 'delegate')
    expect(calls).toEqual([['list', '--json'], ['delegate', '--', 'demo/5']])
  })

  it('refuses what does not apply to the task, or an unknown command, before running anything', async () => {
    await read()
    calls = []
    await expect(T.taskCommand('', 'demo/3', 'delegate')).rejects.toThrow(/cannot be started/)
    await expect(T.taskCommand('', 'demo/5', 'stop')).rejects.toThrow(/no agent at work to stop/)
    await expect(T.taskCommand('', 'demo/3', 'archive')).rejects.toThrow(/cannot be archived/)
    await expect(T.taskCommand('', 'demo/4', 'retry')).rejects.toThrow(/nothing to retry/)
    await expect(T.taskCommand('', 'demo/5', 'clear')).rejects.toThrow(/Unknown action/)
    await expect(T.taskCommand('', 'demo/99', 'archive')).rejects.toThrow(/cannot be archived/)
    expect(calls).toEqual([])
  })

  it('adds a task: flags as --flag=value, the title after --; a bad repo runs nothing', async () => {
    await T.addTask('', { title: '  --fix\nthe login ', description: '--desc trick', repo: 'wherdr', delegate: true })
    await T.addTask('', { title: 'In the home folder' })
    await T.addTask('', { title: 'By its folder', repo: '~/code/app' })
    expect(calls).toEqual([
      ['add', '--desc=--desc trick', '--repo=wherdr', '--delegate', '--', '--fix the login'],
      ['add', '--', 'In the home folder'],
      ['add', '--repo=~/code/app', '--', 'By its folder'],
    ])
    calls = []
    await expect(T.addTask('', { title: 'x', repo: '--all' })).rejects.toThrow(/Invalid repo/)
    await expect(T.addTask('', { title: '   ' })).rejects.toThrow(/title/)
    expect(calls).toEqual([])
  })

  it.each(['', session.key, 'remote'])('routes all new task types to the owner of %s', async key => {
    const seen: { machine: string, args: string[] }[] = []
    T.setRunner(async (m, _launcher, args) => {
      seen.push({ machine: m.key, args })
      return { code: 0, stdout: 'Added', stderr: '' }
    })
    for (const type of ['work', 'research', 'chat']) {
      await T.addTask(key, { title: 'Typed task', repo: 'demo', type, planApprove: 'reviewer', delegate: true })
      expect(seen.at(-1)).toEqual({ machine: key === 'remote' ? 'remote' : '', args: ['add', ...(type === 'work' ? [] : [type === 'research' ? '--research' : '--chat']), '--repo=demo', '--delegate', '--plan.approve=reviewer', '--', 'Typed task'] })
    }
  })

  it('passes only explicit plan approval settings, with every type and delegation mode', async () => {
    for (const type of ['work', 'research', 'chat']) {
      for (const delegate of [false, true]) {
        for (const planApprove of [undefined, 'you', 'reviewer']) {
          await T.addTask('', { title: 'Plan task', type, delegate, planApprove })
          expect(calls.at(-1)).toEqual(['add', ...(type === 'work' ? [] : [type === 'research' ? '--research' : '--chat']), ...(delegate ? ['--delegate'] : []), ...(planApprove ? [`--plan.approve=${planApprove}`] : []), '--', 'Plan task'])
        }
      }
    }
    calls = []
    for (const planApprove of [null, '', 'inherit', 'none', 'YOU', 'you; touch injected', [], {}, true, 42]) {
      await expect(T.addTask('', { title: 'Invalid', planApprove })).rejects.toThrow('Invalid plan approval')
    }
    expect(calls).toEqual([])
  })

  it('validates task types before invoking add', async () => {
    for (const type of ['work', 'research', 'chat']) {
      for (const delegate of [false, true]) {
        await T.addTask('', { title: 'Typed task', repo: 'demo', type, delegate })
        expect(calls.at(-1)).toEqual(['add', ...(type === 'work' ? [] : [type === 'research' ? '--research' : '--chat']), '--repo=demo', ...(delegate ? ['--delegate'] : []), '--', 'Typed task'])
      }
    }
    calls = []
    for (const type of [null, '', 'plan', ['research', 'chat'], {}, false, 42]) {
      await expect(T.addTask('', { title: 'Invalid', type })).rejects.toThrow('Invalid task type')
    }
    expect(calls).toEqual([])
  })

  it('talks to the Coordinator, the machine coordinator or a project coordinator, with Send and start', async () => {
    await T.tellCoordinator('', 'plain')
    await T.tellCoordinator('', 'and start', { delegate: true })
    await T.tellCoordinator('', 'machine', { to: { kind: 'machine' } })
    await T.tellCoordinator('', '--repo', { to: { kind: 'project', repo: 'wherdr' }, delegate: true })
    expect(calls).toEqual([
      ['coordinator', '--', 'tell', 'plain'],
      ['coordinator', '--delegate', '--', 'tell', 'and start'],
      ['coordinator', '--machine', '--', 'tell', 'machine'],
      ['coordinator', '--project=wherdr', '--delegate', '--', 'tell', '--repo'],
    ])
    calls = []
    await expect(T.tellCoordinator('', 'x', { to: { kind: 'project', repo: '../etc' } })).rejects.toThrow(/Invalid coordinator/)
    expect(calls).toEqual([])
  })

  it('opens and tells a known repo by its coordinator key without creating another conversation', async () => {
    const to = { kind: 'project', repo: 'demo' }
    // The CLI keys coordinators by the --project value: a root path is a different key.
    coordStatus = { '--project=demo': { state: 'idle', pane: 'w2:p1' } }
    panes.push({ id: 'w2:p1', machine: '', name: 'sw-coordinator-demo' })
    expect((await T.coordinatorPane('', to)).pane).toBe('w2:p1')
    await T.tellCoordinator('', 'Continue the project', { to, start: { agent: 'codex' } })
    expect(calls).toEqual([
      ['coordinator', '--project=demo', '--json', 'status'],
      ['coordinator', '--project=demo', '--json', 'status'],
      ['coordinator', '--project=demo', '--', 'tell', 'Continue the project'],
    ])
  })

  // herdr-projects names a project coordinator by its repo's name on the board, never a path:
  // a folder it does not know is added first (`automations add --repo`, removed at once: no task).
  describe('a project coordinator on a folder', () => {
    const reposFile = () => path.join(home, '.herdr-projects/data/repos.json')
    const repos = (o: Record<string, string>) => { mkdirSync(path.dirname(reposFile()), { recursive: true }); writeFileSync(reposFile(), JSON.stringify(o)) }
    const gitRepo = (name: string) => {
      const dir = path.join(home, 'code', name)
      mkdirSync(dir, { recursive: true })
      execFileSync('git', ['init', '-q', dir])
      return dir
    }
    // `automations add --repo=<root>`: the repo named on first sight, as 1.2.26 does (store/repos.rs repo_of).
    const automations = new Set<string>()
    beforeEach(() => {
      automations.clear()
      T.setRunner(async (_m, _l, args) => {
        calls.push(args)
        if (args[0] === 'automations' && args[1] === 'add') {
          const root = args.find(a => a.startsWith('--repo='))!.slice('--repo='.length)
          const now = existsSync(reposFile()) ? JSON.parse(readFileSync(reposFile(), 'utf8')) : {}
          now[path.basename(root).replace(/[^\w.+-]/g, '-')] = root
          repos(now)
          automations.add(args.at(-1)!)
          return { code: 0, stdout: `Added the automation "${args.at(-1)}"\n`, stderr: '' }
        }
        if (args[0] === 'automations' && args[1] === 'remove') { automations.delete(args.at(-1)!); return { code: 0, stdout: 'Removed\n', stderr: '' } }
        if (args[0] === 'coordinator' && args.at(-1) === 'status') return { code: 0, stdout: JSON.stringify({ state: 'none', pane: '' }), stderr: '' }
        return { code: 0, stdout: 'sent\n', stderr: '' }
      })
    })

    it('says whether a folder is on the board, new, missing or not Git', async () => {
      const app = gitRepo('app')
      const site = gitRepo('my site')
      mkdirSync(path.join(app, 'src'), { recursive: true })
      mkdirSync(path.join(home, 'notes'), { recursive: true })
      repos({ app })
      expect(await T.projectFolder('', path.join(app, 'src'))).toEqual({ state: 'known', repo: 'app', root: app })
      expect(await T.projectFolder('', site)).toEqual({ state: 'new', repo: 'my-site', root: site })
      expect(await T.projectFolder('', path.join(home, 'notes'))).toEqual({ state: 'notgit' })
      expect(await T.projectFolder('', path.join(home, 'nowhere'))).toEqual({ state: 'missing' })
      await expect(T.projectFolder('', 'app')).rejects.toThrow(/Invalid repo/)
      expect(calls).toEqual([])
    })

    it('adds an unknown repo with no task, then starts its coordinator by name', async () => {
      const hub = gitRepo('hub')
      const r = await T.tellCoordinator('', '--hello', { to: { kind: 'project', repo: hub }, start: { agent: 'codex/demo-model', effort: 'high' } })
      expect(r.repo).toBe('hub')
      const name = calls[0]!.at(-1)!
      expect(name).toMatch(/^wherdr-add-repo-[0-9a-f]{8}$/)
      expect(calls).toEqual([
        ['automations', 'add', '--prompt=Never runs: wherdr adds this repository to the board and removes this automation at once.', '--when=merged', `--repo=${hub}`, '--', name],
        ['automations', 'remove', '--', name],
        ['coordinator', '--project=hub', '--json', 'status'],
        ['coordinator', '--project=hub', '--agent=codex/demo-model', '--effort=high', '--', 'new'],
        ['coordinator', '--project=hub', '--', 'tell', '--hello'],
      ])
      // No task was made (no "added" event), and the automation is gone.
      expect(calls.some(c => c[0] === 'add')).toBe(false)
      expect(automations.size).toBe(0)
      // Known now: nothing is added again.
      calls = []
      expect(await T.registerProject('', hub)).toEqual({ repo: 'hub', root: hub, added: false })
      expect(calls).toEqual([])
    })

    it('refuses a missing or non-Git folder with a clear message, running nothing', async () => {
      mkdirSync(path.join(home, 'plain'), { recursive: true })
      await expect(T.registerProject('', path.join(home, 'plain'))).rejects.toThrow('This folder is not a Git repository')
      await expect(T.tellCoordinator('', 'hi', { to: { kind: 'project', repo: path.join(home, 'gone') } })).rejects.toThrow('This folder does not exist on this machine.')
      expect(calls).toEqual([])
    })

    it('says so when the automation that added it could not be removed', async () => {
      const lib = gitRepo('lib')
      T.setRunner(async (_m, _l, args) => {
        calls.push(args)
        if (args[1] === 'add') { repos({ lib }); return { code: 0, stdout: 'Added\n', stderr: '' } }
        return { code: 1, stdout: '', stderr: 'no such automation' }
      })
      await expect(T.registerProject('', lib)).rejects.toThrow(/automation wherdr-add-repo-[0-9a-f]{8} that added it could not be removed: no such automation/)
    })

    it('says so when herdr-projects did not add it', async () => {
      const odd = gitRepo('odd')
      T.setRunner(async (_m, _l, args) => { calls.push(args); return { code: 0, stdout: 'ok\n', stderr: '' } })
      await expect(T.registerProject('', odd)).rejects.toThrow('herdr-projects did not add the repository to the board.')
    })

    it('never resets an existing conversation of a known repo', async () => {
      const to = { kind: 'project', repo: 'demo' }
      for (const state of ['idle', 'starting', 'stopped']) {
        calls = []
        coordStatus['--project=demo'] = { state, pane: '' }
        T.setRunner(async (_m, _l, args) => { calls.push(args); return { code: 0, stdout: args.at(-1) === 'status' ? JSON.stringify(coordStatus['--project=demo']) : 'sent\n', stderr: '' } })
        await T.tellCoordinator('', 'keep it', { to, start: { agent: 'claude' } })
        expect(calls.some(c => c.includes('new'))).toBe(false)
      }
      calls = []
      await expect(T.tellCoordinator('', 'hello', { to, start: { agent: '--bad' } })).rejects.toThrow(/Invalid agent/)
      expect(calls).toEqual([])
    })
  })

  it('a coordinator\'s pane is the one herdr-projects keeps for it, never one found by name', async () => {
    // Two repos whose agents' names Herdr would mix up (demo, demo-2): each has its own pane.
    coordStatus = { '--project=demo': { state: 'idle', pane: 'w2:p1' }, '--project=demo-2': { state: 'working', pane: 'w1:p1' }, '': { state: 'blocked', pane: 'w3:p1' } }
    panes.push({ id: 'w1:p1', machine: '', name: 'sw-coordinator-demo' }, { id: 'w2:p1', machine: '', name: 'sw-coordinator-demo-2' }, { id: 'w3:p1', machine: '', name: 'sw-coordinator' })
    // The same pane id and name in the machine's named session: not the board's.
    panes.unshift({ id: 'abcd1234~w2:p1', machine: 'abcd1234', name: 'sw-coordinator-demo' })
    expect(await T.coordinatorPane('', { kind: 'project', repo: 'demo' })).toEqual({ pane: 'w2:p1', state: 'idle', error: '', name: 'x', queued: null })
    expect(await T.coordinatorPane('', { kind: 'project', repo: 'demo-2' })).toEqual({ pane: 'w1:p1', state: 'working', error: '', name: 'x', queued: null })
    expect(await T.coordinatorPane('', { kind: 'main' })).toEqual({ pane: 'w3:p1', state: 'blocked', error: '', name: 'x', queued: null })
    // Not started: no pane, even with one named like it.
    expect(await T.coordinatorPane('', { kind: 'machine' })).toEqual({ pane: null, state: 'none', error: '', name: 'x', queued: null })
    // Exited, or a pane Herdr does not show (any more): none either.
    coordStatus = { '--project=demo': { state: 'exited', pane: 'w2:p1' }, '--project=web': { state: 'idle', pane: 'w9:p1' } }
    expect((await T.coordinatorPane('', { kind: 'project', repo: 'demo' })).pane).toBeNull()
    expect((await T.coordinatorPane('', { kind: 'project', repo: 'web' })).pane).toBeNull()
    // Asked of the board's own session, the user's words never as a flag.
    expect(calls.filter(c => c[0] === 'coordinator')).toEqual([
      ['coordinator', '--project=demo', '--json', 'status'], ['coordinator', '--project=demo-2', '--json', 'status'],
      ['coordinator', '--json', 'status'], ['coordinator', '--machine', '--json', 'status'],
      ['coordinator', '--project=demo', '--json', 'status'], ['coordinator', '--project=web', '--json', 'status'],
    ])
    await expect(T.coordinatorPane('', { kind: 'project', repo: '--all' })).rejects.toThrow(/Invalid coordinator/)
  })

  it('keeps queue counts when a coordinator has exited or its pane is missing', async () => {
    for (const state of ['exited', 'idle']) {
      for (const queued of [0, 1, 3]) {
        coordStatus = { '': { state, pane: 'w9:p1', queued, error: 'your message sits unsent in its box. Go into it and press enter.' } }
        expect(await T.coordinatorPane('', { kind: 'main' })).toEqual({
          state, pane: null, queued, error: 'your message sits unsent in its box. Go into it and press enter.', name: 'x',
        })
      }
    }
  })

  it('a coordinator whose start failed: why, and Try again (coordinator restart)', async () => {
    // Only a shell pane opened: herdr-projects gave up, its words still waiting ("starting").
    coordStatus = { '': { state: 'starting', pane: 'w3:p1', error: '"claude" is not installed here, so it cannot be the Coordinator.' } }
    panes.push({ id: 'w3:p1', machine: '' })
    expect(await T.coordinatorPane('', { kind: 'main' })).toEqual({ pane: null, state: 'starting', error: '"claude" is not installed here, so it cannot be the Coordinator.', name: 'x', queued: null })
    calls = []
    await T.restartCoordinator('', { kind: 'main' })
    await T.restartCoordinator('', { kind: 'machine' })
    await T.restartCoordinator('', { kind: 'project', repo: 'web' })
    expect(calls).toEqual([['coordinator', '--', 'restart'], ['coordinator', '--machine', '--', 'restart'], ['coordinator', '--project=web', '--', 'restart']])
    calls = []
    await expect(T.restartCoordinator('', { kind: 'project', repo: '--all' })).rejects.toThrow(/Invalid coordinator/)
  })
})

describe('structured failure commands', () => {
  it('refuses fix when the board says the failure needs the human', async () => {
    listReply = { code: 0, stdout: JSON.stringify([{ id: 'demo/7', stage: 'failed', state: 'error', app: 'claude' }]), stderr: '' }
    await read()
    await expect(T.taskCommand('', 'demo/7', 'fix')).rejects.toThrow(/human first/)
    expect(calls.some(c => c[0] === 'fix')).toBe(false)
  })
  it('does not allow an approval override on a passing review', async () => {
    await read()
    await expect(T.approveTask('', 'demo/1', true)).rejects.toThrow(/cannot bypass/)
    expect(calls.some(c => c[0] === 'approve')).toBe(false)
  })
})


describe('failure repair and explicit override', () => {
  it('sends fix separately from retry, after checking the structured permission', async () => {
    listReply = { code: 0, stdout: JSON.stringify([{ id: 'demo/6', stage: 'failed', state: 'error', app: 'claude' }]), stderr: '' }
    detailsReply = JSON.stringify({ task: { id: 'demo/6' }, failure: { stage: 'agent', title: 'Tests failed', detail: 'npm test', agentCanFix: true } })
    await read()
    await T.taskCommand('', 'demo/6', 'fix')
    expect(calls.at(-1)).toEqual(['fix', '--', 'demo/6'])
  })
  it('passes --anyway only for the explicit override of failed checks', async () => {
    detailsReply = JSON.stringify({ task: { id: 'demo/1' }, failure: { stage: 'pr', remoteKind: 'checks', title: 'Checks failed' } })
    await read()
    // The fake merge fails, but its arguments record the explicit decision.
    await expect(T.approveTask('', 'demo/1', true)).rejects.toThrow(/checks failed/)
    expect(calls.at(-1)).toEqual(['approve', '--anyway', '--', 'demo/1'])
  })
})

it('uses the saved merge blocker missing from the CLI list to group an approval', async () => {
  taskFile('demo/1', { stage: 'approval', mergeFailed: true, prFailure: { stage: 'pr', remoteKind: 'checks', title: 'Checks failed' } })
  const result = await read()
  expect(result.machines[0]!.tasks.find(t => t.id === 'demo/1')?.group).toBe('needs')
})

describe('questions about a task to its project coordinator', () => {
  it('names the task, sends only a question and never delegates', async () => {
    await T.askTaskCoordinator('', 'demo/1', 'What does it need?')
    expect(calls.map(c => c[0])).toEqual(['details', 'coordinator'])
    const sent = calls.at(-1)!
    expect(sent.slice(0, 4)).toEqual(['coordinator', '--project=demo', '--', 'tell'])
    expect(sent[4]).toContain('demo/1')
    expect(sent[4]).toContain('do not start, delegate or change any task')
    expect(sent[4]).toContain('What does it need?')
    expect(sent).not.toContain('--delegate')
  })
  it('rejects invalid ids and empty questions before any command', async () => {
    await expect(T.askTaskCoordinator('', '../other/1', 'why?')).rejects.toThrow(/Invalid task/)
    await expect(T.askTaskCoordinator('', 'demo/1', '  ')).rejects.toThrow(/Nothing to send/)
    expect(calls).toEqual([])
  })
  it('retains the end of the maximum question alongside context', async () => {
    await T.askTaskCoordinator('', 'demo/1', 'x'.repeat(6995) + ' end!')
    expect(calls.at(-1)![4]).toMatch(/ end!$/)
  })
})

it('sends task questions through the owning remote machine launcher', async () => {
  const owners: string[] = []
  T.setRunner(async (m, _launcher, args) => {
    owners.push(m.key)
    calls.push(args)
    return { code: 0, stderr: '', stdout: args[0] === 'details' ? fixture('details-approval.json') : 'sent' }
  })
  await T.askTaskCoordinator('remote', 'demo/1', 'What does this mean?')
  expect(owners).toEqual(['remote', 'remote'])
  expect(calls.at(-1)!.slice(0, 4)).toEqual(['coordinator', '--project=demo', '--', 'tell'])
  expect(calls.at(-1)![4]).toContain('Fix login redirect')
})

describe('human attempt picks', () => {
  const recorded = () => readFileSync(path.join(import.meta.dirname, 'recordings/herdr-projects-1.2.16/details-pick.json'), 'utf8')
  it('rechecks details and sends the exact letter to the owning remote machine', async () => {
    const seen: string[] = []
    T.setRunner(async (m, _launcher, args) => {
      seen.push(m.key)
      calls.push(args)
      return { code: 0, stdout: args[0] === 'details' ? recorded() : 'Attempt A chosen', stderr: '' }
    })
    expect(await T.pickTask('remote', 'demo/11', 'A', true)).toEqual({ ok: true, msg: 'Attempt A chosen' })
    expect(calls).toEqual([['details', '--json', '--', 'demo/11'], ['pick', '--', 'demo/11', 'A']])
    expect(seen).toEqual(['remote', 'remote'])
  })
  it('refuses missing confirmation, invalid letters and non-selectable attempts', async () => {
    detailsReply = recorded()
    for (const [letter, confirmed] of [['B', false], ['', true], ['--help', true], ['C', true], ['D', true]] as const) await expect(T.pickTask('', 'demo/11', letter, confirmed)).rejects.toThrow()
    expect(calls.some(a => a[0] === 'pick')).toBe(false)
    detailsReply = recorded().replace('"stage": "pick"', '"stage": "reviewing"')
    await expect(T.pickTask('', 'demo/11', 'A', true)).rejects.toThrow()
  })
  it('propagates CLI and unavailable-machine errors without falling back locally', async () => {
    T.setRunner(async (m, _launcher, args) => {
      expect(m.key).toBe('remote')
      return args[0] === 'details' ? { code: 0, stdout: recorded(), stderr: '' } : { code: 1, stdout: '', stderr: 'Attempt A cannot be chosen now' }
    })
    await expect(T.pickTask('remote', 'demo/11', 'A', true)).rejects.toThrow('Attempt A cannot be chosen now')
    infoFails = true
    await expect(T.pickTask('remote', 'demo/11', 'A', true)).rejects.toThrow('Herdr did not answer')
  })
})

describe('read-only task settings', () => {
  it('reads show on the selected machine, preserving an inherited value and a task override', async () => {
    const machines: string[] = []
    T.setRunner(async (m, _launcher, args) => {
      machines.push(m.key)
      calls.push(args)
      return { code: 0, stdout: taskSettings('codex', args.at(-1) === 'demo/2' ? 'task' : 'repo', 'precise source'), stderr: '' }
    })
    expect((await T.taskSettings('remote', 'demo/1')).settings[0]).toMatchObject({ value: 'codex', place: 'repo', from: 'precise source' })
    expect((await T.taskSettings('remote', 'demo/2')).settings[0]).toMatchObject({ value: 'codex', place: 'task' })
    expect(machines).toEqual(['remote', 'remote'])
    expect(calls).toEqual([['show', '--json', '--', 'demo/1'], ['show', '--json', '--', 'demo/2']])
  })
  it('propagates command failures and refuses invalid ids before running show', async () => {
    await expect(T.taskSettings('', '--bad')).rejects.toThrow('Invalid task')
    T.setRunner(async () => ({ code: 1, stdout: '', stderr: 'Machine unavailable' }))
    await expect(T.taskSettings('remote', 'demo/1')).rejects.toThrow('Machine unavailable')
  })
})

describe('coordinator Autopilot', () => {
  // A board that keeps each coordinator's state, as herdr-projects does.
  function autopilotRunner(version = '1.2.21', refuse = '') {
    const on = new Set<string>()
    T.setRunner(async (_m, _launcher, args) => {
      calls.push(args)
      if (args[0] === 'version') return { code: 0, stdout: `herdr-projects ${version}`, stderr: '' }
      if (args[0] === 'show') return { code: 0, stdout: JSON.stringify({ settings: [{ name: 'autopilot.goal', value: 'Keep the garden healthy' }, { name: 'autopilot.every', value: '6h' }] }), stderr: '' }
      if (args[1] === 'on' || args[1] === 'off') {
        if (refuse) return { code: 1, stdout: '', stderr: refuse }
        const id = args[2] === '--project' ? `project:${args[3]}` : args[2] === '--machine' ? 'machine' : 'main'
        if (args[1] === 'on') on.add(id)
        else on.delete(id)
        // Not a status: the state must be read again.
        return { code: 0, stdout: 'Done', stderr: '' }
      }
      if (args[0] === 'autopilot' && args[1] === '--json') {
        return { code: 0, stdout: JSON.stringify(['main', 'machine', 'project:demo'].map(c => on.has(c) ? { on: true, state: 'on', coordinator: c, goal: 'Grow', next: 'next in 2h' } : { on: false, coordinator: c })), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    })
  }
  it('turns a project coordinator on and reads its real state back', async () => {
    autopilotRunner()
    expect(await T.coordinatorAutopilot('remote', { kind: 'project', repo: 'demo' }, { action: 'on', goal: 'Grow', every: '2h' }))
      .toMatchObject({ on: true, goal: 'Grow', next: 'next in 2h', defaults: { every: '6h' } })
    expect(calls).toContainEqual(['autopilot', 'on', '--project', 'demo', '--goal', 'Grow', '--autopilot.every', '2h'])
    expect(calls).toContainEqual(['autopilot', '--json'])
    expect(calls).toContainEqual(['show', '--project-coordinator', 'demo', '--json'])
  })
  it('refuses an empty goal without running on', async () => {
    autopilotRunner()
    await expect(T.coordinatorAutopilot('', { kind: 'main' }, { action: 'on', goal: ' ' })).rejects.toThrow('goal is required')
    expect(calls).toEqual([])
  })
  it('stops the machine coordinator and keeps its saved goal to show', async () => {
    autopilotRunner()
    await T.coordinatorAutopilot('', { kind: 'machine' }, { action: 'on', goal: 'Grow' })
    expect(await T.coordinatorAutopilot('', { kind: 'machine' }, { action: 'off' })).toMatchObject({ on: false, goal: 'Keep the garden healthy' })
    expect(calls).toContainEqual(['autopilot', 'off', '--machine'])
  })
  it('lists every coordinator of a machine', async () => {
    autopilotRunner()
    await T.coordinatorAutopilot('', { kind: 'project', repo: 'demo' }, { action: 'on', goal: 'Grow' })
    const all = await T.autopilotStatuses('')
    expect(all.main).toMatchObject({ on: false })
    expect(all['project:demo']).toMatchObject({ on: true, next: 'next in 2h' })
  })
  it('passes the board refusal on, and refuses older versions', async () => {
    autopilotRunner('1.2.21', 'Tell a coordinator its goal first.')
    await expect(T.coordinatorAutopilot('', { kind: 'main' }, { action: 'on', goal: 'Grow' })).rejects.toThrow('Tell a coordinator its goal first.')
    calls = []
    T.resetTasksCache()
    autopilotRunner('1.2.14')
    await expect(T.autopilotStatuses('')).rejects.toThrow('herdr-projects 1.2.15 or later')
    expect(calls).toEqual([['version']])
  })
})

describe('scheduled coordinator reads', () => {
  it('only issues read commands and keeps unavailable sources separate from an empty schedule', async () => {
    const requested: string[][] = []
    T.setRunner(async (_m, _launcher, args) => {
      requested.push(args)
      if (args[0] === 'autopilot') return { code: 1, stdout: '', stderr: 'not supported' }
      if (args[0] === 'automations') return { code: 0, stdout: '[]', stderr: '' }
      if (args[0] === 'coordinator') return { code: 0, stdout: '{"state":"none","pane":""}', stderr: '' }
      throw new Error('Unexpected command')
    })
    const scheduled = await T.coordinatorScheduled('', { kind: 'main' })
    expect(scheduled.autopilot).toBeNull()
    expect(scheduled.automations).toEqual([])
    expect(scheduled.timers).toEqual([])
    expect(scheduled.warnings).toEqual(['Autopilot unavailable'])
    expect(requested).toEqual([['autopilot', '--json'], ['automations', '--json'], ['coordinator', '--json', 'status']])
  })

  it('rejects an invalid project before accessing the board', async () => {
    const runner = vi.fn()
    T.setRunner(runner)
    await expect(T.coordinatorScheduled('', { kind: 'project', repo: '../escape' })).rejects.toThrow('Invalid coordinator')
    expect(runner).not.toHaveBeenCalled()
  })
})


it.each([0, 25 * 1024 * 1024])('reads scheduled coordinator wake dates, recent firing tasks and a transcript with %i padding bytes', async (padding) => {
  const dir = path.join(home, '.herdr-projects/data/coordinator/default/projects/demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ autopilot: { timerAt: clock - 60000, wakes: [{ at: clock - 60000 }] } }))
  const firings = path.join(home, '.herdr-projects/data/automations/firings')
  mkdirSync(firings, { recursive: true })
  writeFileSync(path.join(firings, '1234abcd.jsonl'), [{ task: 'demo/1' }, { skipped: 'busy' }, { task: 'demo/2' }].map(f => JSON.stringify(f)).join('\n'))
  const transcript = [
    { type: 'assistant', timestamp: new Date(clock - 1000).toISOString(), message: { content: [{ type: 'tool_use', id: 'tool1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'Check build', recurring: true } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '{"id":"job1"}' }] } },
  ].map(r => JSON.stringify(r)).join('\n')
  writeFileSync(path.join(home, 'timer-transcript.jsonl'), transcript + '\n' + JSON.stringify({ message: { content: 'x'.repeat(padding) } }))
  panes.push({ id: 'w1:p1', agent: 'claude' })
  T.setRunner(async (_m, _launcher, args) => ({ code: 0, stderr: '', stdout: JSON.stringify(
    args[0] === 'autopilot' ? [{ coordinator: 'project:demo', on: true, goal: 'Ship demo', next: 'next in 1m', settings: [{ label: 'Wakes', value: 'every 2m' }] }]
      : args[0] === 'automations' ? [{ id: '1234abcd', name: 'Audit', repo: 'demo', on: true, trigger: 'daily 09:00' }]
        : { state: 'idle', pane: 'w1:p1' },
  ) }))
  const scheduled = await T.coordinatorScheduled('', { kind: 'project', repo: 'demo' })
  expect(scheduled.autopilot).toMatchObject({ next: clock + 60000, last: clock - 60000, goal: 'Ship demo' })
  expect(scheduled.automations[0]?.tasks).toEqual(['demo/2', 'demo/1'])
  expect(scheduled.timers).toMatchObject([{ id: 'job1', cron: '*/5 * * * *' }])
  expect(scheduled.warnings).toEqual([])
})

describe('description writes', () => {
  it('passes describe data through the fixed remote shell script without evaluation', () => {
    const text = "--flag\nIt's $(printf altered); `printf altered` & | < > \\ \n"
    const args = ['describe', '--', 'demo/1', text]
    const output = execFileSync('sh', ['-c', T.REMOTE_TASKS_SCRIPT, 'tasks', 'herdr', '', process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(args)
  })
  it.each(['', session.key, 'remote'])('routes opaque multiline text to the owner of %s', async key => {
    const text = "--title=literal\n\nIt's data: $(touch nope); `id` & < > | \\\nlast\r\n\r\n"
    const seen: { machine: string, args: string[] }[] = []
    T.setRunner(async (m, _launcher, args) => {
      seen.push({ machine: m.key, args })
      return { code: 0, stdout: args[0] === 'list' ? fixture('list.json') : args[0] === 'details'
        ? JSON.stringify({ task: { id: 'demo/1', description: text.replace(/\r/g, '').trim() } }) : 'updated', stderr: '' }
    })
    await T.describeTask(key, 'demo/1', text)
    expect(seen.at(-1)).toEqual({ machine: key === 'remote' ? 'remote' : '', args: ['describe', '--', 'demo/1', text] })
    expect((await T.taskDetails(key, 'demo/1')).description).toBe(text.replace(/\r/g, '').trim())
  })
  it('refuses an archived file and an offline owner before writing', async () => {
    taskFile('demo/1', { archivedAt: 123 })
    await expect(T.describeTask('', 'demo/1', 'draft')).rejects.toThrow('read-only')
    remote.status = 'offline'
    try { await expect(T.describeTask('remote', 'demo/1', 'draft')).rejects.toThrow('unreachable') }
    finally { remote.status = 'online' }
    expect(calls.some(a => a[0] === 'describe')).toBe(false)
  })
  it('returns every line of a CLI refusal', async () => {
    T.setRunner(async (_m, _l, args) => args[0] === 'describe'
      ? { code: 1, stdout: '', stderr: 'Write refused\nTry again later' }
      : { code: 0, stdout: fixture('list.json'), stderr: '' })
    await expect(T.describeTask('', 'demo/1', 'draft')).rejects.toThrow('Write refused\nTry again later')
  })
})

describe('archive completed repository tasks', () => {
  it('runs exactly one bulk command on the owner of a named session, preserving CLI output', async () => {
    const ran: { machine: string, args: string[] }[] = []
    T.setRunner(async (m, _launcher, args) => {
      ran.push({ machine: m.key, args })
      return { code: 0, stdout: 'Archived 2 tasks. Kept 1 pinned task.\n', stderr: 'A CLI notice\n' }
    })
    expect(await T.archiveDoneTasks(session.key, 'demo')).toEqual({ machine: '', code: 0, stdout: 'Archived 2 tasks. Kept 1 pinned task.\n', stderr: 'A CLI notice\n' })
    expect(ran).toEqual([{ machine: '', args: ['archive', '--done', '--repo', 'demo'] }])
  })

  it('runs on the remote owner and returns every line of a CLI error', async () => {
    await T.readTasksBoard()
    const ran: string[][] = []
    T.setRunner(async (m, _launcher, args) => {
      if (args[0] === 'archive') {
        expect(m.key).toBe('remote')
        ran.push(args)
        return { code: 1, stdout: 'Archived 1 task\n', stderr: 'Cannot archive another task\nDetails\n' }
      }
      return { code: 0, stdout: fixture('list.json'), stderr: '' }
    })
    expect(await T.archiveDoneTasks('remote', 'demo')).toMatchObject({ code: 1, stdout: 'Archived 1 task\n', stderr: 'Cannot archive another task\nDetails\n' })
    expect(ran).toEqual([['archive', '--done', '--repo', 'demo']])
  })

  it('invalidates the owner cache on success and failure', async () => {
    for (const code of [0, 1]) {
      await T.readTasksBoard()
      const ran: string[][] = []
      T.setRunner(async (_m, _launcher, args) => {
        ran.push(args)
        return { code: args[0] === 'archive' ? code : 0, stdout: args[0] === 'list' ? fixture('list.json') : '', stderr: '' }
      })
      await T.archiveDoneTasks(session.key, 'demo')
      await T.readTasksBoard()
      expect(ran.filter(args => args[0] === 'list')).toHaveLength(1)
    }
  })

  it('rejects an absent or invalid repo without running any command', async () => {
    const run = vi.fn()
    T.setRunner(run)
    for (const repo of ['', undefined, '/tmp/demo', '--done', {}]) await expect(T.archiveDoneTasks('', repo)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
