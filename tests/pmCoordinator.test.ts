import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Quotas } from '../shared/types'
import { createPmStore } from '../server/utils/pmStore'
import { alfredView, answerProposal, coordinatorsView, issueToken, noteTurn, runCommand, setCoordinatorAgent, startCoordinator, takeUpdateNotice, userMessageTo } from '../server/utils/pmCoordinator'
import { REMOTE_SCRIPT } from '../server/utils/pmVisibility'
import { CREATE_SCRIPT, launched } from '../server/utils/pmLaunch'
import { execFileSync } from 'node:child_process'
import { trustKeys } from '../shared/pm/run'
import { coordinatorStart, setupDone } from '../shared/pm/setup'
import { FIRST_REPLY, MAIN, parseCommand, roleFiles, coordinatorArgs, tellTarget, updateNotice } from '../shared/pm/coordinator'
import pkg from '../package.json'
import { EXAMPLES, common, company as example, github } from '../shared/pm/examples'
import { DONE_CMD, reviewFile } from '../shared/pm/advance'
import { onEvent, planSteps, type StepState } from '../shared/pm/steps'
import type { Finding } from '../shared/pm/verdict'
import { defaultWorkflow, isDefaultWorkflow, type Template } from '../shared/pm/workflow'
import type { CoreAdminDeps } from '../server/utils/coreCreate'
import { runNow, wakeCoordinators, wakeTick } from '../server/utils/pmWakes'
import { askCoordinator } from '../server/utils/pmReport'
import { answerQuestion } from '../server/utils/pmAnswer'
import { cardOf, toHandle } from '../shared/pm/board'
import { WAKE } from '../shared/pm/wakes'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
// @ts-expect-error plain JavaScript module
import { pm } from '../bin/lib/pm.mjs'

// The example with a coordinator-held deploy step, rechecked (the example's own is an engine watch).
const company: Template = structuredClone(example)
company.taskTypes.feature!.steps.splice(-2, 1, { id: 'deploy', column: 'Deploy', holder: 'coordinator', ends: 'report', recheck: '5m', timeout: '90m',
  instructions: 'Watch the develop pipeline and the deploy. Deployed: say so and finish. Failed: say which test failed and investigate.' })

// The quota readings the pace reads; none by default (quota unknown).
const quotas = vi.hoisted(() => ({ q: null as Quotas | null }))
vi.mock('../server/utils/quotas', async orig => ({ ...(await orig<object>()), readQuotas: async () => quotas.q ?? { claude: null, codex: null } }))
afterEach(() => { quotas.q = null; vi.unstubAllEnvs() })

let dir = '', store: ReturnType<typeof createPmStore>, token = ''
const deps = () => ({ store, machines: () => [] }) as unknown as CoreAdminDeps & { store: typeof store }
const cli = (argv: string[], input?: string, tk = token) => runCommand(deps(), tk, { argv, ...(input !== undefined ? { input } : {}) })
const refused = (p: Promise<unknown>, message: RegExp | string) => expect(p).rejects.toThrow(message)
const state = (at: number, more: Partial<StepState> = {}): StepState => ({ at, started: true, proofs: {}, rounds: {}, ...more })

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-coord-'))
  store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(company)
  await store.saveTemplate(common)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [
    { key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1 },
    { key: 'ST', name: 'Studies', machine: '', path: '/src/st', template: 'common', addedAt: 1 },
  ] }))
  token = await issueToken(store, 'CO')
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('the token', () => {
  it('works for its own project only, and a new one replaces it', async () => {
    const other = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    await refused(cli(['show', other.id]), 'project CO only')
    await refused(cli(['list'], undefined, 'f'.repeat(64)), 'Unknown coordinator token')
    const mine = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    expect((await cli(['list']) as { tasks: { id: string }[] }).tasks.map(t => t.id)).toEqual([mine.id])
    // A finished task reads done, not the state it kept while working.
    await store.saveTask({ ...mine, state: 'working', step: { at: 5, started: true, done: true, proofs: {}, rounds: {} } })
    expect((await cli(['list']) as { tasks: { state: string }[] }).tasks[0]!.state).toBe('done')
    const fresh = await issueToken(store, 'CO')
    await refused(cli(['list']), 'Unknown coordinator token')
    await expect(cli(['list'], undefined, fresh)).resolves.toBeTruthy()
  })

  it('tags and links a task, each written to its log with who did it', async () => {
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await cli(['task', 'tag', task.id, 'CTP-264'])
    await cli(['task', 'link', task.id, 'https://example.com/pr/7', '--label', 'PR'])
    const saved = (await store.task(task.id))!
    expect(saved).toMatchObject({ tags: ['CTP-264'], links: [{ label: 'PR', url: 'https://example.com/pr/7' }] })
    expect(saved.log!.map(l => [l.by, l.text])).toEqual([['coordinator CO', 'tag CTP-264'], ['coordinator CO', 'link PR https://example.com/pr/7']])
  })
})

describe('other projects (WHR-311)', () => {
  const reach = (level: 'read' | 'act') => store.updateProject('CO', { reach: [{ project: 'ST', level }] })

  it('no setting: its own project only, the refusal names the setting and where it is', async () => {
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    await refused(cli(['show', st.id]), /project CO only: show on project ST needs Read or Act for ST in "Other projects this coordinator may act on".*Settings › Projects › CO › General/)
    await refused(cli(['list', '--project', 'ST']), 'project CO only')
  })

  it('Read: list, show and plan on the other project; writes refused', async () => {
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    await reach('read')
    expect((await cli(['list', '--project', 'ST']) as { tasks: { id: string }[] }).tasks.map(t => t.id)).toEqual([st.id])
    expect((await cli(['show', st.id]) as { task: { id: string } }).task.id).toBe(st.id)
    await expect(cli(['plan', '--project', 'ST'])).resolves.toBeTruthy()
    await noteTurn(store, 'CO', 'user', 'tag it')
    await refused(cli(['task', 'tag', st.id, 'X']), 'task tag on project ST needs Act')
    await refused(cli(['task', 'add', 'More', '--type', 'study', '--project', 'ST']), 'needs Act')
  })

  it('Act: writes logged with the acting coordinator\'s name, its coordinator told at its next wake; guards, merges and settings stay out', async () => {
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    await issueToken(store, 'ST')
    await reach('act')
    await noteTurn(store, 'CO', 'user', 'add a study there')
    await cli(['task', 'tag', st.id, 'X-1'])
    const added = await cli(['task', 'add', 'More', '--type', 'study', '--project', 'ST']) as { task: { id: string, project: string, log: { by: string }[] } }
    expect(added.task).toMatchObject({ project: 'ST', log: [{ by: 'coordinator CO' }] })
    expect((await store.task(st.id))!.log!.at(-1)).toMatchObject({ by: 'coordinator CO', text: 'tag X-1' })
    for (const argv of [['step', 'done', st.id, '--user-said', 'ok'], ['task', 'decide', st.id, 'pass', '--reason', 'x'], ['autopilot', 'show', '--project', 'ST'], ['template', 'show', '--project', 'ST'], ['automation', 'list', '--project', 'ST']])
      await refused(cli(argv), 'stays with its own coordinator and the user')
    // A look-for-work wake: the other project's new-work limit and count hold too.
    for (const k of ['CO', 'ST']) { const c = (await store.coordinator(k))!; await store.saveCoordinator({ ...c, autopilot: { ...DEFAULT_AUTOPILOT, on: true, lookForWork: true, lookPerDay: 2 } }) }
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, turn: { kind: 'wake', at: Date.now(), look: true } })
    await cli(['task', 'add', 'Look', '--type', 'study', '--project', 'ST'])
    expect([(await store.coordinator('CO'))!.lookAdded, (await store.coordinator('ST'))!.lookAdded].map(d => d?.n)).toEqual([1, 1])
    await store.saveCoordinator({ ...(await store.coordinator('ST'))!, autopilot: { ...DEFAULT_AUTOPILOT, on: true, lookForWork: true, lookPerDay: 1 } })
    await refused(cli(['task', 'add', 'Again', '--type', 'study', '--project', 'ST']), 'limit of new work is reached (1 tasks')
    expect((await store.tasks()).filter(x => x.title === 'Again')).toEqual([])
    await store.saveCoordinator({ ...(await store.coordinator('ST'))!, visits: (await store.coordinator('ST'))!.visits!.slice(0, 2) })
    expect((await store.coordinator('ST'))!.visits!.map(v => [v.by, v.what])).toEqual([['coordinator CO', `task tag ${st.id}`], ['coordinator CO', 'task add "More"']])
    // Its next wake says so, once.
    await store.saveCoordinator({ ...(await store.coordinator('ST'))!, terminal: 'host/t2' })
    const sent: string[] = []
    const call = async (method: string, params: Record<string, string>) => (method === 'terminal.get' ? { status: 'idle' } : (sent.push(params.text!), {}))
    const d = { store, call, notify: async () => {}, machines: () => [] } as unknown as Parameters<typeof runNow>[0]
    await runNow(d, 'ST', 5000)
    expect(sent[0]).toContain(`Other coordinators acted on your project since your last wake (each action is in its task's or the project's log): coordinator CO: task tag ${st.id}; coordinator CO: task add "More".`)
    expect((await store.coordinator('ST'))!.visits).toEqual([])
    // Its instructions list them.
    const agents = roleFiles((await store.projects()).find(x => x.key === 'CO')!, company, [])['AGENTS.md']!
    expect(agents).toContain('## Other projects')
    expect(agents).toContain('- ST: Act')
  })
})

describe('workspaces (WHR-314)', () => {
  // WS is a workspace with members PA and QA; its token acts on them, at the Act level.
  beforeEach(async () => {
    const raw = JSON.parse(await fs.readFile(store.files.projects, 'utf8'))
    raw.projects.push({ key: 'WS', name: 'Work', machine: '', path: '/src/work', kind: 'workspace', git: false, addedAt: 1 },
      { key: 'PA', name: 'Payroll', machine: '', path: '/src/work/payroll-api', workspace: 'WS', addedAt: 1 },
      { key: 'QA', name: 'Quotes', machine: '', path: '/src/work/quotes-app', workspace: 'WS', addedAt: 1 })
    await fs.writeFile(store.files.projects, JSON.stringify(raw))
    token = await issueToken(store, 'WS')
    await noteTurn(store, 'WS', 'user', 'go')
  })

  it('reads and acts on its members only, no setting needed; the rest stays at Act', async () => {
    const pa = await store.addTask({ project: 'PA', title: 'Pay', type: 'feature' })
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    expect((await cli(['list', '--project', 'PA']) as { tasks: { id: string }[] }).tasks.map(t => t.id)).toEqual([pa.id])
    await cli(['task', 'tag', pa.id, 'X-1'])
    expect((await store.task(pa.id))!.log!.at(-1)).toMatchObject({ by: 'coordinator WS', text: 'tag X-1' })
    await refused(cli(['show', st.id]), 'project WS only')
    await refused(cli(['template', 'show', '--project', 'PA']), 'stays with its own coordinator and the user')
    // Its instructions list its members.
    expect(roleFiles((await store.projects()).find(x => x.key === 'WS')!, null, [], undefined, k => k, ['PA', 'QA'])['AGENTS.md']).toContain('member projects: PA, QA')
  })

  it('one autopilot: a member\'s start in a wake counts the other members\' tasks', async () => {
    await store.saveCoordinator({ ...(await store.coordinator('WS'))!, autopilot: { ...DEFAULT_AUTOPILOT, on: true, atOnce: 1 }, turn: { kind: 'wake', at: Date.now() } })
    const qa = await store.addTask({ project: 'QA', title: 'Quote', type: 'feature' })
    await store.saveTask({ ...qa, state: 'working' })
    const pa = await store.addTask({ project: 'PA', title: 'Pay', type: 'feature' })
    await refused(cli(['task', 'start', pa.id]), '1 tasks already work at once (limit 1)')
  })

  it('no coordinator for a member: none starts, none listed; its wakes go to the workspace\'s', async () => {
    await refused(startCoordinator(deps(), 'PA', {}, { local: 'http://127.0.0.1:3000' }), 'member of workspace WS')
    expect((await coordinatorsView(store)).map(c => c.project)).toEqual([MAIN, 'CO', 'ST', 'WS'])
    await store.saveCoordinator({ ...(await store.coordinator('WS'))!, terminal: 'host/t1', autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
    const pa = await store.addTask({ project: 'PA', title: 'Pay', type: 'feature' })
    expect(await wakeCoordinators({ store }, pa, 'stuck: no output for 30 min', 1000)).toEqual(['the workspace\'s coordinator'])
    expect((await store.wakes()).map(w => [w.coordinator, w.reasons[0]])).toEqual([['WS', `${pa.id}: stuck: no output for 30 min`]])
  })
})

describe('the Autopilot tab\'s timeline', () => {
  it('lists the autopilot\'s own starts only, and yesterday\'s ended wakes', async () => {
    const now = Date.now(), yesterday = new Date(now).setHours(-24, 30, 0, 0)
    const add = async (title: string, text: string, autopilot = false) => {
      const t = await store.addTask({ project: 'CO', title, type: 'feature' })
      await store.saveTask({ ...t, ...(autopilot ? { autopilot: true as const } : {}), log: [{ at: now - 60_000, by: 'engine', text }] })
    }
    await add('Busy', 'started by the autopilot: room on box')
    await add('Wake', 'started the task in a wake', true)
    await add('Mine', 'started the task')
    await add('Held for room', 'started: there is room', true)
    await add('After', 'started: there is room')
    await store.saveWakes([{ id: 'old', coordinator: 'CO', reasons: ['Scheduled wake'], createdAt: yesterday, deliveredAt: yesterday, ackedAt: yesterday + 1, endedAt: yesterday + 1, ended: 'ack', tries: 1 }])
    const co = (await coordinatorsView(store)).find(c => c.project === 'CO')!
    expect(co.started!.map(s => s.title)).toEqual(['Busy', 'Wake', 'Held for room'])
    expect(co.wakes!.map(w => w.id)).toEqual(['old'])
  })

  it('counts a start only once its terminal exists', async () => {
    const t = await store.addTask({ project: 'CO', title: 'Timed out', type: 'feature' })
    const run = { id: 'r1', task: t.id, role: 'worker' as const, program: 'claude', model: '', machine: '', worktree: '', branch: '', instructions: '', attempt: 1, state: 'starting' as const, startedAt: 1 }
    await store.saveRun(run)
    const working = await store.saveTask({ ...t, state: 'working', run: 'r1' })
    expect(await launched(store, working)).toBe(false)
    await store.saveRun({ ...run, terminal: 'host/t9', state: 'running' })
    expect(await launched(store, working)).toBe(true)
  })
})

describe('the main coordinator (WHR-398)', () => {
  const ids = (r: unknown) => (r as { tasks: { id: string }[] }).tasks.map(t => t.id)

  it('acts on every project; a project token still cannot leave its project', async () => {
    const main = await issueToken(store, MAIN)
    const co = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    expect(ids(await cli(['list'], undefined, main))).toEqual([co.id, st.id])
    expect(ids(await cli(['list', '--project', 'ST'], undefined, main))).toEqual([st.id])
    await cli(['task', 'tag', st.id, 'X-1'], undefined, main)
    expect((await store.task(st.id))!.log!.at(-1)).toMatchObject({ by: 'main coordinator', text: 'tag X-1' })
    // A task needs its project named; the template stays the project's.
    await noteTurn(store, MAIN, 'user', 'add a study')
    await refused(cli(['task', 'add', 'More', '--type', 'study'], undefined, main), 'Name the project')
    const added = await cli(['task', 'add', 'More', '--type', 'study', '--project', 'ST'], undefined, main) as { task: { project: string } }
    expect(added.task.project).toBe('ST')
    await refused(cli(['template', 'edit'], '{}', main), 'project coordinator')
    await refused(cli(['list', '--project', 'NO'], undefined, main), 'Unknown project')
    // The project's token: its project only, whatever it names.
    await refused(cli(['list', '--project', 'ST']), 'project CO only')
    await refused(cli(['task', 'add', 'More', '--type', 'study', '--project', 'ST']), 'project CO only')
    await refused(cli(['task', 'tag', st.id, 'Y']), 'project CO only')
    expect(ids(await cli(['list']))).toEqual([co.id])
    expect(parseCommand(['show', 'CO-1', '--project', 'CO'])).toEqual({ error: expect.stringContaining('--project is for') })
  })

  it('has no autopilot (WHR-51): no wake, none in its view, the route refuses it, a wake turn starts or adds nothing', async () => {
    const main = await issueToken(store, MAIN)
    const st = await store.addTask({ project: 'ST', title: 'Study', type: 'study' })
    // An autopilot saved before: turned off and ignored.
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, terminal: 'host/t1', ranAt: 0, autopilot: { ...DEFAULT_AUTOPILOT, on: true, goal: 'Ship', every: '30m' } })
    const sent: unknown[] = []
    const call = async (method: string, params: unknown) => { if (method === 'terminal.send') sent.push(params); return method === 'terminal.get' ? { status: 'idle' } : {} }
    expect(await wakeTick({ store, call } as unknown as Parameters<typeof wakeTick>[0], 3_600_000)).toEqual([])
    expect(sent).toEqual([])
    expect((await store.coordinator(MAIN))!.autopilot!.on).toBe(false)
    const [alfred] = await coordinatorsView(store)
    expect(alfred).toMatchObject({ main: true })
    expect(alfred).not.toHaveProperty('autopilot')
    await noteTurn(store, MAIN, 'wake')
    await refused(cli(['task', 'start', st.id], undefined, main), 'only on a request from the user, sent from wherdr')
    await refused(cli(['task', 'add', 'More', '--type', 'study', '--project', 'ST'], undefined, main), 'only on a request from the user, sent from wherdr')
    vi.stubGlobal('defineApi', (h: unknown) => h)
    const route = (await import('../server/api/pm/autopilot.post')).default as unknown as (e: unknown, b: unknown) => Promise<unknown>
    await refused(route({}, { project: MAIN, autopilot: { on: true } }), 'Alfred has no autopilot')
    await refused(route({}, { project: MAIN, runNow: true }), 'Alfred has no autopilot')
    // Every off saved before the engine's first look: kept off, not migrated to 3h.
    vi.stubEnv('DATA_DIR', dir)
    vi.resetModules()
    const fresh = (await import('../server/api/pm/autopilot.post')).default as unknown as (e: unknown, b: unknown) => Promise<unknown>
    const own = (await import('../server/utils/pmStore')).pmStore()
    await own.setEnabled(true)
    await fs.mkdir(path.dirname(own.files.projects), { recursive: true })
    await fs.writeFile(own.files.projects, await fs.readFile(store.files.projects))
    await fresh({}, { project: 'ST', autopilot: { ...DEFAULT_AUTOPILOT, on: true, every: 'off' } })
    expect(await own.coordinator('ST')).toMatchObject({ oneWake: true, autopilot: { on: true } })
    await wakeTick({ store: own, call: async () => ({}), machines: () => [] } as unknown as Parameters<typeof wakeTick>[0], 3_600_000)
    expect((await own.coordinator('ST'))!.autopilot!.every).toBeUndefined()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('is Alfred: starts in its home in the data dir, greets once, keeps its own files and the agent picked', async () => {
    const runs: Record<string, unknown>[] = [], killed: unknown[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === 'terminal.kill') return killed.push(params.terminal), {}
      if (method !== 'terminal.run') return {}
      runs.push(params)
      return { address: `host/t${runs.length}` }
    }
    const home = path.join(dir, 'alfred')
    // No v2 board here, whatever this machine has: Alfred reads it live.
    vi.stubEnv('HERDR_PROJECTS_HOME', path.join(dir, 'no-herdr-projects'))
    const d = { store, call, machines: () => [], alfredHome: home } as never
    const r = await startCoordinator(d, MAIN, { program: 'claude', model: 'sonnet' }, { local: 'http://127.0.0.1:7690' })
    // A program only: its own default model, no --model (the model given is ignored).
    expect(r.folder).toBe(home)
    expect(await fs.readFile(path.join(home, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toContain('only through the board')
    expect(runs[0]).toMatchObject({ cwd: home, labels: { 'wherdr.coordinator': MAIN }, env: { WHERDR_URL: 'http://127.0.0.1:7690' } })
    expect(runs[0]!.on).toBeUndefined()
    expect(runs[0]!.line).toMatch(/exec 'claude' 'Follow .*give me another name\?"'$/)
    // Renamed by Alfred, then restarted with another agent: same home, its files kept, the old session stopped.
    await fs.writeFile(path.join(home, 'identity.md'), 'Name: Jeeves\n')
    await fs.writeFile(path.join(home, 'memory.md'), '- likes short answers\n')
    await startCoordinator(d, MAIN, { program: 'codex', model: 'gpt-6-sol' }, { local: 'http://127.0.0.1:7690' })
    expect(runs[1]!.line).toMatch(/greet the user in one short line as Jeeves\.'$/)
    expect(await fs.readFile(path.join(home, 'memory.md'), 'utf8')).toBe('- likes short answers\n')
    expect(killed).toEqual(['host/t1'])
    expect(runs[1]!.line).not.toContain('--model')
    expect(await alfredView(d)).toEqual({ name: 'Jeeves', program: 'codex', ran: 'codex', terminal: 'host/t2' })
    // No program given: the one picked last.
    await startCoordinator(d, MAIN, {}, { local: 'http://127.0.0.1:7690' })
    expect(runs[2]!.line).toMatch(/exec 'codex' '-c' 'check_for_update_on_startup=false' '-C'/)
    // Card outcomes saved while it was stopped: one Codex prompt argument, its turn the user's.
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, cardNotes: ['Applied: New project WEB'] })
    await startCoordinator(d, MAIN, {}, { local: 'http://127.0.0.1:7690' })
    expect(runs[3]!.line).toMatch(/as Jeeves\.\n\nFrom the card: since your last conversation, on your cards: Applied: New project WEB'$/)
    expect(await store.coordinator(MAIN)).toMatchObject({ turn: { kind: 'user' } })
    expect((await store.coordinator(MAIN))!.cardNotes).toBeUndefined()
    await expect(startCoordinator(d, MAIN, { program: 'cline' }, { local: 'http://127.0.0.1:7690' })).rejects.toThrow('program')
    const view = await coordinatorsView(store)
    expect(view.map(c => c.project)).toEqual([MAIN, 'CO', 'ST'])
    expect(view[0]).toMatchObject({ main: true, terminal: 'host/t4' })
    expect(view[0]!.machines).toBeUndefined()
    expect(view[1]!.machines).toEqual([''])
  })

  it('runs Alfred with OMP too: started bare in its home, its greeting typed once it is ready', async () => {
    const lines: string[] = [], sent: unknown[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === 'terminal.run') return lines.push(params.line as string), { address: 'host/t1' }
      if (method === 'terminal.get') return { state: 'running', status: 'idle' }
      if (method === 'terminal.read') return { text: 'omp ready' }
      if (method === 'terminal.send') sent.push(params.text)
      return {}
    }
    const d = { store, call, machines: () => [], alfredHome: path.join(dir, 'alfred'), pollMs: 1 } as never
    await startCoordinator(d, MAIN, { program: 'omp' }, { local: 'http://127.0.0.1:7690' })
    expect(lines[0]).toMatch(/exec 'omp'$/)
    await vi.waitFor(() => expect(sent).toEqual([expect.stringContaining('give me another name?')]))
  })

  it('runs Alfred with projects off: its record is saved, its instructions say how to switch them on', async () => {
    await store.setEnabled(false)
    const home = path.join(dir, 'alfred')
    // .output/server/index.mjs started directly, no port set: Nitro listens on 3000 (WHR-244).
    vi.stubEnv('NITRO_PORT', '')
    vi.stubEnv('PORT', '')
    const d = { store, call: async () => ({ address: 'host/t1' }), machines: () => [], alfredHome: home } as never
    await startCoordinator(d, MAIN, { program: 'claude', model: 'opus' }, { local: 'http://127.0.0.1:7690' })
    expect(await alfredView(d)).toMatchObject({ name: 'Alfred', program: 'claude', terminal: 'host/t1' })
    const agents = await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Project management is off')
    expect(agents).toContain('This wherdr answers at http://127.0.0.1:3000 on its machine')
    await expect(store.saveCoordinator({ project: 'CO', tokenHash: '' })).rejects.toThrow('switched off')
  })
})

describe('template edit', () => {
  const edited = (change: (t: Template) => void) => {
    const t = structuredClone(company)
    change(t)
    return JSON.stringify(t)
  }
  const moreInstructions = edited((t) => { t.instructions = 'Base branch is develop. Never run the full suite locally.' })

  it('is refused outside a turn that comes from the user', async () => {
    await refused(cli(['template', 'edit'], moreInstructions), 'only for a turn that comes from the user')
    await noteTurn(store, 'CO', 'wake')
    await refused(cli(['template', 'edit'], moreInstructions), 'only for a turn that comes from the user')
    expect((await store.workflow('CO'))!.version).toBe(1)
  })

  it('in a user turn: proposed with its diff; saved only once the user accepts, logged with their sentence', async () => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    await userMessageTo(store, 'host/t9', 'Tell agents to never run the full suite')
    const r = await cli(['template', 'edit'], moreInstructions) as { proposed: boolean, changes: string[], diff: string }
    const diff = '-   "instructions": "Base branch is develop.",\n+   "instructions": "Base branch is develop. Never run the full suite locally.",'
    expect(r).toMatchObject({ proposed: true, diff })
    expect(r.changes.length).toBeGreaterThan(0)
    expect((await store.workflow('CO'))!.version).toBe(1)
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.proposal).toMatchObject({ diff, by: 'CO', said: 'Tell agents to never run the full suite', saidAt: expect.any(Number) })
    expect(await cli(['template', 'show'])).toMatchObject({ diff })
    // No core: the role files are not rewritten, the template is saved all the same.
    await expect(answerProposal(deps(), 'CO', true)).resolves.toEqual({ accepted: true })
    expect((await store.workflow('CO'))!.version).toBe(2)
    expect((await store.workflowLog('CO')).at(-1)).toMatchObject({ by: 'coordinator CO', version: 2, said: 'Tell agents to never run the full suite' })
    expect((await store.coordinator('CO'))!.proposal).toBeUndefined()
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: 'accepted' })
  })

  it('accepts a proposal made before the project had its own workflow', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-legacy-'))
    const old = createPmStore(fresh)
    await old.setEnabled(true)
    await old.saveTemplate(company)
    await fs.writeFile(old.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1 }] }))
    await fs.mkdir(old.files.coordinators)
    const proposal = { template: { ...structuredClone(company), instructions: 'Proposed.' }, diff: '', at: 1, base: 1 }
    await fs.writeFile(path.join(old.files.coordinators, 'CO.json'), JSON.stringify({ project: 'CO', tokenHash: 'x', proposal }))
    const migrated = createPmStore(fresh)
    await expect(answerProposal({ store: migrated } as unknown as Parameters<typeof answerProposal>[0], 'CO', true)).resolves.toEqual({ accepted: true })
    expect(await migrated.workflow('CO')).toMatchObject({ id: 'co', version: 2, instructions: 'Proposed.' })
    expect((await migrated.template('company'))!.version).toBe(1)
    await fs.rm(fresh, { recursive: true, force: true })
  })

  it('is not saved over a change the user made after it', async () => {
    await noteTurn(store, 'CO', 'user', 'add a line')
    await cli(['template', 'edit'], moreInstructions)
    await store.saveWorkflow('CO', { ...structuredClone(company), instructions: 'USER EDIT' })
    await refused(answerProposal(deps(), 'CO', true), 'The template changed since this proposal')
    expect((await store.workflow('CO'))!.instructions).toBe('USER EDIT')
    expect((await store.coordinator('CO'))!.proposal).toBeUndefined()
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: expect.stringContaining('outdated') })
  })

  it('refused by the user: nothing saved, nothing logged', async () => {
    await noteTurn(store, 'CO', 'user', 'shorter instructions')
    await cli(['template', 'edit'], moreInstructions)
    const log = await store.workflowLog('CO')
    await answerProposal(deps(), 'CO', false)
    expect((await store.workflow('CO'))!.version).toBe(1)
    expect(await store.workflowLog('CO')).toEqual(log)
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: 'refused' })
    await refused(answerProposal(deps(), 'CO', true), 'No template change waits for you')
  })

  it('each answer sums up its own proposal only; one replaced before an answer says so', async () => {
    // The user changed a reviewer pref in the interface before.
    await store.saveWorkflow('CO', { ...structuredClone(company), prefs: { reviewModel: 'gpt-x' } })
    await noteTurn(store, 'CO', 'user', 'add a v2 type')
    const withV2 = (instructions?: string) => { const t = structuredClone(company); t.prefs = { reviewModel: 'gpt-x' }; t.taskTypes.v2 = { steps: [{ id: 'todo' }, { id: 'done' }] }; if (instructions) t.instructions = instructions; return JSON.stringify(t) }
    await cli(['template', 'edit'], withV2('First try.'))
    await cli(['template', 'edit'], withV2())
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.answers).toEqual([expect.objectContaining({ outcome: 'replaced', by: 'coordinator CO', summary: ['all types: instructions edited', '+ type v2 (2 steps)'] })])
    await answerProposal(deps(), 'CO', true)
    const answers = (await coordinatorsView(store)).find(c => c.project === 'CO')!.answers!
    expect(answers.map(a => a.outcome)).toEqual(['replaced', 'accepted'])
    expect(answers[1]!.summary).toEqual(['+ type v2 (2 steps)'])
  })

  it('works on a project with no workflow yet: its diff is against the default, and its guards come with it', async () => {
    const projects = JSON.parse(await fs.readFile(store.files.projects, 'utf8'))
    await fs.writeFile(store.files.projects, JSON.stringify({ ...projects, projects: [...projects.projects, { key: 'NW', name: 'New', machine: '', path: '/src/nw', addedAt: 1 }] }))
    const nw = await issueToken(store, 'NW')
    await noteTurn(store, 'NW', 'user', 'strict, I merge')
    const r = await cli(['template', 'edit'], JSON.stringify(company), nw) as { diff: string }
    expect(r.diff).toContain('+   "guards"')
    await expect(answerProposal(deps(), 'NW', true)).resolves.toEqual({ accepted: true })
    expect(await store.savedWorkflow('NW')).toMatchObject({ id: 'nw', version: 1, guards: company.guards })
  })

  it('never changes a guard with the token, even in a user turn', async () => {
    await noteTurn(store, 'CO', 'user', 'let the engine merge develop')
    const loosen = edited((t) => { t.guards = { protected: ['main'], merge: { protected: 'user', others: 'engine' } } })
    await refused(cli(['template', 'edit'], loosen), 'Guards')
    const typeGuard = edited((t) => { t.taskTypes.feature!.guards = { merge: { others: 'engine' } } })
    await refused(cli(['template', 'edit'], typeGuard), 'Guards')
    expect((await store.workflow('CO'))!.version).toBe(1)
  })
})

describe('step done', () => {
  it('--user-said ends a step that waits for the user in a user turn, never in a wake', async () => {
    const task = await store.addTask({ project: 'ST', title: 'Split', type: 'feature-split' })
    await store.saveTask({ ...task, state: 'working', step: state(1, { yourTurn: { reason: 'user', badge: 'Create these tasks' } }) })
    const st = await issueToken(store, 'ST')
    const done = ['step', 'done', task.id, '--user-said', 'Yes, create them']
    await noteTurn(store, 'ST', 'wake')
    await refused(cli(done, undefined, st), 'not a wake')
    await noteTurn(store, 'ST', 'user', 'Yes, create them')
    await cli(done, undefined, st)
    const saved = (await store.task(task.id))!
    expect(saved.step).toMatchObject({ done: true })
    expect(saved.log!.at(-1)).toMatchObject({ by: 'coordinator ST', text: 'pick: done on the user\'s message "Yes, create them"' })
  })

  it('ends only a step the coordinator holds; its recheck reminds it', async () => {
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveTask({ ...task, state: 'working', step: state(1) })
    await refused(cli(['step', 'done', task.id]), 'held by the worker')
    const plan = planSteps(company, { type: 'feature' })
    const atDeploy = state(5, { recheckAt: 1000 })
    expect(onEvent(plan, atDeploy, { kind: 'tick' }, 1000).effects).toEqual([expect.objectContaining({ kind: 'instruct', step: 'deploy', holder: 'coordinator' })])
    await store.saveTask({ ...task, state: 'working', step: atDeploy })
    await cli(['step', 'done', task.id, '--link', 'https://ci.example.com/run/1'])
    expect((await store.task(task.id))!.step).toMatchObject({ done: true, proofs: { deploy: { link: 'https://ci.example.com/run/1' } } })
  })
})

describe('Ask the coordinator', () => {
  it('sends the user\'s message to the coordinator, starts its rechecks over and takes the task off Tasks to handle', async () => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    const sent: unknown[] = []
    const call = async (m: string, p: unknown) => { if (m === 'terminal.send') sent.push(p); return m === 'terminal.get' ? { state: 'idle' } : {} }
    const d = { store, call, machines: () => [] } as unknown as Parameters<typeof askCoordinator>[0]
    const urls = { local: 'http://localhost:3000' }
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    const over = { reason: 'timeout' as const, badge: 'Check deploy: over 90m' }
    await store.saveTask({ ...task, state: 'working', step: state(5, { since: 1, rechecks: 4, yourTurn: over }) })
    const plan = planSteps(company, { type: 'feature' })
    expect(toHandle([cardOf((await store.task(task.id))!, plan, [])])).toHaveLength(1)
    const saved = await askCoordinator(d, task.id, urls)
    expect(sent).toEqual([{ terminal: 'host/t9', text: 'Check where CO-1 (Fix) stands at its deploy step and end the step or tell me what blocks it.' }])
    expect((await store.coordinator('CO'))!.turn).toMatchObject({ kind: 'user' })
    expect(saved.step).toMatchObject({ rechecks: 0, yourTurn: undefined, recheckAt: expect.any(Number), deadline: expect.any(Number) })
    expect(saved.log!.map(e => e.text)).toEqual(['asked the coordinator to check the deploy step', 'back to work: the user asked the coordinator'])
    expect(toHandle([cardOf(saved, plan, [])])).toEqual([])
    // Asked: not again until a new time limit or wait; a step at work never.
    await refused(askCoordinator(d, task.id, urls), 'does not wait for you')
    await store.saveTask({ ...saved, step: state(1, { yourTurn: over }) })
    await refused(askCoordinator(d, task.id, urls), 'does not wait for you')
    // The coordinator ends the step while the message is delivered: its progress is kept.
    await store.saveTask({ ...saved, log: [], step: state(5, { since: 1, yourTurn: over }) })
    const ends = async (m: string, p: unknown) => {
      if (m === 'terminal.send') { const t = (await store.task(task.id))!; await store.saveTask({ ...t, step: { ...t.step!, at: 6, since: 2, yourTurn: undefined, proofs: { deploy: { result: 'Deployed' } } } }) }
      return call(m, p)
    }
    const kept = await askCoordinator({ ...d, call: ends } as typeof d, task.id, urls)
    expect(kept.step).toMatchObject({ at: 6, since: 2, proofs: { deploy: { result: 'Deployed' } } })
  })
})

describe('arbitration after N send-backs', () => {
  const f = (id: string, more: Partial<Finding> = {}): Finding => ({ id, severity: 'major', title: id, proof: 'npm test', ...more })
  const decide = (task: string, choice: string, reason = 'The finding is real and small.') => cli(['task', 'decide', task, choice, '--reason', reason])
  const atReview = async (rounds: Finding[][]) => {
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    const plan = planSteps(company, { type: 'feature' })
    let s = state(2)
    for (const fs of rounds) s = onEvent(plan, { ...s, at: 2 }, { kind: 'verdict', from: 'reviewer', findings: fs }, 1).state
    await store.saveTask({ ...task, state: 'working', step: s })
    return task.id
  }

  it('picks among the engine\'s options, with its reason in the task\'s log', async () => {
    const id = await atReview([[f('a')], [f('a')], [f('b')]])
    await refused(decide(id, 'pass'), 'may only choose round or split')
    await decide(id, 'round')
    expect((await store.task(id))!.log!.at(-1)).toMatchObject({ by: 'coordinator CO', text: expect.stringContaining('coordinator chose round') })
    expect((await store.task(id))!.log!.at(-1)!.text).toContain('The finding is real and small.')
  })

  it('passes outside the options in a wake only on a spec change its reason cites', async () => {
    const id = await atReview([[f('a')], [f('a')], [f('b')]])
    await noteTurn(store, 'CO', 'wake')
    await refused(decide(id, 'pass', 'The finding asks for the toggle the user dropped.'), 'may only choose round or split')
    const at = Date.UTC(2026, 10, 9, 12)
    await store.saveTask({ ...(await store.task(id))!, specNotes: [{ at, by: 'coordinator CO', text: 'No toggle in Settings: follow the system theme.' }] })
    await refused(decide(id, 'pass', 'The finding contradicts what the user wants now.'), 'cites the spec change')
    const r = await decide(id, 'pass', 'Finding b asks for a toggle: no toggle in settings, per the spec change.') as { tellUser: string }
    expect(r.tellUser).toContain('on the spec change of 2026-11-09')
    const saved = (await store.task(id))!
    expect(saved.specPass).toMatchObject({ step: 'review', reason: expect.stringContaining('no toggle') })
    expect(saved.log!.at(-1)!.text).toContain('coordinator chose pass on a spec change')
  })

  it('never passes a critical with proof', async () => {
    const id = await atReview([[f('a')], [f('a')], [f('c', { severity: 'critical' })]])
    for (const choice of ['pass', 'worker', 'split']) await refused(decide(id, choice), 'This one is for the user')
  })

  it('needs one sentence of reason', () => {
    expect(parseCommand(['task', 'decide', 'CO-1', 'round'])).toMatchObject({ error: expect.stringContaining('one sentence') })
    expect(parseCommand(['task', 'start', 'CO-1'])).toEqual({ name: 'task start', task: 'CO-1' })
    expect(parseCommand(['task', 'start', 'CO-1', 'x'])).toEqual({ error: 'usage: wherdr pm task start <task> [--on <machine>]' })
    expect(parseCommand(['task', 'start', 'CO-1', '--on', 'machine-b'])).toEqual({ name: 'task start', task: 'CO-1', on: 'machine-b' })
    expect(parseCommand(['task', 'decide', 'CO-1', 'round', '--reason', 'a\nb'])).toMatchObject({ error: expect.stringContaining('one sentence') })
    expect(parseCommand(['task', 'decide', 'CO-1', 'maybe', '--reason', 'x'])).toMatchObject({ error: expect.stringContaining('choice') })
  })
})

it('tell goes to the step\'s agent, else the worker; --to picks one', () => {
  expect(parseCommand(['tell', 'CO-1', 'rework', 'it', '--to', 'worker'])).toEqual({ name: 'tell', task: 'CO-1', text: 'rework it', to: 'worker' })
  expect(parseCommand(['tell', 'CO-1', 'hi', '--to', 'coordinator'])).toEqual({ error: '--to is one of worker, reviewer' })
  expect(parseCommand(['tell', 'CO-1', 'retry', '--fix', 'machine', '--reason', ' Disk full. '])).toEqual({ name: 'tell', task: 'CO-1', text: 'retry', fix: 'machine', reason: 'Disk full.' })
  expect(parseCommand(['tell', 'CO-1', 'retry', '--fix', 'approve', '--reason', 'x'])).toEqual({ error: '--fix is one of base, ci, machine, stall' })
  expect(parseCommand(['tell', 'CO-1', 'retry', '--fix', 'ci'])).toEqual({ error: '--fix and --reason "<one sentence>" go together' })
  const run = (id: string, role: 'worker' | 'reviewer', startedAt: number, more = {}) => ({ id, task: 'CO-1', role, program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: `host/${id}`, attempt: 1, state: 'running' as const, startedAt, ...more })
  const runs = [run('w', 'worker', 1), run('r', 'reviewer', 2)] // the reviewer is the latest
  for (const holder of ['none', 'coordinator', 'worker', undefined] as const) expect(tellTarget(runs, 'CO-1', holder)).toMatchObject({ role: 'worker', run: { id: 'w' } })
  expect(tellTarget(runs, 'CO-1', 'reviewer')).toMatchObject({ role: 'reviewer', run: { id: 'r' } })
  expect(tellTarget(runs, 'CO-1', 'none', 'reviewer')).toMatchObject({ role: 'reviewer', run: { id: 'r' } })
  // A worker let go while the task waited is started again; one that exited is not running.
  expect(tellTarget([run('w', 'worker', 1, { state: 'ended', endedBy: 'released' })], 'CO-1', 'none')).toEqual({ role: 'worker', run: undefined, released: true, review: false })
  expect(tellTarget([run('w', 'worker', 1, { state: 'ended', endedBy: 'exit' })], 'CO-1', 'none')).toEqual({ role: 'worker', run: undefined, released: false, review: false })
  // A fix starts again a worker that ended, not only one let go.
  expect(tellTarget([run('w', 'worker', 1, { state: 'ended', endedBy: 'exit' })], 'CO-1', 'none', undefined, true)).toEqual({ role: 'worker', run: undefined, released: true, review: false })
  // At any step (the merge: held by nobody), however it ended, a stop too; only a removed worktree is not running.
  expect(tellTarget([run('w', 'worker', 1, { state: 'ended', endedBy: 'stopped' })], 'CO-1', 'none', undefined, true)).toEqual({ role: 'worker', run: undefined, released: true, review: false })
  expect(tellTarget([run('w', 'worker', 1, { state: 'ended', endedBy: 'exit' })], 'CO-1', 'none', undefined, true, false)).toEqual({ role: 'worker', run: undefined, released: false, review: false })
  // A fix at the review step, its reviewer not running: the review starts again; without a fix it is not running.
  const gone = [run('r', 'reviewer', 1, { state: 'ended', endedBy: 'exit' })]
  expect(tellTarget(gone, 'CO-1', 'reviewer', undefined, true)).toMatchObject({ role: 'reviewer', run: undefined, review: true })
  expect(tellTarget(gone, 'CO-1', 'reviewer')).toMatchObject({ role: 'reviewer', run: undefined, review: false })
})


describe('role files', () => {
  // A fake herdr-core: the machine's home is /h; files written; terminals started.
  // ended: its terminals end at once (a session that never comes up).
  const fakeCore = (local = true, ended = false) => {
    const written: string[] = [], runs: Record<string, unknown>[] = [], scripts = new Map<string, string>()
    const call = async (method: string, params: Record<string, unknown>) => {
      const argv = params.argv as string[] | undefined
      if (method === 'machine.exec' && argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from('/h').toString('base64') }
      // The repository's remote and gh's answer: a public GitHub repository.
      if (method === 'machine.exec' && argv?.[2] === REMOTE_SCRIPT) return { code: 0, stdout: Buffer.from('git@github.com:o/co.git\n{"visibility":"PUBLIC"}').toString('base64') }
      if (method === 'machine.exec') return written.push(argv![4]!), scripts.set(argv![4]!, argv![2]!), { code: 0, stdout: '' }
      // Up at once: no trust dialog to answer, the first message delivered.
      if (method === 'terminal.get') return ended ? { state: 'finished' } : { state: 'live', status: 'idle' }
      if (method === 'terminal.read') return { text: '> ' }
      runs.push({ method, ...params })
      return { address: `host/t${runs.length + 4}` }
    }
    const machines = () => [{ key: '', label: 'here', local, status: 'online' }]
    return { written, runs, scripts, deps: { store, call, machines } as unknown as Parameters<typeof startCoordinator>[0] }
  }
  const urls = { local: 'http://127.0.0.1:7690', remote: 'https://host.tailnet.example' }

  it('are written in the coordinator\'s own folder when it starts, with a new token and its wherdr script in its environment', async () => {
    const { written, runs, scripts, deps } = fakeCore()
    const r = await startCoordinator(deps, 'CO', { program: 'claude', model: 'opus' }, urls)
    expect(r).toEqual({ terminal: 'host/t5', folder: '/h/.wherdr/pm/coordinators/CO' })
    expect(written.every(f => f.startsWith('/h/.wherdr/pm/coordinators/CO/'))).toBe(true)
    expect(written).toContain('/h/.wherdr/pm/coordinators/CO/bin/wherdr')
    // Its memory is its own: created only when missing, so a restart or another program keeps it.
    expect(scripts.get('/h/.wherdr/pm/coordinators/CO/memory.md')).toBe(CREATE_SCRIPT)
    expect(runs[0]).toMatchObject({ cwd: '/h/.wherdr/pm/coordinators/CO', labels: { 'wherdr.coordinator': 'CO' }, env: { DISABLE_AUTOUPDATER: '1', WHERDR_URL: urls.local } })
    expect(runs[0]!.line).toContain(`export PATH='/h/.wherdr/pm/coordinators/CO/bin':"$PATH"; exec 'claude' '--model' 'opus' '--add-dir' '/src/co'`)
    const fresh = (runs[0]!.env as { WHERDR_PM_TOKEN: string }).WHERDR_PM_TOKEN
    await refused(cli(['list']), 'Unknown coordinator token')
    await expect(cli(['list'], undefined, fresh)).resolves.toBeTruthy()
    expect((await store.coordinator('CO'))!).toMatchObject({ terminal: 'host/t5', version: pkg.version })
    // Its repository's visibility, checked once at its first start.
    expect((await store.projects()).find(p => p.key === 'CO')!.visibility).toMatchObject({ value: 'public', by: 'check' })
  })

  it('answer the trust dialog of the coordinator\'s own new folder at its first start, and no other screen', async () => {
    const { deps } = fakeCore()
    const fixture = (name: string) => fs.readFile(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8')
    const folder = '/h/.wherdr/pm/coordinators/CO'
    let screen = (await fixture('claude-trust-folder')).replace('/home/user/projects/new-folder', folder)
    const keys: unknown[] = []
    const call = deps.call as (m: string, p: Record<string, unknown>) => Promise<unknown>
    const d = { ...deps, pollMs: 1, queueWatchMs: 50, call: async (m: string, p: Record<string, unknown>) => {
      if (m === 'terminal.get') return { state: 'live', status: null }
      if (m === 'terminal.read') return { text: screen }
      if (m === 'terminal.keys') return keys.push(p.keys), {}
      return call(m, p)
    } } as typeof deps
    await startCoordinator(d, 'CO', { program: 'claude' }, urls)
    await vi.waitFor(() => expect(keys).toEqual([['down', 'enter']]))
    // Whatever order or wording the dialog has (Claude's older one, Codex's); never a folder of the user's own.
    expect(trustKeys((await fixture('claude-trust')).replace('/home/user/code/example', folder), folder)).toEqual(['enter'])
    expect(trustKeys((await fixture('codex-trust-folder')).replace('/home/user/code/example', folder), folder)).toEqual(['enter'])
    expect(trustKeys(await fixture('claude-trust-folder'), folder)).toBeUndefined()
    expect(trustKeys(`${folder}\n❯ 1. Yes\n  2. No`, folder)).toBeUndefined()
    expect(trustKeys((await fixture('claude-trust-folder')).replace('/home/user/projects/new-folder', `${folder}-other`), folder)).toBeUndefined()
    expect(trustKeys((await fixture('codex-trust')).replace('/home/user/code/example', folder), folder)).toEqual(['enter'])
    expect(trustKeys((await fixture('claude-trust-folder')).replace('/home/user/projects/new-folder', `/tmp/team ${folder}`), folder)).toBeUndefined()
    expect(trustKeys((await fixture('codex-trust')).replace('/home/user/code/example', `/tmp/team ${folder}`), folder)).toBeUndefined()
    // Setup step 3 follows the agent: starting, asking (the dialog left unanswered), then running.
    expect([undefined, { status: null }, { status: 'unknown' }, { status: 'blocked' }, { status: null, screen: {} }, { status: 'idle' }].map(x => coordinatorStart(x as never)))
      .toEqual(['none', 'starting', 'starting', 'asks', 'asks', 'runs'])
    // Next and the wizard's resume wait on it: step 3 is done only once it runs, with no workflow yet.
    const o = { enabled: true, projects: [{ key: 'CO', name: 'CO', machine: '', path: '/src', addedAt: 1 }], tasks: [] }
    const coords = [{ project: 'CO', terminal: 'host/t1' }]
    expect((['none', 'asks', 'starting', 'runs'] as const).map(s => setupDone(o, 'CO', coords, s).coordinator)).toEqual([false, false, false, true])
    expect(setupDone(o, 'CO', coords).coordinator).toBe(true)
    screen = ''
  })

  it('start with the project\'s default agent, remember the agent that ran, and a new conversation replaces the old one', async () => {
    const { runs, deps } = fakeCore()
    // No default set yet: none in the view (the client offers the user's first agent).
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.agent).toBeUndefined()
    await setCoordinatorAgent(store, 'CO', { program: 'claude', model: 'sonnet' })
    await startCoordinator(deps, 'CO', {}, urls)
    // Its model chosen with it (the setup window's step 2), kept for a resume; an invalid one is dropped.
    expect(runs[0]!.line).toMatch(/exec 'claude' '--model' 'sonnet' '--add-dir' '\/src\/co'$/)
    expect(await store.coordinator('CO')).toMatchObject({ ran: { program: 'claude', model: 'sonnet' } })
    expect((await setCoordinatorAgent(store, 'CO', { program: 'claude', model: '-rf /' })).agent).toEqual({ program: 'claude' })
    await setCoordinatorAgent(store, 'CO', { program: 'codex' })
    // The default and the agent of the kept conversation stay apart, and survive a new token.
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')).toMatchObject({ agent: { program: 'codex' }, ran: { program: 'claude' }, terminal: 'host/t5' })
    await startCoordinator(deps, 'CO', {}, urls)
    expect(runs.map(r => [r.method, r.terminal ?? r.cwd])).toEqual([['terminal.run', '/h/.wherdr/pm/coordinators/CO'], ['terminal.run', '/h/.wherdr/pm/coordinators/CO'], ['terminal.kill', 'host/t5']])
    expect((await store.coordinator('CO'))).toMatchObject({ agent: { program: 'codex' }, ran: { program: 'codex' }, terminal: 'host/t6' })
    // OMP runs Alfred, but nothing would keep it out of a project's repository.
    await refused(setCoordinatorAgent(store, 'CO', { program: 'omp' }), 'claude or codex')
    await refused(startCoordinator(deps, 'CO', { program: 'omp' }, urls), 'claude or codex')
    await setCoordinatorAgent(store, MAIN, { program: 'omp' })
    await refused(setCoordinatorAgent(store, 'CO', { program: 'cline' }), 'an agent that can coordinate')
    await refused(setCoordinatorAgent(store, 'NOPE', { program: 'claude', model: 'opus' }), 'Unknown project')
  })

  it('resume its last conversation in its folder, with the agent that ran it and the same options', async () => {
    const { runs, deps } = fakeCore()
    await refused(startCoordinator(deps, 'CO', { resume: true }, urls), 'No conversation to resume')
    await startCoordinator(deps, 'CO', { program: 'codex' }, urls)
    await setCoordinatorAgent(store, 'CO', { program: 'claude' })
    await startCoordinator(deps, 'CO', { resume: true }, urls, ['A task was reported'])
    expect(runs[1]).toMatchObject({ cwd: '/h/.wherdr/pm/coordinators/CO', labels: { 'wherdr.coordinator': 'CO' } })
    // Its message is typed once it is ready: a word after `resume --last` would be read as a session.
    expect(runs[1]!.line).toMatch(/exec 'codex' '-c' 'check_for_update_on_startup=false' '-C' '\/h\/\.wherdr\/pm\/coordinators\/CO' .*'permissions\.wherdr\.network\.enabled=true' 'resume' '--last'$/)
    expect(await store.coordinator('CO')).toMatchObject({ ran: { program: 'codex' }, agent: { program: 'claude' }, terminal: 'host/t6' })
    await startCoordinator(deps, 'CO', {}, urls)
    await startCoordinator(deps, 'CO', { resume: true }, urls)
    expect(runs.filter(r => r.method === 'terminal.run').at(-1)!.line).toMatch(/exec 'claude' '--continue' '--add-dir' '\/src\/co'$/)
  })

  it('first start on a project with no accepted workflow: no template needed, its first reply proposes one, in the user\'s turn; not again', async () => {
    const { runs, deps } = fakeCore()
    const projects = JSON.parse(await fs.readFile(store.files.projects, 'utf8'))
    await fs.writeFile(store.files.projects, JSON.stringify({ ...projects, projects: [...projects.projects, { key: 'NW', name: 'New', machine: '', path: '/src/nw', addedAt: 1 }] }))
    expect(isDefaultWorkflow(await store.workflow('NW'))).toBe(true)
    await startCoordinator(deps, 'NW', { program: 'codex' }, urls)
    expect(runs[0]!.line).toContain(FIRST_REPLY)
    // Starting it is the user's gesture: its `template edit` is allowed.
    expect((await store.coordinator('NW'))!.turn).toMatchObject({ kind: 'user', said: FIRST_REPLY })
    // A project with an accepted workflow: no proposal.
    await startCoordinator(deps, 'CO', { program: 'codex' }, urls)
    expect(runs.filter(r => r.method === 'terminal.run')[1]!.line).not.toContain(FIRST_REPLY)
    await startCoordinator(deps, 'NW', { program: 'codex' }, urls)
    expect(runs.filter(r => r.method === 'terminal.run')[2]!.line).not.toContain(FIRST_REPLY)
  })

  it('a fresh start whose session never comes up: its first message is logged as not delivered, and the next start gives it again', async () => {
    const projects = JSON.parse(await fs.readFile(store.files.projects, 'utf8'))
    await fs.writeFile(store.files.projects, JSON.stringify({ ...projects, projects: [...projects.projects, { key: 'NW', name: 'New', machine: '', path: '/src/nw', addedAt: 1 }] }))
    await startCoordinator(fakeCore(true, true).deps, 'NW', { program: 'claude' }, urls)
    await expect.poll(async () => (await store.coordinator('NW'))?.undelivered).toMatchObject({ texts: [FIRST_REPLY], why: 'its session ended before it was ready' })
    expect((await store.projectLog('NW')).map(e => e.text)).toContain('first message not delivered: its session ended before it was ready')
    const { runs, deps } = fakeCore()
    await startCoordinator(deps, 'NW', { program: 'claude' }, urls)
    expect(runs[0]!.line).toContain(FIRST_REPLY)
    await expect.poll(async () => (await store.coordinator('NW'))?.undelivered).toBeUndefined()
    // Its delivery logs in the background: wait for it, or it writes into the
    // project log while afterEach removes the folder (ENOTEMPTY).
    await expect.poll(async () => (await store.projectLog('NW')).map(e => e.text)).toContain('first message given at its start, its session is up')
  })

  it('on another machine, the coordinator gets wherdr\'s published address, never loopback', async () => {
    const remote = fakeCore(false)
    await startCoordinator(remote.deps, 'CO', { program: 'codex', model: 'gpt-5' }, urls)
    expect(remote.runs[0]).toMatchObject({ on: 'here', env: { WHERDR_URL: urls.remote } })
    await refused(startCoordinator(fakeCore(false).deps, 'CO', { program: 'codex', model: 'gpt-5' }, { local: urls.local }), 'publish it on your tailnet')
  })

  it('create a coordinator\'s own file once and never overwrite it', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'own-')), 'c/memory.md')
    const create = (text: string) => execFileSync('sh', ['-c', CREATE_SCRIPT, 'sh', file], { input: text })
    create('first\n')
    create('second\n')
    expect(await fs.readFile(file, 'utf8')).toBe('first\n')
  })

  it('say who it is, its commands, each plan and the user\'s instructions, all inside its own folder', () => {
    const files = roleFiles({ key: 'CO', name: 'Company', machine: '', path: '/src/co', from: { template: 'company', version: 1 }, addedAt: 1 }, company, EXAMPLES)
    expect(Object.keys(files).sort()).toEqual(['.claude/settings.json', '.claude/skills/wherdr-pm/SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'bin/wherdr'])
    const agents = files['AGENTS.md']!
    expect(agents).toContain('You coordinate project CO only')
    expect(agents).toContain('`memory.md` in your folder is yours')
    expect(agents).toContain('`wherdr pm task link <task> <url> --label <label>`')
    expect(agents).toContain('- deploy (Deploy): holder coordinator, ends report, recheck 5m, timeout 90m')
    expect(agents).toContain('- Base branch is develop.')
    expect(agents).toContain('copied from template company v1 (the template library never changes it)')
    expect(agents).not.toContain('## Your first conversation')
    // No accepted workflow yet: the first conversation sets one up.
    const first = roleFiles({ key: 'CO', name: 'Company', machine: '', path: '/src/co', addedAt: 1 }, defaultWorkflow('CO'), EXAMPLES)['AGENTS.md']!
    expect(first).toContain('## Your first conversation')
    expect(first).toContain('propose a workflow with `template edit`')
    expect(first).toContain('In that same first reply, propose a workflow')
    expect(agents).toContain('"id":"vibe"')
    expect(agents).toContain('with its absolute path (`/src/co/README.md`)')
    expect(files['CLAUDE.md']).toBe('@AGENTS.md\n')
    expect(JSON.parse(files['.claude/settings.json']!).permissions.deny).toEqual(['Edit(//src/co/**)'])
    const codex = coordinatorArgs('codex', '/h/c', '/src/co')
    expect(codex).not.toContain('--model')
    expect(coordinatorArgs('omp', '/h/c', '/src/co')).toEqual(['omp'])
    expect(codex).not.toContain('--add-dir')
    expect(codex).not.toContain('-s') // a sandbox mode would bring back the profile-less sandbox, without network
    expect(codex).toEqual(expect.arrayContaining(['default_permissions="wherdr"', 'permissions.wherdr.extends=":workspace"', 'permissions.wherdr.network.enabled=true']))
  })
  it('mention pr merge only when the project\'s contributorPrs guard is on', () => {
    const p = { key: 'CO', name: 'Company', machine: '', path: '/src/co', addedAt: 1 }
    const off = roleFiles(p, company, EXAMPLES), on = roleFiles(p, { ...company, guards: { ...company.guards, contributorPrs: 'others' } }, EXAMPLES)
    for (const f of ['AGENTS.md', '.claude/skills/wherdr-pm/SKILL.md']) {
      expect(off[f]).not.toContain('pr merge')
      expect(on[f]).toContain('`wherdr pm pr merge <number> --user-said "<their words>" [--method squash|merge|rebase]`')
    }
    expect(on['AGENTS.md']).toContain('never into a branch reserved for the user; never a board task\'s PR')
  })
})

describe('pr merge (WHR-42)', () => {
  // A fake herdr-core: gh answers the PR's details, and records the merge.
  const fake = (view: object) => {
    const merged: string[][] = []
    const call = async (_m: string, params: { argv: string[] }) => {
      const [script, ...args] = params.argv.slice(2)
      if (script!.includes('gh pr view')) return { code: 0, stdout: Buffer.from(JSON.stringify(view)).toString('base64') }
      if (script!.includes('gh pr merge')) return merged.push(args.slice(1)), { code: 0, stdout: '' }
      throw new Error('unexpected call')
    }
    return { merged, deps: { store, call, machines: () => [{ key: '', local: true }] } as unknown as Parameters<typeof runCommand>[0] }
  }
  const view = { number: 9, url: 'https://github.com/o/co/pull/9', state: 'OPEN', baseRefName: 'docs', headRefName: 'fix-typo', headRefOid: 'abc', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }
  const argv = ['pr', 'merge', '9', '--user-said', 'yes, merge it', '--method', 'squash']

  it('merges after the user\'s yes with the guard on, and writes it to the project\'s log', async () => {
    expect(parseCommand(['pr', 'merge', '9'])).toEqual({ error: '--user-said needs the user\'s words' })
    const { merged, deps: d } = fake(view)
    await noteTurn(store, 'CO', 'user', 'yes, merge it')
    await refused(runCommand(d, token, { argv }), 'is off')
    const t = (await store.workflow('CO'))!
    await store.saveWorkflow('CO', { ...t, guards: { ...t.guards, contributorPrs: 'others' } })
    await noteTurn(store, 'CO', 'wake')
    await refused(runCommand(d, token, { argv }), 'never a wake')
    expect(merged).toEqual([])
    await noteTurn(store, 'CO', 'user', 'yes, merge it')
    expect(await runCommand(d, token, { argv })).toEqual({ merged: view.url, into: 'docs' })
    expect(merged).toEqual([['/src/co', view.url, 'abc', 'squash']])
    expect(await store.projectLog('CO')).toEqual([{ at: expect.any(Number), by: 'coordinator CO', pr: 9, said: 'yes, merge it', text: 'merged contributor PR #9 into docs (squash) on the user\'s yes: "yes, merge it"' }])
  })
})

it('wherdr pm sends its words with the token, and template edit sends stdin', async () => {
  const calls: { url: string, init: { headers: Record<string, string>, body: string } }[] = []
  const request = async (url: string, init: { headers: Record<string, string>, body: string }) => {
    calls.push({ url, init })
    return { ok: true, status: 200, headers: new Headers({ 'x-wherdr-notice': 'wherdr was updated' }), json: async () => ({ version: 2 }) }
  }
  let printed = ''
  const out = { write: (s: string) => { printed += s } }
  async function* stdin() { yield '{"id":"company"}' }
  await pm(['template', 'edit'], { env: { WHERDR_PM_TOKEN: 'abc', WHERDR_URL: 'http://127.0.0.1:7690' }, stdin: stdin(), out, request })
  expect(calls[0]!.url).toBe('http://127.0.0.1:7690/api/pm/cli')
  expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer abc', origin: 'http://127.0.0.1:7690' })
  expect(JSON.parse(calls[0]!.init.body)).toEqual({ argv: ['template', 'edit'], input: '{"id":"company"}' })
  expect(printed).toMatch(/^wherdr was updated\n\{/)
  await expect(pm(['list'], { env: {}, request })).rejects.toThrow('WHERDR_PM_TOKEN')
})

// The script written in the coordinator's folder, run for real (sh, base64, curl)
// against a server that answers with runCommand.
it('the folder\'s wherdr script sends any words and stdin, and fails on a refusal', async () => {
  const http = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { WHERDR_SCRIPT } = await import('../shared/pm/coordinator')
  const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const ok = req.headers.origin === `http://${req.headers.host}`
      try {
        if (!ok) throw new Error('Origin refused')
        const answer = await runCommand(deps(), String(req.headers.authorization).slice(7), JSON.parse(raw))
        // As server/api/pm/cli.post.ts does.
        const notice = await takeUpdateNotice(store, 'CO')
        if (notice) res.setHeader('x-wherdr-notice', notice)
        res.end(JSON.stringify(answer))
      }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: (e as Error).message })) }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const script = path.join(dir, 'wherdr')
  await fs.writeFile(script, WHERDR_SCRIPT, { mode: 0o755 })
  const run = (args: string[], input = '') => new Promise<{ code: number, out: string }>((resolve) => {
    const child = execFile(script, args, { env: { PATH: process.env.PATH, WHERDR_URL: url, WHERDR_PM_TOKEN: token } }, (e, out) => resolve({ code: e ? Number(e.code) : 0, out }))
    // A script that exits before reading stdin (`list`) closes the pipe first: not a failure.
    child.stdin!.on('error', () => {})
    child.stdin!.end(input)
  })
  // CO's session started on an older wherdr; ST's on this one.
  await store.saveCoordinator({ ...(await store.coordinator('CO'))!, version: '0.0.1' })
  await store.saveCoordinator({ project: 'ST', tokenHash: '', version: '0.0.1' })
  try {
    const tag = await run(['pm', 'task', 'tag', task.id, 'say "hi" \\ ünï'])
    expect(tag.code).toBe(0)
    // Told once, as the first line of its next command; never again.
    expect(tag.out).toMatch(new RegExp(`^wherdr was updated to ${pkg.version.replace(/\./g, '\\.')} since your session started: re-read AGENTS.md and check docs/llms.txt[^\n]*\n\\{`))
    expect((await run(['pm', 'list'])).out).toMatch(/^\{/)
    // Another coordinator's record is not touched.
    expect((await store.coordinator('ST'))!.told).toBeUndefined()
    expect((await store.task(task.id))!.tags).toEqual(['say "hi" \\ ünï'])
    const edit = await run(['pm', 'template', 'edit'], JSON.stringify(company))
    expect(edit.code).not.toBe(0)
    expect(edit.out).toContain('only for a turn that comes from the user')
    expect((await run(['list'])).code).toBe(2)
  }
  finally { server.close() }
})

it('an update notice only when the session started on another version, and only once', () => {
  expect(updateNotice({ version: '3.0.0' }, '3.1.0')).toContain('updated to 3.1.0')
  expect(updateNotice({ version: '3.0.0', told: '3.1.0' }, '3.1.0')).toBeUndefined()
  expect(updateNotice({ version: '3.0.0', told: '3.1.0' }, '3.2.0')).toContain('updated to 3.2.0')
  expect(updateNotice({ version: '3.1.0' }, '3.1.0')).toBeUndefined()
  // A new build of the same version (the commit is part of it).
  expect(updateNotice({ version: '3.0.0-dev+aaaaaaa' }, '3.0.0-dev+bbbbbbb')).toContain('updated to 3.0.0-dev+bbbbbbb')
  // An agent with no coordinator session (a task's worker, or none recorded).
  expect(updateNotice(null, '3.1.0')).toBeUndefined()
  expect(updateNotice({}, '3.1.0')).toBeUndefined()
})

describe('wakes', () => {
  const deliver = (status: string, now: number) => {
    const sent: { terminal: string, text: string }[] = [], pushed: string[] = [], bodies: string[] = []
    const call = async (method: string, params: Record<string, string>) => {
      if (method === 'terminal.get') return { status }
      if (method === 'terminal.send') sent.push({ terminal: params.terminal!, text: params.text! })
      return {}
    }
    const notify = async (title: string, body: string) => { pushed.push(title); bodies.push(body) }
    const d = { store, call, notify, machines: () => [] } as unknown as Parameters<typeof wakeTick>[0]
    return { sent, pushed, bodies, d, run: () => wakeTick(d, now) }
  }
  const atDeploy = async (since: number) => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveTask({ ...task, state: 'working', step: state(5, { since, recheckAt: since + 300_000 }) })
    return task.id
  }
  const wakeId = (text: string) => /wherdr pm ack ([0-9a-f]{8})/.exec(text)![1]!

  it('tells the coordinator its step once, then each recheck, as a Step check wake turn', async () => {
    const id = await atDeploy(1000)
    const first = deliver('idle', 2000)
    expect(await first.run()).toEqual(['CO'])
    expect(first.sent).toEqual([{ terminal: 'host/t9', text: expect.stringMatching(/^Step check: CO-1 \([\w-]+\), wake [0-9a-f]{8}\n\nCO-1 \(Fix\): Base branch is develop\.[\s\S]*Watch the develop pipeline/) }])
    expect((await store.coordinator('CO'))!.turn).toMatchObject({ kind: 'wake' })
    // A wake turn: the user's words cannot be claimed.
    await store.saveTask({ ...(await store.task(id))!, step: { ...(await store.task(id))!.step!, at: 4, yourTurn: { reason: 'user', badge: 'Merge the PR' } } })
    await refused(cli(['step', 'done', id, '--user-said', 'merged']), 'not a wake')
    await store.saveTask({ ...(await store.task(id))!, step: { ...(await store.task(id))!.step!, at: 5, yourTurn: undefined } })
    expect(await deliver('idle', 3000).run()).toEqual([])
    await cli(['ack', wakeId(first.sent[0]!.text)])
    const recheck = deliver('idle', 1000 + 300_000)
    await recheck.run()
    expect(recheck.sent[0]!.text).toContain('Check again: ')
  })

  it('names tasks by the shown key of a renamed project: wakes, the push, pm list, logs, refusals', async () => {
    await store.updateProject('CO', { key: 'ABC' })
    const id = await atDeploy(1000)
    expect(id).toBe('CO-1') // stored ids keep the fixed key
    const first = deliver('idle', 2000)
    await first.run()
    expect(first.sent[0]!.text).toContain('ABC-1 (Fix): ')
    expect(first.sent[0]!.text).not.toMatch(/\bCO-1\b/)
    await deliver('idle', 3000).run()
    await deliver('idle', 2000 + WAKE.ACK_MS + WAKE.IDLE_MS).run()
    await deliver('idle', 3000 + WAKE.ACK_MS + WAKE.IDLE_MS).run()
    const last = deliver('idle', 3000 + 2 * (WAKE.ACK_MS + WAKE.IDLE_MS))
    await last.run()
    expect(last.pushed).toEqual(['ABC: the coordinator is not answering'])
    expect(last.bodies[0]).toContain('ABC-1 (Fix)')
    // Both keys still name the task; the output reads the shown one.
    expect((await cli(['list']) as { tasks: { id: string }[] }).tasks.map(t => t.id)).toEqual(['ABC-1'])
    for (const k of ['CO-1', 'ABC-1']) expect((await cli(['show', k]) as { task: { id: string } }).task.id).toBe('ABC-1')
    await store.logTask((await store.task(id))!, 'engine', `after CO-1, in ~/.wherdr/pm/worktrees/CO-1 on task/CO-1`)
    expect((await store.task(id))!.log!.at(-1)!.text).toBe('after ABC-1, in ~/.wherdr/pm/worktrees/CO-1 on task/CO-1')
    await refused(cli(['task', 'remove', id, '--reason', 'not needed']), 'ABC-1 has started')
  })

  it('waits while the coordinator works or the user just wrote; the queue keeps the reason', async () => {
    await atDeploy(1000)
    expect(await deliver('working', 2000).run()).toEqual([])
    expect(await store.wakes()).toHaveLength(1)
    await userMessageTo(store, 'host/t9', 'hi')
    const quiet = deliver('idle', Date.now() + 10_000)
    expect(await quiet.run()).toEqual([])
    const later = deliver('idle', Date.now() + WAKE.QUIET_MS)
    expect(await later.run()).toEqual(['CO'])
    expect(later.sent[0]!.text).toContain('CO-1 (Fix)')
  })

  it('an unacked wake comes back once, then the user gets a push', async () => {
    await atDeploy(1000)
    await deliver('idle', 2000).run()
    // Its turn ends after 2 min idle; 15 min without ack: again.
    await deliver('idle', 3000).run()
    const again = deliver('idle', 2000 + WAKE.ACK_MS + WAKE.IDLE_MS)
    await again.run()
    expect(again.sent[0]!.text).toContain('(again: no ack after 15 min)')
    await deliver('idle', 3000 + WAKE.ACK_MS + WAKE.IDLE_MS).run()
    const last = deliver('idle', 3000 + 2 * (WAKE.ACK_MS + WAKE.IDLE_MS))
    await last.run()
    expect(last.pushed).toEqual(['CO: the coordinator is not answering'])
    await refused(cli(['ack', 'deadbeef']), 'No wake deadbeef')
  })

  it('run now goes over an open wake; the autopilot wakes for its events', async () => {
    const ap = { on: true, goal: 'Ship lot 10', events: ['added'], perDay: 3, atOnce: 1 }
    await atDeploy(1000)
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { ...ap, events: ['added'] } })
    const first = deliver('idle', 2000)
    await first.run() // notes where tasks stand: no "added" for what was there
    expect(first.sent[0]!.text).not.toContain('added')
    await store.addTask({ project: 'CO', title: 'New', type: 'feature' })
    const now = deliver('idle', 4000)
    await runNow(now.d, 'CO', 4000)
    expect(now.sent[0]!.text).toContain('The user asked you to run now. Your goal: Ship lot 10.')
    expect(now.sent[0]!.text).toContain('CO-2 (New): added')
  })

  it('wakes for a routine with its own goal, once for slots missed while down', async () => {
    const day = (d: number, h: number) => new Date(2026, 10, d, h).getTime()
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9', routineRan: { r1: day(1, 9) }, oneWake: true, autopilot: { on: true, goal: 'Triage', routines: [{ id: 'r1', when: 'daily 08:00', goal: 'Summarise the night', on: true }], events: [], perDay: 3, atOnce: 1 } })
    expect(await deliver('idle', day(2, 7)).run()).toEqual([])
    const late = deliver('idle', day(5, 10))
    expect(await late.run()).toEqual(['CO'])
    expect(late.sent[0]!.text).toContain('Routine: Summarise the night.')
    expect((await store.coordinator('CO'))!.routineRan).toEqual({ r1: day(5, 10) })
    expect((await store.wakes()).filter(w => w.reasons.some(r => r.startsWith('Routine')))).toHaveLength(1)
  })

  describe('nothing to do', () => {
    // Day 2 is today: the skipped wakes are counted per local day.
    const day = (d: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d - 2); x.setHours(h, m, 0, 0); return x.getTime() }
    const scheduled = async () => (await store.wakes()).filter(w => w.reasons.some(r => r.startsWith('Scheduled'))).length
    // A project whose tasks are all done, woken once since: asleep.
    const asleep = async (more: Partial<typeof DEFAULT_AUTOPILOT> = {}) => {
      const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
      await store.saveTask({ ...task, step: state(5, { done: true }) })
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9', ranAt: day(2, 6), seen: { 'CO-1': 'done' }, woke: { at: day(2, 6), seen: { 'CO-1': 'done' } },
        autopilot: { on: true, goal: 'Triage', every: '30m', events: ['added', 'done', 'stuck'], perDay: 3, atOnce: 1, ...more } })
      return task
    }

    it('skips the interval wake, marks the slot run and counts them', async () => {
      await asleep()
      expect(await deliver('idle', day(2, 8, 1)).run()).toEqual([])
      expect(await scheduled()).toBe(0)
      const c = (await store.coordinator('CO'))!
      expect(c).toMatchObject({ ranAt: day(2, 8, 1), skipped: { n: 1 } })
      // Marked run: the slot does not fire again.
      expect(await deliver('idle', day(2, 8, 2)).run()).toEqual([])
      expect((await store.coordinator('CO'))!.skipped!.n).toBe(1)
      expect(await cli(['autopilot', 'show'])).toMatchObject({ lookForWork: false, today: { skippedWakes: 1 }, pacing: 'claude · quota unknown (no reading of claude on this project\'s machine) · task-count limits only' })
      expect((await coordinatorsView(store)).find(v => v.project === 'CO')).toMatchObject({ asleep: 'idle', wokeAt: day(2, 6), skippedToday: 1 })
    })

    it('skips a scheduled wake while the worker\'s account is ahead of its pace, marked run', async () => {
      const task = await asleep()
      await store.saveTask({ ...task, state: 'waiting', step: state(5) })
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, seen: { 'CO-1': 'waiting' } })
      const now = day(2, 8, 1)
      // The account hit its 5-hour limit (the default pace, Free, waits only for that).
      quotas.q = { codex: null, claude: { at: now, limited: { resetsAt: now + 3_600_000 }, five: { used: 100, resetsAt: now + 3_600_000, minutes: 300 }, week: { used: 20, resetsAt: now + 3 * 86_400_000, minutes: 10080 } }, accounts: [{ key: 'claude:ab12cd34', program: 'claude', machines: [''] }] }
      expect(await deliver('idle', now).run()).toEqual([])
      expect(await scheduled()).toBe(0)
      expect((await store.coordinator('CO'))!).toMatchObject({ ranAt: now, skipped: { n: 1 } })
      // Marked run: the next tick does not try again.
      expect(await deliver('idle', day(2, 8, 2)).run()).toEqual([])
      expect((await store.coordinator('CO'))!.skipped!.n).toBe(1)
    })

    it('wakes when a task is not done, or something changed since the last wake', async () => {
      const task = await asleep()
      await store.saveTask({ ...task, state: 'waiting', step: state(5) })
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, seen: { 'CO-1': 'waiting' } })
      expect(await deliver('idle', day(2, 8, 1)).run()).toEqual(['CO'])
      expect(await scheduled()).toBe(1)
      // Done again (an event wake), then the user wrote since that wake.
      await store.saveTask({ ...task, step: state(5, { done: true }) })
      await deliver('idle', day(2, 8, 2)).run()
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, userAt: day(2, 8, 3) })
      const t = day(2, 8, 40)
      await deliver('idle', t).run()
      expect((await store.coordinator('CO'))!).toMatchObject({ ranAt: t, woke: { at: t, seen: { 'CO-1': 'done' } } })
      expect((await store.coordinator('CO'))!.skipped).toBeUndefined()
      // That wake noted where tasks stand: the next slot sleeps.
      await deliver('idle', t + 31 * 60_000).run()
      expect((await store.coordinator('CO'))!).toMatchObject({ woke: { at: t }, skipped: { n: 1 } })
    })

    it('keeps the scheduled wakes with "look for new work", within its daily limit', async () => {
      await asleep({ lookForWork: true, lookPerDay: 1 })
      expect((await coordinatorsView(store)).find(v => v.project === 'CO')!.asleep).toBeUndefined()
      const r = deliver('idle', day(2, 8, 1))
      expect(await r.run()).toEqual(['CO'])
      expect(r.sent[0]!.text).toContain('Scheduled wake (every 30m). Nothing is under way: look for new work toward your goal. Your goal: Triage.')
      // Its turn adds one task, then the limit holds until tomorrow.
      expect((await store.coordinator('CO'))!.turn).toMatchObject({ kind: 'wake', look: true })
      await cli(['task', 'add', 'More', 'tests', '--type', 'feature'])
      await refused(cli(['task', 'add', 'Even', 'more', '--type', 'feature']), 'limit of new work is reached (1 tasks')
      expect(await cli(['autopilot', 'show'])).toMatchObject({ lookForWork: true, today: { newWorkAdded: 1, newWorkPerDay: 1 } })
      // That task done and seen: idle again, and the limit is reached.
      const added = (await store.tasks()).find(t => t.title === 'More tests')!
      await store.saveTask({ ...added, step: state(5, { done: true }) })
      const seen = { 'CO-1': 'done', [added.id]: 'done' } as const
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, seen: { ...seen }, woke: { at: day(2, 8, 2), seen: { ...seen } }, health: { at: day(2, 8, 2), seen: { ...seen } } })
      expect(await deliver('idle', day(2, 8, 40)).run()).toEqual([])
      expect((await store.coordinator('CO'))!).toMatchObject({ ranAt: day(2, 8, 40), skipped: { n: 1 } })
      expect((await coordinatorsView(store)).find(v => v.project === 'CO')!.asleep).toBe('limit')
      // A user's turn is never limited by it.
      await noteTurn(store, 'CO', 'user', 'add one')
      await cli(['task', 'add', 'Mine', '--type', 'feature'])
    })

    it('the new work limit ends with the day', async () => {
      await asleep({ lookForWork: true, lookPerDay: 1 })
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, lookAdded: { day: new Date(day(1, 12)).toDateString(), n: 1 } })
      expect(await deliver('idle', day(2, 8, 1)).run()).toEqual(['CO'])
    })

    it('one scheduled wake carries the goal and the health lines; skipped with nothing new to report; none with the autopilot off', async () => {
      await asleep()
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, health: { at: day(2, 6), seen: { 'CO-1': 'working' } } })
      const r = deliver('idle', day(2, 8, 1))
      expect(await r.run()).toEqual(['CO'])
      expect(r.sent[0]!.text).toMatch(/^Autopilot: scheduled wake [0-9a-f]{8}\n\nScheduled wake \(every 30m\)\. Your goal: Triage\.[^\n]*\n\nDone since the last check: CO-1 \(Fix\)\.\n\nIf none of this needs you, ack at once/)
      expect(await store.wakes()).toHaveLength(1)
      await cli(['ack', wakeId(r.sent[0]!.text)])
      // Nothing new since: the next slot is skipped.
      expect(await deliver('idle', day(2, 8, 40)).run()).toEqual([])
      expect((await store.coordinator('CO'))!).toMatchObject({ ranAt: day(2, 8, 40), skipped: { n: 1 } })
      // Autopilot off: no health lines on their own, and they start over once back on.
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { ...(await store.coordinator('CO'))!.autopilot!, on: false }, health: { at: 0, seen: {} } })
      expect(await deliver('idle', day(2, 10)).run()).toEqual([])
      expect((await store.coordinator('CO'))!.health).toBeUndefined()
    })

    it('event wakes are unaffected', async () => {
      await asleep({ every: undefined, at: undefined })
      await store.addTask({ project: 'CO', title: 'New', type: 'feature' })
      const r = deliver('idle', day(2, 8, 1))
      expect(await r.run()).toEqual(['CO'])
      expect(r.sent[0]!.text).toContain('CO-2 (New): added')
    })
  })
})

describe('commands of lot 10', () => {
  it('a new token (the coordinator started again) keeps the autopilot the user set', async () => {
    const autopilot = { on: true, goal: 'ship lot 10', every: '2h', events: ['done' as const], perDay: 4, atOnce: 1, hours: { from: 22, to: 6 } }
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot, seen: { 'CO-1': 'working' }, ranAt: 5, userAt: 6, terminal: 'host/t1', turn: { kind: 'wake', at: 1 } })
    await issueToken(store, 'CO')
    const c = (await store.coordinator('CO'))!
    expect(c).toMatchObject({ autopilot, seen: { 'CO-1': 'working' }, ranAt: 5, userAt: 6 })
    expect([c.terminal, c.turn]).toEqual([undefined, undefined])
  })

  it('approve, merge, settings and the autopilot\'s limits are the user\'s', async () => {
    await refused(cli(['approve', 'CO-1']), 'Approving is the user\'s')
    await refused(cli(['merge', 'CO-1']), 'Merging is the user\'s gesture')
    await refused(cli(['settings']), 'Settings change only in wherdr')
    await refused(cli(['autopilot', 'set', '--perDay', '50']), 'change only in wherdr')
  })

  it('autopilot show gives the goal and what is left today', async () => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { on: true, goal: 'Ship', events: [], perDay: 4, atOnce: 2 } })
    await store.saveTask({ ...(await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })), state: 'working' })
    expect(await cli(['autopilot', 'show'])).toMatchObject({ autopilot: { goal: 'Ship' }, today: { started: 0, perDay: 4, working: 1, atOnce: 2, startLeft: 1 } })
 
    // A machine whose account is ahead of its pace takes nothing, as placement skips it.
    const now = Date.now()
    quotas.q = { codex: null, claude: { at: now, limited: { resetsAt: now + 3_600_000 }, five: { used: 100, resetsAt: now + 3_600_000, minutes: 300 }, week: { used: 20, resetsAt: now + 3 * 86_400_000, minutes: 10080 } }, accounts: [{ key: 'claude:ab12cd34', program: 'claude', machines: [''] }] }
    const here = { ...deps(), machines: () => [{ key: '', label: 'machine-a', local: true }] } as never
    expect((await runCommand(here, token, { argv: ['autopilot', 'show'] })).machines).toEqual([expect.stringMatching(/^machine-a \(home\): .* · takes nothing now: paced: /)])
  })

  it('task add: a task to do, chained with --after, with --weight; show gives its weight; in a wake only with the autopilot on', async () => {
    expect(parseCommand(['task', 'add', 'Fix', 'the', 'docs', '--type', 'feature', '--after', 'CO-1'])).toEqual({ name: 'task add', title: 'Fix the docs', type: 'feature', after: 'CO-1' })
    expect(parseCommand(['task', 'add', 'Fix'])).toMatchObject({ error: expect.stringMatching(/^usage: wherdr pm task add/) })
    expect(parseCommand(['task', 'add', 'Fix', '--type', 'feature', '--after', 'next'])).toEqual({ error: '--after is a list of tasks: A-1,A-2' })
    expect(parseCommand(['task', 'add', 'Fix', '--type', 'feature', '--weight', 'huge'])).toEqual({ error: '--weight is one of light, standard, heavy' })
    await noteTurn(store, 'CO', 'user', 'add two tasks')
    const first = (await cli(['task', 'add', 'Tidy the docs', '--type', 'feature', '--description', 'One typo.'])).task
    expect(first).toMatchObject({ id: 'CO-1', state: 'todo', description: 'One typo.', log: [{ by: 'coordinator CO', text: 'added the task' }] })
    expect((await cli(['show', 'CO-1'])).task).toMatchObject({ weight: 'standard (its steps)', machine: expect.stringMatching(/^not started/) })
    const heavy = (await cli(['task', 'add', 'Run e2e', '--type', 'feature', '--weight', 'heavy'])).task
    expect((await cli(['show', heavy.id])).task.weight).toBe('heavy (set on the task)')
    await refused(cli(['task', 'add', 'X', '--type', 'study']), 'No task type "study": feature')
    await refused(cli(['task', 'add', 'X', '--type', 'feature', '--after', 'ST-1']), 'after: tasks of the same project')
    await noteTurn(store, 'CO', 'wake')
    await refused(cli(['task', 'add', 'Next', '--type', 'feature']), 'a request from the user, sent from wherdr')
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
    expect((await cli(['task', 'add', 'Next', '--type', 'feature', '--after', 'CO-1'])).task).toMatchObject({ id: 'CO-3', after: 'CO-1' })
  })

  it('task remove: a task never started, with a reason in the project\'s log; in a wake only the autopilot\'s own', async () => {
    expect(parseCommand(['task', 'remove', 'CO-1'])).toMatchObject({ error: expect.stringMatching(/^usage: wherdr pm task remove/) })
    await noteTurn(store, 'CO', 'user', 'remove the duplicate')
    const [a, b, c] = [await store.addTask({ project: 'CO', title: 'Dup', type: 'feature' }), await store.addTask({ project: 'CO', title: 'Next', type: 'feature' }), await store.addTask({ project: 'CO', title: 'Then', type: 'feature', after: 'CO-2' })]
    await refused(cli(['task', 'remove', b.id, '--reason', 'Not needed.']), 'CO-3 waits for CO-2 (after): remove it first')
    await noteTurn(store, 'CO', 'wake')
    await refused(cli(['task', 'remove', a.id, '--reason', 'Duplicate of CO-2.']), 'only the tasks your autopilot added')
    await store.saveTask({ ...c, autopilot: true })
    expect(await cli(['task', 'remove', c.id, '--reason', 'Merged into CO-2.'])).toEqual({ removed: 'CO-3' })
    await noteTurn(store, 'CO', 'user', 'remove the duplicate')
    await store.saveTask({ ...a, state: 'working', step: state(1) })
    await refused(cli(['task', 'remove', a.id, '--reason', 'Duplicate.']), 'CO-1 has started')
    expect(await store.task(c.id)).toBeNull()
    expect(await store.projectLog('CO')).toEqual([{ at: expect.any(Number), by: 'coordinator CO', text: 'removed CO-3 "Then": Merged into CO-2.', task: 'CO-3' }])
    // Its number is never given again.
    expect((await store.addTask({ project: 'CO', title: 'New', type: 'feature' })).id).toBe('CO-4')
    await refused(cli(['task', 'remove', 'ST-1', '--reason', 'x']), 'Unknown task')
  })

  it('tell: an agent\'s question in a wake; never a permission', async () => {
    const sent: string[] = [], labels: unknown[] = []
    const call = async (method: string, p: { text: string, labels?: unknown }) => { if (method === 'terminal.send') sent.push(p.text); if (method === 'terminal.label') labels.push(p.labels); return {} }
    const tell = (argv: string[]) => runCommand({ store, call } as unknown as Parameters<typeof runCommand>[0], token, { argv })
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveRun({ id: 'r1', task: task.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: 'host/t3', attempt: 1, state: 'running', startedAt: 1 })
    await store.saveTask({ ...task, run: 'r1', state: 'waiting', waiting: 'Run the migration?', waitKind: 'permission' })
    await refused(tell(['tell', task.id, 'yes']), 'permission request is the user\'s')
    await store.saveTask({ ...(await store.task(task.id))!, waiting: 'Which DB?', waitKind: 'question' })
    await noteTurn(store, 'CO', 'wake')
    await tell(['tell', task.id, 'Postgres,', 'as in the README'])
    expect(sent).toEqual(['From the project coordinator: Postgres, as in the README'])
    const told = (await store.task(task.id))!
    expect([told.state, told.waitKind, told.log?.at(-1)?.text]).toEqual(['working', undefined, 'told the worker: Postgres, as in the README'])
    // Its question label goes at once: the engine's next pass does not bring it back.
    expect(labels).toEqual([{ 'wherdr.report': '' }])
    await refused(tell(['tell', task.id, 'and also…']), 'only answers an agent\'s question')
    // A mechanical fix: with the autopilot on, twice per step, logged with its reason.
    const fix = ['tell', task.id, 'Merge', 'the', 'base', '--fix', 'base', '--reason', 'The PR conflicts with v3.']
    await refused(tell(fix), 'only with the autopilot on')
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
    await tell(fix)
    await tell(fix)
    expect((await store.task(task.id))!.log?.at(-1)?.text).toBe('told the worker (fix base: The PR conflicts with v3.): Merge the base')
    await refused(tell(fix), 'Already fixed 2 times in this step')
    // A failed step action handed over with a fix: off Your turn, the worker asked for its done report.
    await store.saveWorkflow('CO', { ...structuredClone(company), taskTypes: { ...company.taskTypes, simple: github.taskTypes.simple! } })
    const pr = await store.addTask({ project: 'CO', title: 'Push', type: 'simple' })
    await store.saveRun({ id: 'r2', task: pr.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b2', instructions: '', terminal: 'host/t4', attempt: 1, state: 'running', startedAt: 1 })
    await store.saveTask({ ...pr, run: 'r2', state: 'working', step: state(2, { yourTurn: { reason: 'action', badge: 'pr: push refused', error: 'push refused' } }) })
    await tell(['tell', pr.id, 'Rebase', 'and', 'push', '--fix', 'machine', '--reason', 'Non-fast-forward push.'])
    expect(sent.at(-1)).toBe(`From the project coordinator: Rebase and push\n\nWhen done: ${DONE_CMD}`)
    const fixing = (await store.task(pr.id))!
    expect([fixing.step?.yourTurn, fixing.step?.agent?.kind, fixing.log?.at(-1)?.text]).toEqual([undefined, 'fix machine', 'pr: the agent is fixing it, then it is tried again'])
    // A permission prompt on its screen, even in the user's turn: never typed into.
    await noteTurn(store, 'CO', 'user', 'tell it')
    const blocked = async (method: string, p: { text: string }) => (method === 'terminal.get' ? { status: { state: 'blocked' } } : call(method, p))
    await refused(runCommand({ store, call: blocked } as unknown as Parameters<typeof runCommand>[0], token, { argv: ['tell', task.id, 'yes'] }), 'permission request is the user\'s')
  })

  it('answer: a choice or a free answer typed to the asking agent, or one typed in its conversation; off Your turn at once', async () => {
    const calls: [string, unknown][] = []
    let label = 'blocked:question'
    const call = async (method: string, p: unknown) => { calls.push([method, p]); return method === 'terminal.get' ? { labels: { 'wherdr.report': label } } : {} }
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveRun({ id: 'r1', task: task.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: 'host/t3', attempt: 1, state: 'running', startedAt: 1 })
    const asking = { ...task, run: 'r1', state: 'waiting' as const, waiting: 'The agent asks a question: Docker?', waitKind: 'question' as const, question: 'Docker?' }
    await store.saveTask(asking)
    expect(cardOf(asking, [], await store.runs()).asks).toMatchObject({ kind: 'question', full: 'Docker?' })
    const answered = await answerQuestion({ store, call } as unknown as Parameters<typeof answerQuestion>[0], task.id, 'Stop here')
    expect(calls).toEqual([['terminal.send', { terminal: 'host/t3', text: 'Stop here' }], ['terminal.label', { terminal: 'host/t3', labels: { 'wherdr.report': '' } }]])
    expect([answered.state, answered.question, toHandle([cardOf(answered, [], await store.runs())])]).toEqual(['working', undefined, []])
    await expect(answerQuestion({ store, call } as never, task.id, 'Again')).rejects.toThrow('no longer waits')
    // Typed in its conversation before the engine read the question: its label says so.
    calls.length = 0
    await answerQuestion({ store, call } as never, task.id, undefined, 'host/t3')
    expect(calls.map(c => c[0])).toEqual(['terminal.get', 'terminal.label'])
    label = ''
    calls.length = 0
    await answerQuestion({ store, call } as never, task.id, undefined, 'host/t3') // no question: nothing changes
    expect(calls.map(c => c[0])).toEqual(['terminal.get'])
  })

  it('spec changes: task edit, task note and tell --spec reach the running agent and the reviewer\'s next prompt; never in a wake', async () => {
    const sent: string[] = []
    const call = async (method: string, p: { text: string }) => { if (method === 'terminal.send') sent.push(p.text); return {} }
    const run = (argv: string[]) => runCommand({ store, call } as unknown as Parameters<typeof runCommand>[0], token, { argv })
    const task = await store.addTask({ project: 'CO', title: 'Add a dark theme', type: 'feature', description: 'A dark theme.\nA toggle in Settings.' })
    await store.saveRun({ id: 'r1', task: task.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: 'host/t3', attempt: 1, state: 'running', startedAt: 1 })
    await noteTurn(store, 'CO', 'wake')
    await refused(run(['task', 'edit', task.id, '--title', 'X', '--reason', 'Why.']), 'only for a turn that comes from the user')
    await refused(run(['tell', task.id, 'no toggle', '--spec']), 'only for a turn that comes from the user')
    await noteTurn(store, 'CO', 'user', 'follow the system instead')
    expect(await run(['task', 'edit', task.id, '--title', 'Follow the system theme', '--description', 'A dark theme.\nIt follows the system.', '--reason', 'The user changed their mind.'])).toMatchObject({ told: ['worker'] })
    expect(sent.at(-1)).toMatch(/^The task's spec changed: its title is now "Follow the system theme"/)
    expect((await store.task(task.id))!.log?.at(-1)?.text).toBe('edited the spec (The user changed their mind.):\ntitle: "Add a dark theme" → "Follow the system theme"\n- A toggle in Settings.\n+ It follows the system.')
    await run(['task', 'note', task.id, 'Keep the light theme as default.'])
    await run(['tell', task.id, 'No', 'toggle', 'at', 'all.', '--spec'])
    expect(sent.at(-1)).toBe('From the project coordinator: No toggle at all.')
    const prompt = reviewFile((await store.task(task.id))!, { worktree: '/w', branch: 'b' }, 'Review it.', '/v.json')
    expect(prompt).toContain('# Review of CO-1: Follow the system theme\n\nA dark theme.\nIt follows the system.\n\n## Spec changes\n\nThe latest note overrides the description where they disagree.\n\n')
    expect(prompt).toMatch(/Spec change \(\d{4}-\d\d-\d\d\): Keep the light theme as default\.\n- Spec change \(\d{4}-\d\d-\d\d\): No toggle at all\.\n/)
  })

  it('read: what the task\'s agent last said, its conversation else its screen, on its project only', async () => {
    expect(parseCommand(['read', 'CO-1', '--to', 'reviewer', '--lines', '5'])).toEqual({ name: 'read', task: 'CO-1', to: 'reviewer', lines: 5 })
    expect(parseCommand(['read', 'CO-1', '--lines', '0'])).toEqual({ error: '--lines is a number from 1 to 200' })
    expect(parseCommand(['read', 'CO-1', '--to', 'coordinator'])).toEqual({ error: '--to is one of worker, reviewer' })
    const reads: unknown[] = []
    const call = async (method: string, p: unknown) => { reads.push([method, p]); return { text: 'screen line 1\nscreen line 2\n\n' } }
    const panes = () => [{ id: 'w1:p1', coreAddress: 'm2/t4' }]
    const chat = async () => [{ role: 'assistant', text: 'Done.', ts: null }, { role: 'user', text: 'go', ts: null }, { role: 'assistant', text: 'Step 1\nStep 2\nWhich DB, Postgres or SQLite?', ts: 't9' }, { role: 'tool', text: 'x', ts: null }]
    const read = (argv: string[], tk = token) => runCommand({ store, call, panes, chat } as unknown as Parameters<typeof runCommand>[0], tk, { argv })
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await refused(read(['read', task.id]), 'The task has no worker yet')
    const run = { task: task.id, program: 'claude', model: 'opus', machine: 'm2', worktree: '/w', branch: 'b', instructions: '', attempt: 1, state: 'running' as const }
    await store.saveRun({ ...run, id: 'r1', role: 'worker', terminal: 'm2/t4', startedAt: 1 })
    await store.saveRun({ ...run, id: 'r2', role: 'reviewer', terminal: 'm2/t5', startedAt: 2 })
    await store.saveTask({ ...task, run: 'r1', state: 'waiting', waiting: 'The agent asks a question', waitKind: 'question' })
    // The current agent's conversation, on another machine: its last message, its last lines.
    expect(await read(['read', task.id, '--lines', '2'])).toEqual({ task: 'CO-1', agent: 'worker', running: true, waits: 'question', from: 'conversation', text: 'Step 2\nWhich DB, Postgres or SQLite?', at: 't9' })
    // The reviewer has no readable conversation: the bottom of its screen.
    expect(await read(['read', task.id, '--to', 'reviewer'])).toMatchObject({ agent: 'reviewer', from: 'screen', text: 'screen line 1\nscreen line 2' })
    expect(reads).toEqual([['terminal.read', { terminal: 'm2/t5', lines: 40 }]])
    // Another project's task: refused without the setting.
    await store.addTask({ project: 'ST', title: 'Other', type: 'study' })
    await refused(read(['read', 'ST-1']), 'project CO only')
  })
})
