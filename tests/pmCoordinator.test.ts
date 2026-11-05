import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { answerProposal, coordinatorsView, deliverWakes, issueToken, noteTurn, runCommand, setCoordinatorAgent, startCoordinator, userMessageTo } from '../server/utils/pmCoordinator'
import { parseCommand, roleFiles, coordinatorArgs } from '../shared/pm/coordinator'
import { EXAMPLES, common, company } from '../shared/pm/examples'
import { onEvent, planSteps, type StepState } from '../shared/pm/steps'
import type { Finding } from '../shared/pm/verdict'
import type { Template } from '../shared/pm/workflow'
import type { CoreAdminDeps } from '../server/utils/coreCreate'
// @ts-expect-error plain JavaScript module
import { pm } from '../bin/lib/pm.mjs'

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
    expect((await store.template('company'))!.version).toBe(1)
  })

  it('in a user turn: proposed with its diff; saved only once the user accepts, logged with their sentence', async () => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    await userMessageTo(store, 'host/t9', 'Tell agents to never run the full suite')
    const r = await cli(['template', 'edit'], moreInstructions) as { proposed: boolean, changes: string[], diff: string }
    const diff = '-   "instructions": "Base branch is develop.",\n+   "instructions": "Base branch is develop. Never run the full suite locally.",'
    expect(r).toMatchObject({ proposed: true, diff })
    expect(r.changes.length).toBeGreaterThan(0)
    expect((await store.template('company'))!.version).toBe(1)
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')!.proposal).toMatchObject({ diff, said: 'Tell agents to never run the full suite' })
    expect(await cli(['template', 'show'])).toMatchObject({ diff })
    // No core: the role files are not rewritten, the template is saved all the same.
    await expect(answerProposal(deps(), 'CO', true)).resolves.toEqual({ accepted: true })
    expect((await store.template('company'))!.version).toBe(2)
    expect((await store.templateLog('company')).at(-1)).toMatchObject({ by: 'coordinator CO', version: 2, said: 'Tell agents to never run the full suite' })
    expect((await store.coordinator('CO'))!.proposal).toBeUndefined()
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: 'accepted' })
  })

  it('is not saved over a change the user made after it', async () => {
    await noteTurn(store, 'CO', 'user', 'add a line')
    await cli(['template', 'edit'], moreInstructions)
    await store.saveTemplate({ ...structuredClone(company), instructions: 'USER EDIT' }, { replace: true })
    await refused(answerProposal(deps(), 'CO', true), 'The template changed since this proposal')
    expect((await store.template('company'))!.instructions).toBe('USER EDIT')
    expect((await store.coordinator('CO'))!.proposal).toBeUndefined()
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: expect.stringContaining('outdated') })
  })

  it('refused by the user: nothing saved, nothing logged', async () => {
    await noteTurn(store, 'CO', 'user', 'shorter instructions')
    await cli(['template', 'edit'], moreInstructions)
    const log = await store.templateLog('company')
    await answerProposal(deps(), 'CO', false)
    expect((await store.template('company'))!.version).toBe(1)
    expect(await store.templateLog('company')).toEqual(log)
    expect(await cli(['template', 'show'])).toMatchObject({ lastProposal: 'refused' })
    await refused(answerProposal(deps(), 'CO', true), 'No template change waits for you')
  })

  it('never changes a guard with the token, even in a user turn', async () => {
    await noteTurn(store, 'CO', 'user', 'let the engine merge develop')
    const loosen = edited((t) => { t.guards = { protected: ['main'], merge: { protected: 'user', others: 'engine' } } })
    await refused(cli(['template', 'edit'], loosen), 'Guards')
    const typeGuard = edited((t) => { t.taskTypes.feature!.guards = { merge: { others: 'engine' } } })
    await refused(cli(['template', 'edit'], typeGuard), 'Guards')
    await refused(cli(['template', 'edit'], edited((t) => { t.id = 'mine' })), 'its project\'s template only')
    expect((await store.template('company'))!.version).toBe(1)
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
    expect(runs[0]!.line).toContain(`export PATH='/h/.wherdr/pm/coordinators/CO/bin':"$PATH"; exec 'claude' '--model' 'opus' '--add-dir' '/src/co'`)
    const fresh = (runs[0]!.env as { WHERDR_PM_TOKEN: string }).WHERDR_PM_TOKEN
    await refused(cli(['list']), 'Unknown coordinator token')
    await expect(cli(['list'], undefined, fresh)).resolves.toBeTruthy()
    expect((await store.coordinator('CO'))!.terminal).toBe('host/t5')
  })

  it('start with the project\'s default agent, remember the agent that ran, and a new conversation replaces the old one', async () => {
    const { runs, deps } = fakeCore()
    await setCoordinatorAgent(store, 'CO', { program: 'claude', model: 'sonnet' })
    await startCoordinator(deps, 'CO', {}, urls)
    expect(runs[0]!.line).toContain(`exec 'claude' '--model' 'sonnet'`)
    await setCoordinatorAgent(store, 'CO', { program: 'codex', model: 'gpt-5' })
    // The default and the agent of the kept conversation stay apart, and survive a new token.
    expect((await coordinatorsView(store)).find(c => c.project === 'CO')).toMatchObject({ agent: { program: 'codex', model: 'gpt-5' }, ran: { program: 'claude', model: 'sonnet' }, terminal: 'host/t5' })
    await startCoordinator(deps, 'CO', {}, urls)
    expect(runs.map(r => [r.method, r.terminal ?? r.cwd])).toEqual([['terminal.run', '/h/.wherdr/pm/coordinators/CO'], ['terminal.run', '/h/.wherdr/pm/coordinators/CO'], ['terminal.kill', 'host/t5']])
    expect((await store.coordinator('CO'))).toMatchObject({ agent: { program: 'codex' }, ran: { program: 'codex', model: 'gpt-5' }, terminal: 'host/t6' })
    await refused(setCoordinatorAgent(store, 'CO', { program: 'omp', model: 'x' }), 'claude or codex')
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
    expect(Object.keys(files).sort()).toEqual(['.claude/settings.json', '.claude/skills/wherdr-pm/SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'bin/wherdr'])
    const agents = files['AGENTS.md']!
    expect(agents).toContain('You coordinate project CO only')
    expect(agents).toContain('`wherdr pm task link <task> <url> --label <label>`')
    expect(agents).toContain('- deploy (Deploy): holder coordinator, ends report, recheck 5m, timeout 90m')
    expect(agents).toContain('- Base branch is develop.')
    expect(agents).toContain('"id":"vibe"')
    expect(agents).toContain('with its absolute path (`/src/co/README.md`)')
    expect(files['CLAUDE.md']).toBe('@AGENTS.md\n')
    expect(JSON.parse(files['.claude/settings.json']!).permissions.deny).toEqual(['Edit(//src/co/**)'])
    const codex = coordinatorArgs('codex', 'gpt-5', '/h/c', '/src/co')
    expect(codex).not.toContain('--add-dir')
    expect(codex).not.toContain('-s') // a sandbox mode would bring back the profile-less sandbox, without network
    expect(codex).toEqual(expect.arrayContaining(['default_permissions="wherdr"', 'permissions.wherdr.extends=":workspace"', 'permissions.wherdr.network.enabled=true']))
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
    const sent: { terminal: string, text: string }[] = []
    const call = async (method: string, params: Record<string, string>) => {
      if (method === 'terminal.get') return { status }
      if (method === 'terminal.send') sent.push({ terminal: params.terminal!, text: params.text! })
      return {}
    }
    return { sent, run: () => deliverWakes({ store, call } as unknown as Parameters<typeof deliverWakes>[0], now) }
  }
  const atDeploy = async (since: number) => {
    await store.saveCoordinator({ ...(await store.coordinator('CO'))!, terminal: 'host/t9' })
    const task = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
    await store.saveTask({ ...task, state: 'working', step: state(5, { since, recheckAt: since + 300_000 }) })
    return task.id
  }

  it('tells the coordinator its step once, then each recheck, as an Autopilot wake turn', async () => {
    const id = await atDeploy(1000)
    const first = deliver('idle', 2000)
    expect(await first.run()).toEqual(['CO'])
    expect(first.sent).toEqual([{ terminal: 'host/t9', text: expect.stringMatching(/^Autopilot:\n\nCO-1 \(Fix\): Base branch is develop\.[\s\S]*Watch the develop pipeline/) }])
    expect((await store.coordinator('CO'))!.turn).toMatchObject({ kind: 'wake' })
    // A wake turn: the user's words cannot be claimed.
    await store.saveTask({ ...(await store.task(id))!, step: { ...(await store.task(id))!.step!, at: 4, yourTurn: { reason: 'user', badge: 'Merge the PR' } } })
    await refused(cli(['step', 'done', id, '--user-said', 'merged']), 'not a wake')
    await store.saveTask({ ...(await store.task(id))!, step: { ...(await store.task(id))!.step!, at: 5, yourTurn: undefined } })
    const again = deliver('idle', 3000)
    expect(await again.run()).toEqual([])
    const recheck = deliver('idle', 1000 + 300_000)
    await recheck.run()
    expect(recheck.sent[0]!.text).toContain('Check again: ')
  })

  it('waits while the coordinator works or the user just wrote', async () => {
    await atDeploy(1000)
    const busy = deliver('working', 2000)
    expect(await busy.run()).toEqual([])
    await noteTurn(store, 'CO', 'user', 'hi')
    const quiet = deliver('idle', Date.now() + 10_000)
    expect(await quiet.run()).toEqual([])
    expect(quiet.sent).toEqual([])
  })
})
