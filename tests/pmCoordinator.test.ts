import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Quotas } from '../shared/types'
import { createPmStore } from '../server/utils/pmStore'
import { alfredView, answerProposal, coordinatorsView, issueToken, noteTurn, runCommand, setCoordinatorAgent, startCoordinator, userMessageTo } from '../server/utils/pmCoordinator'
import { REMOTE_SCRIPT } from '../server/utils/pmVisibility'
import { MAIN, parseCommand, roleFiles, coordinatorArgs } from '../shared/pm/coordinator'
import { EXAMPLES, common, company } from '../shared/pm/examples'
import { onEvent, planSteps, type StepState } from '../shared/pm/steps'
import type { Finding } from '../shared/pm/verdict'
import type { Template } from '../shared/pm/workflow'
import type { CoreAdminDeps } from '../server/utils/coreCreate'
import { runNow, wakeTick } from '../server/utils/pmWakes'
import { WAKE } from '../shared/pm/wakes'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
// @ts-expect-error plain JavaScript module
import { pm } from '../bin/lib/pm.mjs'

// The quota readings the pace reads; none by default (quota unknown).
const quotas = vi.hoisted(() => ({ q: null as Quotas | null }))
vi.mock('../server/utils/quotas', async orig => ({ ...(await orig<object>()), readQuotas: async () => quotas.q ?? { claude: null, codex: null } }))
afterEach(() => { quotas.q = null })

let dir = '', store: ReturnType<typeof createPmStore>, token = ''
const deps = () => ({ store }) as unknown as CoreAdminDeps & { store: typeof store }
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
    await refused(cli(['show', other.id]), 'Unknown task')
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
    await refused(cli(['task', 'tag', st.id, 'Y']), 'Unknown task')
    expect(ids(await cli(['list']))).toEqual([co.id])
    expect(parseCommand(['show', 'CO-1', '--project', 'CO'])).toEqual({ error: expect.stringContaining('--project is for') })
  })

  it('is Alfred: starts in its home in the data dir, greets once, keeps its own files and the agent picked', async () => {
    const runs: Record<string, unknown>[] = [], killed: unknown[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === 'terminal.kill') return killed.push(params.terminal), {}
      runs.push(params)
      return { address: `host/t${runs.length}` }
    }
    const home = path.join(dir, 'alfred')
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
    expect(runs[2]!.line).toMatch(/exec 'codex' '-C'/)
    await expect(startCoordinator(d, MAIN, { program: 'cline' }, { local: 'http://127.0.0.1:7690' })).rejects.toThrow('program')
    const view = await coordinatorsView(store)
    expect(view.map(c => c.project)).toEqual([MAIN, 'CO', 'ST'])
    expect(view[0]).toMatchObject({ main: true, terminal: 'host/t3' })
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
    const d = { store, call: async () => ({ address: 'host/t1' }), machines: () => [], alfredHome: home } as never
    await startCoordinator(d, MAIN, { program: 'claude', model: 'opus' }, { local: 'http://127.0.0.1:7690' })
    expect(await alfredView(d)).toMatchObject({ name: 'Alfred', program: 'claude', terminal: 'host/t1' })
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toContain('Project management is off')
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
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.proposal).toMatchObject({ diff, said: 'Tell agents to never run the full suite' })
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

  it('never passes a critical with proof', async () => {
    const id = await atReview([[f('a')], [f('a')], [f('c', { severity: 'critical' })]])
    for (const choice of ['pass', 'worker', 'split']) await refused(decide(id, choice), 'This one is for the user')
  })

  it('needs one sentence of reason', () => {
    expect(parseCommand(['task', 'decide', 'CO-1', 'round'])).toMatchObject({ error: expect.stringContaining('one sentence') })
    expect(parseCommand(['task', 'start', 'CO-1'])).toEqual({ name: 'task start', task: 'CO-1' })
    expect(parseCommand(['task', 'start', 'CO-1', 'x'])).toEqual({ error: 'usage: wherdr pm task start <task>' })
    expect(parseCommand(['task', 'decide', 'CO-1', 'round', '--reason', 'a\nb'])).toMatchObject({ error: expect.stringContaining('one sentence') })
    expect(parseCommand(['task', 'decide', 'CO-1', 'maybe', '--reason', 'x'])).toMatchObject({ error: expect.stringContaining('choice') })
  })
})

describe('role files', () => {
  // A fake herdr-core: the machine's home is /h; files written; terminals started.
  const fakeCore = (local = true) => {
    const written: string[] = [], runs: Record<string, unknown>[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      const argv = params.argv as string[] | undefined
      if (method === 'machine.exec' && argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from('/h').toString('base64') }
      // The repository's remote and gh's answer: a public GitHub repository.
      if (method === 'machine.exec' && argv?.[2] === REMOTE_SCRIPT) return { code: 0, stdout: Buffer.from('git@github.com:o/co.git\n{"visibility":"PUBLIC"}').toString('base64') }
      if (method === 'machine.exec') return written.push(argv![4]!), { code: 0, stdout: '' }
      runs.push({ method, ...params })
      return { address: `host/t${runs.length + 4}` }
    }
    const machines = () => [{ key: '', label: 'here', local, status: 'online' }]
    return { written, runs, deps: { store, call, machines } as unknown as Parameters<typeof startCoordinator>[0] }
  }
  const urls = { local: 'http://127.0.0.1:7690', remote: 'https://host.tailnet.example' }

  it('are written in the coordinator\'s own folder when it starts, with a new token and its wherdr script in its environment', async () => {
    const { written, runs, deps } = fakeCore()
    const r = await startCoordinator(deps, 'CO', { program: 'claude', model: 'opus' }, urls)
    expect(r).toEqual({ terminal: 'host/t5', folder: '/h/.wherdr/pm/coordinators/CO' })
    expect(written.every(f => f.startsWith('/h/.wherdr/pm/coordinators/CO/'))).toBe(true)
    expect(written).toContain('/h/.wherdr/pm/coordinators/CO/bin/wherdr')
    expect(runs[0]).toMatchObject({ cwd: '/h/.wherdr/pm/coordinators/CO', labels: { 'wherdr.coordinator': 'CO' }, env: { DISABLE_AUTOUPDATER: '1', WHERDR_URL: urls.local } })
    expect(runs[0]!.line).toContain(`export PATH='/h/.wherdr/pm/coordinators/CO/bin':"$PATH"; exec 'claude' '--add-dir' '/src/co'`)
    const fresh = (runs[0]!.env as { WHERDR_PM_TOKEN: string }).WHERDR_PM_TOKEN
    await refused(cli(['list']), 'Unknown coordinator token')
    await expect(cli(['list'], undefined, fresh)).resolves.toBeTruthy()
    expect((await store.coordinator('CO'))!.terminal).toBe('host/t5')
    // Its repository's visibility, checked once at its first start.
    expect((await store.projects()).find(p => p.key === 'CO')!.visibility).toMatchObject({ value: 'public', by: 'check' })
  })

  it('start with the project\'s default agent, remember the agent that ran, and a new conversation replaces the old one', async () => {
    const { runs, deps } = fakeCore()
    // No default set yet: none in the view (the client offers the user's first agent).
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.agent).toBeUndefined()
    await setCoordinatorAgent(store, 'CO', { program: 'claude', model: 'sonnet' })
    await startCoordinator(deps, 'CO', {}, urls)
    expect(runs[0]!.line).toMatch(/exec 'claude' '--add-dir' '\/src\/co'$/)
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

  it('on another machine, the coordinator gets wherdr\'s published address, never loopback', async () => {
    const remote = fakeCore(false)
    await startCoordinator(remote.deps, 'CO', { program: 'codex', model: 'gpt-5' }, urls)
    expect(remote.runs[0]).toMatchObject({ on: 'here', env: { WHERDR_URL: urls.remote } })
    await refused(startCoordinator(fakeCore(false).deps, 'CO', { program: 'codex', model: 'gpt-5' }, { local: urls.local }), 'publish it on your tailnet')
  })

  it('say who it is, its commands, each plan and the user\'s instructions, all inside its own folder', () => {
    const files = roleFiles({ key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1 }, company, EXAMPLES)
    expect(Object.keys(files).sort()).toEqual(['.claude/settings.json', '.claude/skills/wherdr-pm/SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'bin/wherdr'])
    const agents = files['AGENTS.md']!
    expect(agents).toContain('You coordinate project CO only')
    expect(agents).toContain('`wherdr pm task link <task> <url> --label <label>`')
    expect(agents).toContain('- deploy (Deploy): holder coordinator, ends report, recheck 5m, timeout 90m')
    expect(agents).toContain('- Base branch is develop.')
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
    return { ok: true, status: 200, json: async () => ({ version: 2 }) }
  }
  let printed = ''
  const out = { write: (s: string) => { printed += s } }
  async function* stdin() { yield '{"id":"company"}' }
  await pm(['template', 'edit'], { env: { WHERDR_PM_TOKEN: 'abc', WHERDR_URL: 'http://127.0.0.1:7690' }, stdin: stdin(), out, request })
  expect(calls[0]!.url).toBe('http://127.0.0.1:7690/api/pm/cli')
  expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer abc', origin: 'http://127.0.0.1:7690' })
  expect(JSON.parse(calls[0]!.init.body)).toEqual({ argv: ['template', 'edit'], input: '{"id":"company"}' })
  expect(printed).toContain('"version": 2')
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
        res.end(JSON.stringify(await runCommand(deps(), String(req.headers.authorization).slice(7), JSON.parse(raw))))
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
  try {
    const tag = await run(['pm', 'task', 'tag', task.id, 'say "hi" \\ ünï'])
    expect(tag.code).toBe(0)
    expect((await store.task(task.id))!.tags).toEqual(['say "hi" \\ ünï'])
    const edit = await run(['pm', 'template', 'edit'], JSON.stringify(company))
    expect(edit.code).not.toBe(0)
    expect(edit.out).toContain('only for a turn that comes from the user')
    expect((await run(['list'])).code).toBe(2)
  }
  finally { server.close() }
})

describe('wakes', () => {
  const deliver = (status: string, now: number) => {
    const sent: { terminal: string, text: string }[] = [], pushed: string[] = []
    const call = async (method: string, params: Record<string, string>) => {
      if (method === 'terminal.get') return { status }
      if (method === 'terminal.send') sent.push({ terminal: params.terminal!, text: params.text! })
      return {}
    }
    const notify = async (title: string) => { pushed.push(title) }
    const d = { store, call, notify } as unknown as Parameters<typeof wakeTick>[0]
    return { sent, pushed, d, run: () => wakeTick(d, now) }
  }
  const atDeploy = async (since: number) => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveTask({ ...task, state: 'working', step: state(5, { since, recheckAt: since + 300_000 }) })
    return task.id
  }
  const wakeId = (text: string) => /wherdr pm ack ([0-9a-f]{8})/.exec(text)![1]!

  it('tells the coordinator its step once, then each recheck, as an Autopilot wake turn', async () => {
    const id = await atDeploy(1000)
    const first = deliver('idle', 2000)
    expect(await first.run()).toEqual(['CO'])
    expect(first.sent).toEqual([{ terminal: 'host/t9', text: expect.stringMatching(/^Autopilot: wake [0-9a-f]{8}\n\nCO-1 \(Fix\): Base branch is develop\.[\s\S]*Watch the develop pipeline/) }])
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

  it('wakes at its fixed times, once for slots missed while down', async () => {
    const day = (d: number, h: number) => new Date(2026, 10, d, h).getTime()
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9', atRan: day(1, 9), autopilot: { on: true, goal: 'Triage', at: 'daily 08:00', events: [], perDay: 3, atOnce: 1 } })
    expect(await deliver('idle', day(2, 7)).run()).toEqual([])
    const late = deliver('idle', day(5, 10))
    expect(await late.run()).toEqual(['CO'])
    expect(late.sent[0]!.text).toContain('Scheduled wake (daily 08:00). Your goal: Triage.')
    expect((await store.coordinator('CO'))!.atRan).toBe(day(5, 10))
    expect((await store.wakes()).filter(w => w.reasons.some(r => r.startsWith('Scheduled')))).toHaveLength(1)
  })

  describe('nothing to do', () => {
    // Day 2 is today: the skipped wakes are counted per local day.
    const day = (d: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d - 2); x.setHours(h, m, 0, 0); return x.getTime() }
    const scheduled = async () => (await store.wakes()).filter(w => w.reasons.some(r => r.startsWith('Scheduled'))).length
    // A project whose tasks are all done, woken once since: asleep.
    const asleep = async (more: Partial<typeof DEFAULT_AUTOPILOT> = {}) => {
      const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
      await store.saveTask({ ...task, step: state(5, { done: true }) })
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9', atRan: day(1, 9), ranAt: day(2, 6), seen: { 'CO-1': 'done' }, woke: { at: day(2, 6), seen: { 'CO-1': 'done' } },
        autopilot: { on: true, goal: 'Triage', every: '30m', at: 'daily 08:00', events: ['added', 'done', 'stuck'], perDay: 3, atOnce: 1, ...more } })
      return task
    }

    it('skips the interval and fixed-time wakes, marks the slots run and counts them', async () => {
      await asleep()
      expect(await deliver('idle', day(2, 8, 1)).run()).toEqual([])
      expect(await scheduled()).toBe(0)
      const c = (await store.coordinator('CO'))!
      expect(c).toMatchObject({ ranAt: day(2, 8, 1), atRan: day(2, 8, 1), skipped: { n: 1 } })
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
      // The 5-hour window at 90 %: past the 25 % reserve.
      quotas.q = { codex: null, claude: { at: now, five: { used: 90, resetsAt: now + 3_600_000, minutes: 300 }, week: { used: 20, resetsAt: now + 3 * 86_400_000, minutes: 10080 } }, accounts: [{ key: 'claude:ab12cd34', program: 'claude', machines: [''] }] }
      expect(await deliver('idle', now).run()).toEqual([])
      expect(await scheduled()).toBe(0)
      expect((await store.coordinator('CO'))!).toMatchObject({ ranAt: now, atRan: now, skipped: { n: 1 } })
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
      await store.saveCoordinator({ ...(await store.coordinator('CO'))!, seen: { ...seen }, woke: { at: day(2, 8, 2), seen: { ...seen } } })
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
  })

  it('task add: a task to do, chained with --after; in a wake only with the autopilot on', async () => {
    expect(parseCommand(['task', 'add', 'Fix', 'the', 'docs', '--type', 'feature', '--after', 'CO-1'])).toEqual({ name: 'task add', title: 'Fix the docs', type: 'feature', after: 'CO-1' })
    expect(parseCommand(['task', 'add', 'Fix'])).toMatchObject({ error: expect.stringMatching(/^usage: wherdr pm task add/) })
    expect(parseCommand(['task', 'add', 'Fix', '--type', 'feature', '--after', 'next'])).toEqual({ error: '--after is a list of tasks: A-1,A-2' })
    await noteTurn(store, 'CO', 'user', 'add two tasks')
    const first = (await cli(['task', 'add', 'Tidy the docs', '--type', 'feature', '--description', 'One typo.'])).task
    expect(first).toMatchObject({ id: 'CO-1', state: 'todo', description: 'One typo.', log: [{ by: 'coordinator CO', text: 'added the task' }] })
    await refused(cli(['task', 'add', 'X', '--type', 'study']), 'No task type "study": feature')
    await refused(cli(['task', 'add', 'X', '--type', 'feature', '--after', 'ST-1']), 'after: tasks of the same project')
    await noteTurn(store, 'CO', 'wake')
    await refused(cli(['task', 'add', 'Next', '--type', 'feature']), 'only with the autopilot on')
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
    expect((await cli(['task', 'add', 'Next', '--type', 'feature', '--after', 'CO-1'])).task).toMatchObject({ id: 'CO-2', after: 'CO-1' })
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
    const sent: string[] = []
    const call = async (method: string, p: { text: string }) => { if (method === 'terminal.send') sent.push(p.text); return {} }
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
    expect([told.state, told.waitKind, told.log?.at(-1)?.text]).toEqual(['working', undefined, 'told the agent: Postgres, as in the README'])
    await refused(tell(['tell', task.id, 'and also…']), 'only answers an agent\'s question')
    // A permission prompt on its screen, even in the user's turn: never typed into.
    await noteTurn(store, 'CO', 'user', 'tell it')
    const blocked = async (method: string, p: { text: string }) => (method === 'terminal.get' ? { status: { state: 'blocked' } } : call(method, p))
    await refused(runCommand({ store, call: blocked } as unknown as Parameters<typeof runCommand>[0], token, { argv: ['tell', task.id, 'yes'] }), 'permission request is the user\'s')
  })
})
