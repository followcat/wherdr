import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { splitFeature } from '../server/utils/pmFeature'
import { PLAN_RETRY_MS, PLAN_WRITE_SCRIPT, planDate, planWriteResult, readPlanFile, tickPlanFile } from '../server/utils/pmPlan'
import { issueToken, noteTurn, runCommand } from '../server/utils/pmCoordinator'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
import { parsePlan, parseFeature } from '../shared/pm/feature'
import { openLines, parsePlanPath, parseRefs, planCloseRefusal, planCommitMessage, tickPlan } from '../shared/pm/planRefs'
import { instructionsText } from '../shared/pm/run'
import { parseCommand, WHERDR_SCRIPT } from '../shared/pm/coordinator'
import { defaultWorkflow } from '../shared/pm/workflow'
import type { CoreAdminDeps } from '../server/utils/coreCreate'
import type { Project } from '../shared/pm/project'
import type { Task } from '../shared/pm/run'

const PLAN = [
  '# Tasks',
  '',
  '- [ ] T010 [P] [US1] Add the endpoint',
  '- [ ] T011 [US1] Add the button (see FR-2)',
  '  - [ ] T012 Nested line, two spaces',
  '* [ ] T1 Short ID',
  '- [ ] T10 Longer ID, same start',
  '- [x] T013 Already done by hand',
  '- [ ] T014 Not a line of this task',
  '',
].join('\n')
const done = { task: 'PA-1', date: '2026-11-17', sha: '1a2b3c4' }

describe('tickPlan: ticks a plan file\'s lines by their IDs', () => {
  it('ticks the right line only and keeps its notes', () => {
    const r = tickPlan(PLAN, ['T011'], done)
    expect(r.ticked).toEqual(['T011'])
    expect(r.skipped).toEqual([])
    const lines = r.text.split('\n')
    expect(lines[3]).toBe('- [x] T011 [US1] Add the button (see FR-2) (done: PA-1, 1a2b3c4, 2026-11-17)')
    // Every other line as it was.
    expect(lines.filter((_, i) => i !== 3)).toEqual(PLAN.split('\n').filter((_, i) => i !== 3))
  })

  it('takes an ID only whole: T1 is neither T10 nor T1-2, nor T1-foo', () => {
    const a = tickPlan(PLAN, ['T1'], done)
    expect(a.text).toContain('* [x] T1 Short ID (done: PA-1, 1a2b3c4, 2026-11-17)')
    expect(a.text).toContain('- [ ] T10 Longer ID, same start')
    expect(tickPlan(PLAN, ['T10'], { task: 'PA-2', date: '2026-11-17' }).text).toContain('- [x] T10 Longer ID, same start (done: PA-2, 2026-11-17)\n')
    const text = '- [ ] T1-2 Dashed\n- [ ] T1 Plain\n'
    expect(tickPlan(text, ['T1'], done).text).toBe('- [ ] T1-2 Dashed\n- [x] T1 Plain (done: PA-1, 1a2b3c4, 2026-11-17)\n')
    expect(tickPlan('- [ ] T1-foo x\n', ['T1'], done).skipped).toEqual([{ ref: 'T1', why: 'not found' }])
    expect(openLines(text).map(l => l.id)).toEqual(['T1-2', 'T1'])
  })

  it('keeps indentation, bullets and Windows line endings', () => {
    const r = tickPlan('- [ ] T1 One\r\n  - [ ] T2 Two\r\n', ['T2'], done)
    expect(r.text).toBe('- [ ] T1 One\r\n  - [x] T2 Two (done: PA-1, 1a2b3c4, 2026-11-17)\r\n')
  })

  it('says what it did not tick (already ticked, or not found), so a second pass changes nothing', () => {
    const first = tickPlan(PLAN, ['T010', 'T011', 'T099'], done)
    expect(first.ticked).toEqual(['T010', 'T011'])
    const second = tickPlan(first.text, ['T010', 'T099'], { ...done, date: '2026-12-01' })
    expect(second.text).toBe(first.text)
    expect(second.skipped).toEqual([{ ref: 'T010', why: 'already ticked' }, { ref: 'T099', why: 'not found' }])
  })

  it('ticks the first open line when an ID is written twice', () => {
    const r = tickPlan('- [ ] T5 one\n- [ ] T5 two\n', ['T5'], done)
    expect(r.text).toBe('- [x] T5 one (done: PA-1, 1a2b3c4, 2026-11-17)\n- [ ] T5 two\n')
  })

  it('ignores lines in fenced code blocks, to tick and to list: an example is not the plan', () => {
    const text = ['```md', '- [ ] T5 an example', '```', '- [ ] T5 the line', '~~~', '- [ ] T6 in tildes', '```', '- [ ] T6 still inside', '~~~', '- [ ] T7 after', ''].join('\n')
    const r = tickPlan(text, ['T5', 'T6', 'T7'], done)
    expect(r.ticked).toEqual(['T5', 'T7'])
    expect(r.skipped).toEqual([{ ref: 'T6', why: 'not found' }])
    expect(r.text.split('\n')).toEqual(['```md', '- [ ] T5 an example', '```', '- [x] T5 the line (done: PA-1, 1a2b3c4, 2026-11-17)', '~~~', '- [ ] T6 in tildes', '```', '- [ ] T6 still inside', '~~~', '- [x] T7 after (done: PA-1, 1a2b3c4, 2026-11-17)', ''])
    expect(openLines(text).map(l => l.id)).toEqual(['T5', 'T7'])
    // A ticked line only in a fence is not "already ticked" either.
    expect(tickPlan('```\n- [x] T9 x\n```\n', ['T9'], done).skipped).toEqual([{ ref: 'T9', why: 'not found' }])
    // An unclosed fence runs to the end.
    expect(openLines('- [ ] T1 a\n```\n- [ ] T2 b\n').map(l => l.id)).toEqual(['T1'])
  })

  it('knows - * and + bullets, not numbered lists', () => {
    const text = '+ [ ] T1 plus\n1. [ ] T2 numbered\n2) [ ] T3 numbered\n'
    expect(tickPlan(text, ['T1', 'T2', 'T3'], done)).toMatchObject({ ticked: ['T1'], skipped: [{ ref: 'T2', why: 'not found' }, { ref: 'T3', why: 'not found' }] })
    expect(tickPlan(text, ['T1'], done).text).toMatch(/^\+ \[x\] T1 plus \(done/)
    expect(openLines(text).map(l => l.id)).toEqual(['T1'])
  })

  it('dates a tick in UTC', () => {
    expect(planDate(Date.parse('2026-11-17T23:30:00-05:00'))).toBe('2026-11-18')
    expect(planDate(Date.parse('2026-11-17T00:30:00+09:00'))).toBe('2026-11-16')
  })
})

describe('refs, plan paths, open lines and the commit message', () => {
  it('checks IDs: letters, digits and dashes, ending in a number', () => {
    expect(parseRefs(['T010', ' T011 ', 'T010'])).toEqual(['T010', 'T011'])
    expect(parseRefs('US3,FR-12')).toEqual(['US3', 'FR-12'])
    expect(parseRefs(undefined)).toEqual([])
    for (const bad of ['010', 'T', 'T 1', 'T1;rm', '../x1', 'T1\nT2']) expect(parseRefs([bad])).toMatchObject({ error: expect.stringMatching(/not a plan line ID/) })
    expect(parseRefs([1])).toMatchObject({ error: expect.stringMatching(/plan line IDs/) })
    expect(parseRefs(Array.from({ length: 51 }, (_, i) => `T${i}`))).toMatchObject({ error: expect.stringMatching(/50 at most/) })
  })

  it('keeps a plan file\'s path under the root: relative, never leaving it', () => {
    expect(parsePlanPath('specs/018-x/tasks.md')).toBe('specs/018-x/tasks.md')
    expect(parsePlanPath('./tasks.md')).toBe('tasks.md')
    for (const bad of ['', '/etc/passwd', '~/tasks.md', '../tasks.md', 'a/../../b.md', 'a//b.md', '.git/config', 'a/.git/x', 'a/\u0000b']) expect(parsePlanPath(bad)).toMatchObject({ error: expect.stringMatching(/plan file under the workspace/) })
  })

  it('lists the lines still open, an ID and its first 80 characters, and refuses a close with them', () => {
    const open = openLines(PLAN)
    expect(open.map(l => l.id)).toEqual(['T010', 'T011', 'T012', 'T1', 'T10', 'T014'])
    expect(open[0]).toEqual({ id: 'T010', text: 'T010 [P] [US1] Add the endpoint' })
    expect(openLines(`- [ ] T7 ${'x'.repeat(200)}`)[0]!.text).toHaveLength(80)
    expect(planCloseRefusal('specs/x/tasks.md', openLines('- [x] T1 done\n'))).toBeUndefined()
    const why = planCloseRefusal('specs/x/tasks.md', open)!
    expect(why).toMatch(/^6 lines of specs\/x\/tasks.md still unticked: T010 \[P\] \[US1\] Add the endpoint; T011/)
    expect(why).toMatch(/Ask the user, then close with --anyway$/)
    expect(planCloseRefusal('t.md', Array.from({ length: 15 }, (_, i) => ({ id: `T${i}`, text: `T${i} x` })))).toMatch(/15 lines.*; and 3 more\./)
  })

  it('writes a commit message from the workspace\'s template, else a plain one', () => {
    const task = { id: 'PA-1', title: 'Serve payslips', type: 'task', tags: ['PAY-12'] }
    expect(planCommitMessage(undefined, 'WS-1', task, ['T010', 'T011'])).toBe('WS-1: tick T010, T011 (PA-1)')
    expect(planCommitMessage('{tag}: {title}', 'WS-1', task, ['T010'])).toBe('PAY-12: tick T010 (Serve payslips)')
    expect(planCommitMessage('[{id}] {title}', 'WS-1', { ...task, tags: [] }, ['T1'])).toBe('[PA-1] tick T1 (Serve payslips)')
    // A template the engine refuses (an unknown field): the plain message.
    expect(planCommitMessage('{nope}', 'WS-1', task, ['T1'])).toBe('WS-1: tick T1 (PA-1)')
  })
})

describe('feature split and close: the plan, the refs, --from, --anyway', () => {
  it('parses the commands', () => {
    expect(parseCommand(['feature', 'split', 'WS-1', '--from', 'specs/018/plan.json'])).toEqual({ name: 'feature split', task: 'WS-1', from: 'specs/018/plan.json' })
    expect(parseCommand(['feature', 'split', 'WS-1'])).toEqual({ name: 'feature split', task: 'WS-1' })
    expect(parseCommand(['feature', 'split', 'WS-1', '--from', ' '])).toMatchObject({ error: expect.stringMatching(/--from/) })
    expect(parseCommand(['feature', 'split', 'WS-1', '--frm', 'x'])).toEqual({ error: 'unknown option --frm' })
    expect(parseCommand(['feature', 'close', 'WS-1', '--anyway', '--reason', 'Shipped'])).toEqual({ name: 'feature close', task: 'WS-1', reason: 'Shipped', anyway: true })
    expect(parseCommand(['feature', 'close', 'WS-1'])).toEqual({ name: 'feature close', task: 'WS-1' })
    expect(parseFeature(['close', 'WS-1'], { anyway: 'yes' })).toMatchObject({ anyway: true })
    expect(parseCommand(['task', 'add', 'Show it', '--type', 'task', '--feature', 'WS-1', '--refs', 'T1, T2'])).toMatchObject({ name: 'task add', feature: 'WS-1', refs: ['T1', 'T2'] })
    expect(parseCommand(['task', 'add', 'Show it', '--type', 'task', '--refs', 'T1'])).toMatchObject({ error: expect.stringMatching(/--refs needs --feature/) })
    expect(parseCommand(['task', 'add', 'Show it', '--type', 'task', '--feature', 'WS-1', '--refs', 'x'])).toMatchObject({ error: expect.stringMatching(/--refs: x is not a plan line ID/) })
  })

  it('checks the plan: its file and each task\'s refs', () => {
    const p = parsePlan({ order: 'API first', plan: './specs/018-x/tasks.md', tasks: [{ repo: 'api', title: 'A', type: 'task', refs: ['T010', 'T011'] }, { repo: 'app', title: 'B', type: 'task' }] })
    expect(p).toMatchObject({ file: 'specs/018-x/tasks.md', tasks: [{ repo: 'api', refs: ['T010', 'T011'] }, { repo: 'app', refs: [] }] })
    expect(parsePlan({ order: 'x', tasks: [{ repo: 'api', title: 'A', type: 'task' }] })).not.toHaveProperty('file')
    expect(parsePlan({ order: 'x', plan: '../tasks.md', tasks: [{ repo: 'api', title: 'A', type: 'task' }] })).toMatchObject({ error: expect.stringMatching(/plan file under the workspace/) })
    expect(parsePlan({ order: 'x', plan: 'tasks.md', tasks: [{ repo: 'api', title: 'A', type: 'task', refs: ['T 1'] }] })).toMatchObject({ error: expect.stringMatching(/^plan.tasks\[0\].refs: T 1 is not a plan line ID/) })
    // Refs name lines of a plan file: without one, nothing to tick.
    expect(parsePlan({ order: 'x', tasks: [{ repo: 'api', title: 'A', type: 'task', refs: ['T1'] }] })).toMatchObject({ error: expect.stringMatching(/add "plan"/) })
  })

  it('tells the worker its plan lines', () => {
    const p = { key: 'PA', name: 'Payroll', machine: '', path: '/w/payroll-api', addedAt: 1 } as Project
    const task = { id: 'PA-1', project: 'PA', title: 'Serve', description: 'Do it', type: 'task', state: 'todo', createdAt: 1, refs: ['T010', 'T011'] } as Task
    const run = { worktree: '/wt', branch: 'task/PA-1' }
    const t = defaultWorkflow('PA')
    expect(instructionsText(p, t, task, run, undefined, undefined, [], 'specs/018-x/tasks.md')).toContain('Plan lines: T010, T011 in specs/018-x/tasks.md')
    expect(instructionsText(p, t, task, run)).not.toContain('Plan lines')
    expect(instructionsText(p, t, { ...task, refs: undefined }, run, undefined, undefined, [], 'specs/018-x/tasks.md')).not.toContain('Plan lines')
  })

  it('the coordinator\'s own folder script sends stdin for feature split, unless --from', () => {
    expect(WHERDR_SCRIPT).toContain('"pm/cli feature split"*')
    expect(WHERDR_SCRIPT).toContain('*" --remove "*|*" --from "*) ;;')
  })
})

// A machine that is this one: `machine.exec` runs the argv here. hooks: what a test changes around a call.
// GIT_CEILING_DIRECTORIES: a test root without git is never seen inside a checkout that holds the temp folder.
const gitEnv = { GIT_CEILING_DIRECTORIES: realpathSync(os.tmpdir()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } }).trim()
const hooks = { path: undefined as string | undefined, beforeWrite: undefined as (() => void) | undefined, writes: 0 }
const call = async (_m: string, p: { argv: string[], input?: string }) => {
  if (p.argv[2] === PLAN_WRITE_SCRIPT) { hooks.writes++; hooks.beforeWrite?.() }
  const r = spawnSync(p.argv[0]!, p.argv.slice(1), { input: p.input ? Buffer.from(p.input, 'base64') : undefined, env: { ...process.env, ...gitEnv, ...(hooks.path ? { PATH: hooks.path } : {}) } })
  return { code: r.status, stdout: r.stdout.toString('base64'), stderr: r.stderr.toString('base64') }
}
afterEach(() => { hooks.path = undefined; hooks.beforeWrite = undefined; hooks.writes = 0 })

describe('the plan file on the workspace\'s machine', () => {
  let dir = '', root = '', outside = ''
  const ws = () => ({ path: root, machine: '' }) as Project
  const deps = { call, machines: () => [{ key: '', label: 'here', local: true }] } as never
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pm-plan-')))
    root = path.join(dir, 'root')
    outside = path.join(dir, 'outside')
    await fs.mkdir(path.join(root, 'specs'), { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(root, 'specs/tasks.md'), PLAN)
    await fs.writeFile(path.join(outside, 'secret.md'), '- [ ] T1 secret\n')
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('reads a file under the root, as it is, trailing newline included', async () => {
    expect(await readPlanFile(deps, ws(), 'specs/tasks.md')).toEqual({ text: PLAN })
    expect(await readPlanFile(deps, ws(), path.join(root, 'specs/tasks.md'))).toEqual({ text: PLAN })
    expect(await readPlanFile(deps, ws(), 'specs/missing.md')).toEqual({ why: 'specs/missing.md was not found' })
    expect(await readPlanFile(deps, ws(), 'specs')).toEqual({ why: 'specs was not found' })
    expect(await readPlanFile(deps, ws(), 'specs/tasks.md', 10)).toEqual({ why: 'specs/tasks.md is too large' })
  })

  it('refuses a file outside the root: a path out of it, an absolute one, a link to it, a link in a folder', async () => {
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'specs/link.md'))
    await fs.symlink(outside, path.join(root, 'linked'))
    await fs.symlink('tasks.md', path.join(root, 'specs/inside.md'))
    const out = (f: string) => expect(readPlanFile(deps, ws(), f)).resolves.toEqual({ why: `${f} is outside the workspace's root` })
    await out('../outside/secret.md')
    await out(path.join(outside, 'secret.md'))
    await out('specs/link.md')
    await out('linked/secret.md')
    // Nothing inside a .git folder, a link to it included.
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git/config'), '[core]\n')
    await fs.symlink('../.git/config', path.join(root, 'specs/gitlink.md'))
    await out('specs/gitlink.md')
    await out('.git/config')
    // A link that stays inside is the file it leads to.
    expect(await readPlanFile(deps, ws(), 'specs/inside.md')).toEqual({ text: PLAN })
  })

  it('splits from a file of the root, with the plan file and the refs kept; refuses a path outside', async () => {
    const store = createPmStore(path.join(dir, 'pm'))
    await store.setEnabled(true)
    await fs.mkdir(path.join(root, 'payroll-api'))
    await fs.mkdir(path.join(root, 'quotes-app'))
    const projects = [
      { key: 'WS', name: 'Work', machine: '', path: root, kind: 'workspace', git: false, addedAt: 1 },
      { key: 'PA', name: 'Payroll', machine: '', path: path.join(root, 'payroll-api'), workspace: 'WS', addedAt: 1 },
      { key: 'QA', name: 'Quotes', machine: '', path: path.join(root, 'quotes-app'), workspace: 'WS', addedAt: 1 },
    ]
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects }))
    const feature = await store.addTask({ project: 'WS', title: 'Export payslips', type: 'feature' })
    const start = vi.fn(async () => {}), who = { by: 'coordinator WS', origin: 'user' as const }
    const d = { store, call, machines: () => [{ key: '', label: 'here', local: true }] } as unknown as CoreAdminDeps & { store: typeof store }
    const body = JSON.stringify({ order: 'API first', plan: 'specs/tasks.md', tasks: [{ repo: 'payroll-api', title: 'Serve', type: 'task', refs: ['T010'] }, { repo: 'quotes-app', title: 'Show', type: 'task', refs: ['T011', 'T012'], after: ['payroll-api'] }] })
    await fs.writeFile(path.join(root, 'specs/plan.json'), body)
    await fs.writeFile(path.join(outside, 'plan.json'), body)
    await expect(splitFeature(d, projects[0] as Project, feature, '', { ...who, from: '../outside/plan.json' }, start)).rejects.toThrow(/--from: \.\.\/outside\/plan.json is outside the workspace's root/)
    await expect(splitFeature(d, projects[0] as Project, feature, '', { ...who, from: 'specs/nope.json' }, start)).rejects.toThrow(/was not found/)
    await expect(splitFeature(d, projects[0] as Project, feature, '', { ...who, from: 'specs/tasks.md' }, start)).rejects.toThrow(/not valid JSON \(specs\/tasks.md\)/)
    // The plan file named by the plan must be there, under the root.
    const missing = JSON.stringify({ order: 'x', plan: 'specs/gone.md', tasks: [{ repo: 'payroll-api', title: 'Serve', type: 'task' }] })
    await expect(splitFeature(d, projects[0] as Project, feature, missing, who, start)).rejects.toThrow(/plan: specs\/gone.md was not found/)
    const link = JSON.stringify({ order: 'x', plan: 'specs/escape.md', tasks: [{ repo: 'payroll-api', title: 'Serve', type: 'task' }] })
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'specs/escape.md'))
    await expect(splitFeature(d, projects[0] as Project, feature, link, who, start)).rejects.toThrow(/plan: specs\/escape.md is outside/)
    expect((await store.tasks()).filter(t => t.feature)).toEqual([])
    // stdin keeps working: the same plan from a file, then nothing added twice.
    const r = await splitFeature(d, projects[0] as Project, feature, '', { ...who, from: 'specs/plan.json' }, start)
    expect(r).toMatchObject({ planFile: 'specs/tasks.md', tasks: [{ id: 'PA-1', refs: ['T010'] }, { id: 'QA-1', refs: ['T011', 'T012'], after: 'PA-1' }] })
    expect(await store.task('QA-1')).toMatchObject({ feature: 'WS-1', refs: ['T011', 'T012'] })
    expect(await store.task('WS-1')).toMatchObject({ plan: { order: 'API first', file: 'specs/tasks.md' } })
    // A later sub-task takes refs too; bad ones are refused by the store.
    await expect(store.addTask({ project: 'QA', title: 'More', type: 'task', feature: 'WS-1', refs: ['bad ref'] })).rejects.toThrow()
    await expect(store.addTask({ project: 'QA', title: 'More', type: 'task', refs: ['T1'] })).rejects.toThrow()
    expect(await store.addTask({ project: 'QA', title: 'More', type: 'task', feature: 'WS-1', refs: ['T013'] })).toMatchObject({ refs: ['T013'] })
  })

  describe('feature close, and the write-back once a sub-task is done', () => {
    const pmDir = () => path.join(dir, 'pm')
    let store: ReturnType<typeof createPmStore>
    const doneStep = { at: 0, started: true, done: true, proofs: {}, rounds: {} }
    const cli = (token: string, argv: string[]) => runCommand({ store, call, machines: () => [{ key: '', label: 'here', local: true }] } as unknown as CoreAdminDeps & { store: typeof store }, token, { argv })
    const setup = async (rootGit: 'none' | 'member' = 'none', more: Partial<Project> = {}) => {
      store = createPmStore(pmDir())
      await store.setEnabled(true)
      await fs.mkdir(path.join(root, 'payroll-api'), { recursive: true })
      const projects: Record<string, unknown>[] = [
        { key: 'WS', name: 'Work', machine: '', path: root, kind: 'workspace', git: false, addedAt: 1, ...more },
        { key: 'PA', name: 'Payroll', machine: '', path: path.join(root, 'payroll-api'), workspace: 'WS', addedAt: 1 },
      ]
      if (rootGit === 'member') projects.push({ key: 'RT', name: 'Root', machine: '', path: root, workspace: 'WS', addedAt: 1 })
      await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects }))
      const feature = await store.addTask({ project: 'WS', title: 'Export', type: 'feature' })
      await store.saveTask({ ...feature, plan: { order: 'x', file: 'specs/tasks.md' } })
      const sub = await store.addTask({ project: 'PA', title: 'Serve', type: 'task', feature: feature.id, refs: ['T010', 'T011'] })
      return { feature, sub, token: await issueToken(store, 'WS') }
    }
    const finish = (id: string) => store.updateTask(id, t => ({ ...t, step: doneStep }))
    const notices: string[] = []
    const notify = async (_t: Task, shown: string, file: string, why: string) => { notices.push(`${shown} ${file} ${why}`) }
    const tick = async (id: string, now?: number) => tickPlanFile({ store, call, machines: () => [{ key: '', label: 'here', local: true }] } as never, id, { notify, ...(now ? { now } : {}) })
    beforeEach(() => { notices.length = 0 })
    const planText = () => fs.readFile(path.join(root, 'specs/tasks.md'), 'utf8')
    const initRepo = (branch = 'main') => {
      git(root, 'init', '-q', '-b', branch)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      // origin's default branch: the one to commit on when no base is set.
      git(root, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD')
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`)
    }

    it('refuses to close with lines of the plan file unticked, lists them, and closes with --anyway', async () => {
      const { feature, sub, token } = await setup()
      await finish(sub.id)
      await expect(cli(token, ['feature', 'close', feature.id])).rejects.toThrow(/6 lines of specs\/tasks.md still unticked: T010 \[P\] \[US1\] Add the endpoint; T011/)
      await tick(sub.id)
      await expect(cli(token, ['feature', 'close', feature.id])).rejects.toThrow(/4 lines of specs\/tasks.md still unticked: T012 Nested line/)
      await cli(token, ['feature', 'close', feature.id, '--anyway'])
      expect(await store.task(feature.id)).toMatchObject({ closed: { by: expect.any(String) } })
      expect((await store.task(feature.id))!.log!.at(-1)!.text).toMatch(/closed the feature \(--anyway: plan lines of specs\/tasks.md may be unticked\)/)
    })

    it('closes a feature whose plan file is all ticked, or that has none', async () => {
      const { feature, sub, token } = await setup()
      await fs.writeFile(path.join(root, 'specs/tasks.md'), '- [x] T010 a\n- [x] T011 b\n')
      await finish(sub.id)
      await cli(token, ['feature', 'close', feature.id])
      expect(await store.task(feature.id)).toMatchObject({ closed: expect.anything() })
      const other = await store.addTask({ project: 'WS', title: 'No plan', type: 'feature' })
      await cli(token, ['feature', 'close', other.id])
      expect(await store.task(other.id)).toMatchObject({ closed: expect.anything() })
    })

    it('shows the plan file on the feature and the refs on the sub-task', async () => {
      const { feature, sub, token } = await setup()
      await noteTurn(store, 'WS', 'user', 'add a task')
      expect(await cli(token, ['show', feature.id])).toMatchObject({ task: { planFile: 'specs/tasks.md' } })
      expect(await cli(token, ['show', sub.id])).toMatchObject({ task: { refs: ['T010', 'T011'] } })
      await expect(cli(token, ['task', 'add', 'More', '--type', 'task', '--feature', feature.id, '--refs', 'T020', '--project', 'PA'])).resolves.toMatchObject({ task: { refs: ['T020'] } })
      const bare = await store.addTask({ project: 'WS', title: 'No plan', type: 'feature' })
      await expect(cli(token, ['task', 'add', 'More', '--type', 'task', '--feature', bare.id, '--refs', 'T020', '--project', 'PA'])).rejects.toThrow(/has no plan file/)
    })

    it('with no git in the root, ticks the lines in the file and nothing else', async () => {
      const { sub } = await setup()
      await fs.writeFile(path.join(root, 'other.md'), '- [ ] T010 not the plan\n')
      expect(await tick(sub.id)).toBeUndefined()
      // Not done yet: nothing.
      expect(await planText()).toBe(PLAN)
      await finish(sub.id)
      await tick(sub.id)
      const lines = (await planText()).split('\n')
      expect(lines[2]).toMatch(/^- \[x\] T010 \[P\] \[US1\] Add the endpoint \(done: PA-1, \d{4}-\d{2}-\d{2}\)$/)
      expect(lines[3]).toMatch(/^- \[x\] T011 \[US1\] Add the button \(see FR-2\) \(done: PA-1, \d{4}-\d{2}-\d{2}\)$/)
      expect(await fs.readFile(path.join(root, 'other.md'), 'utf8')).toBe('- [ ] T010 not the plan\n')
      const task = (await store.task(sub.id))!
      expect(task.planTick).toMatchObject({ ticked: ['T010', 'T011'] })
      expect(task.log!.at(-1)!.text).toBe(`plan: ticked T010, T011 in specs/tasks.md (written, the root has no git)`)
      // Once only.
      const after = await planText()
      await tick(sub.id)
      expect(await planText()).toBe(after)
    })

    it('says a line already ticked or missing, and ticks the rest', async () => {
      const { sub } = await setup()
      await store.updateTask(sub.id, t => ({ ...t, refs: ['T013', 'T011', 'T099'] }))
      await finish(sub.id)
      await tick(sub.id)
      const text = await planText()
      expect(text).toContain('- [x] T011 [US1] Add the button (see FR-2) (done: PA-1')
      expect(text).toContain('- [x] T013 Already done by hand\n')
      expect((await store.task(sub.id))!.log!.at(-1)!.text).toMatch(/\(written, the root has no git\); plan: T013 not ticked \(already ticked\); plan: T099 not ticked \(not found\)$/)
    })

    it('commits the plan file only, on the root member\'s branch, with the template\'s message, other work untouched', async () => {
      const { sub } = await setup('member', { shared: { commitMessage: '{id}: {title}' } } as Partial<Project>)
      initRepo()
      await fs.writeFile(path.join(root, 'staged.txt'), 'staged\n')
      git(root, 'add', 'staged.txt')
      await fs.writeFile(path.join(root, 'specs/unstaged.md'), 'x\n')
      await store.updateTask(sub.id, t => ({ ...t, refs: ['T010'] }))
      await finish(sub.id)
      await tick(sub.id)
      expect(git(root, 'log', '-1', '--format=%s')).toBe('PA-1: tick T010 (Serve)')
      expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('specs/tasks.md')
      expect(git(root, 'status', '--porcelain')).toBe('A  staged.txt\n?? specs/unstaged.md')
      expect((await store.task(sub.id))!.log!.at(-1)!.text).toMatch(/^plan: ticked T010 in specs\/tasks.md \(committed [0-9a-f]{7,}\)$/)
    })

    it('without a template, the message names the feature, the lines and the task', async () => {
      const { sub } = await setup()
      initRepo()
      await finish(sub.id)
      await tick(sub.id)
      expect(git(root, 'log', '-1', '--format=%s')).toBe('WS-1: tick T010, T011 (PA-1)')
    })

    it('skips a plan file with local changes, and tells the workspace\'s coordinator', async () => {
      const { sub } = await setup()
      initRepo()
      await store.saveCoordinator({ ...(await store.coordinator('WS'))!, terminal: 't1', autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
      await fs.appendFile(path.join(root, 'specs/tasks.md'), '- [ ] T200 added by the user\n')
      const before = await planText()
      await finish(sub.id)
      await tick(sub.id)
      expect(await planText()).toBe(before)
      expect(git(root, 'log', '--format=%s')).toBe('init')
      const task = (await store.task(sub.id))!
      expect(task.planTick).toEqual({ at: expect.any(Number), skipped: 'specs/tasks.md has local changes' })
      expect(task.log!.at(-1)!.text).toBe('plan: T010, T011 not ticked in specs/tasks.md: specs/tasks.md has local changes')
      const wakes = await store.wakes()
      expect(JSON.stringify(wakes)).toMatch(/PA-1 is done, but its plan lines T010, T011 are not ticked in specs\/tasks.md/)
      const n = wakes.length
      await tick(sub.id)
      expect((await store.wakes()).length).toBe(n)
    })

    it('skips a staged change, an untracked plan file, and a root on another branch than its member\'s base', async () => {
      const staged = await setup()
      initRepo()
      await fs.appendFile(path.join(root, 'specs/tasks.md'), 'more\n')
      git(root, 'add', 'specs/tasks.md')
      await fs.writeFile(path.join(root, 'specs/tasks.md'), PLAN)
      await finish(staged.sub.id)
      await tick(staged.sub.id)
      expect((await store.task(staged.sub.id))!.planTick!.skipped).toBe('specs/tasks.md has local changes')
      await fs.rm(pmDir(), { recursive: true, force: true })

      // An edit hidden by an index flag is a local change too.
      for (const flag of ['--assume-unchanged', '--skip-worktree']) {
        await fs.rm(path.join(root, '.git'), { recursive: true })
        const hidden = await setup()
        initRepo()
        git(root, 'update-index', flag, 'specs/tasks.md')
        await fs.appendFile(path.join(root, 'specs/tasks.md'), 'mine\n')
        await finish(hidden.sub.id)
        await tick(hidden.sub.id)
        expect((await store.task(hidden.sub.id))!.planTick!.skipped).toBe('specs/tasks.md has local changes')
        expect(git(root, 'show', 'HEAD:specs/tasks.md')).toBe(PLAN.trimEnd())
        await fs.writeFile(path.join(root, 'specs/tasks.md'), PLAN)
        await fs.rm(pmDir(), { recursive: true, force: true })
      }

      await fs.rm(path.join(root, '.git'), { recursive: true })
      const untracked = await setup()
      git(root, 'init', '-q', '-b', 'main')
      await finish(untracked.sub.id)
      await tick(untracked.sub.id)
      expect((await store.task(untracked.sub.id))!.planTick!.skipped).toBe('specs/tasks.md is not tracked by git')
      await fs.rm(pmDir(), { recursive: true, force: true })

      await fs.rm(path.join(root, '.git'), { recursive: true })
      const other = await setup('member', { shared: { base: 'main' } } as Partial<Project>)
      initRepo('feature-x')
      await finish(other.sub.id)
      await tick(other.sub.id)
      expect((await store.task(other.sub.id))!.planTick!.skipped).toMatch(/^the root is on branch feature-x \(not main\)$/)
      expect(await planText()).toBe(PLAN)
    })

    // A commit that fails: signing with a program that says no (and, for the second test, edits the file as the user would).
    const failSigning = async (also = '') => {
      const gpg = path.join(dir, 'gpg-no')
      await fs.writeFile(gpg, `#!/bin/sh\n${also}echo "no commits today" >&2\nexit 1\n`, { mode: 0o755 })
      git(root, 'config', 'commit.gpgsign', 'true')
      git(root, 'config', 'gpg.program', gpg)
    }

    it('runs no hook of the root, and leaves the file as it was when the commit fails', async () => {
      const { sub } = await setup()
      initRepo()
      // A hook that would touch other work never runs.
      await fs.writeFile(path.join(root, '.git/hooks/pre-commit'), `#!/bin/sh\necho hooked > "${path.join(root, 'hooked')}"\n`, { mode: 0o755 })
      await failSigning()
      await finish(sub.id)
      await tick(sub.id)
      expect(await planText()).toBe(PLAN)
      expect(git(root, 'status', '--porcelain')).toBe('')
      expect((await store.task(sub.id))!.planTick!.skipped).toMatch(/^git could not commit it/)
    })

    it('skips a plan file in another git repository than the root\'s: a member\'s clone under a root without git', async () => {
      const { sub } = await setup()
      await fs.rename(path.join(root, 'specs'), path.join(root, 'payroll-api/specs'))
      git(path.join(root, 'payroll-api'), 'init', '-q', '-b', 'main')
      await store.saveTask({ ...(await store.task(sub.feature!))!, plan: { order: 'x', file: 'payroll-api/specs/tasks.md' } })
      await finish(sub.id)
      await tick(sub.id)
      expect(await fs.readFile(path.join(root, 'payroll-api/specs/tasks.md'), 'utf8')).toBe(PLAN)
      expect((await store.task(sub.id))!.planTick!.skipped).toMatch(/is in another git repository/)
    })

    it('checks the branch against origin\'s default one when the root is not a member', async () => {
      const { sub } = await setup()
      initRepo('dev')
      git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      await finish(sub.id)
      await tick(sub.id)
      expect((await store.task(sub.id))!.planTick!.skipped).toBe('the root is on branch dev (not main)')
      expect(await planText()).toBe(PLAN)
    })

    it('skips when no branch is known: no base and no origin\'s default branch', async () => {
      const { sub } = await setup()
      initRepo('feature-work')
      git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
      await finish(sub.id)
      await tick(sub.id)
      expect((await store.task(sub.id))!.planTick!.skipped).toMatch(/^no branch to check the root against/)
      expect(git(root, 'log', '--format=%s')).toBe('init')
      expect(await planText()).toBe(PLAN)
    })

    it('does not tick an abandoned task, one without a plan file, or one not done', async () => {
      const { sub } = await setup()
      await store.updateTask(sub.id, t => ({ ...t, step: { ...doneStep, abandoned: true } }))
      await tick(sub.id)
      expect(await planText()).toBe(PLAN)
      expect((await store.task(sub.id))!.planTick).toBeUndefined()
    })

    it('puts the old text back when the commit times out, and does not tick again (a final skip)', async () => {
      const { sub } = await setup()
      initRepo()
      // A `timeout` that always fires, first in the PATH.
      const bin = path.join(dir, 'bin')
      await fs.mkdir(bin)
      await fs.writeFile(path.join(bin, 'timeout'), '#!/bin/sh\nexit 124\n', { mode: 0o755 })
      hooks.path = `${bin}:${process.env.PATH}`
      await finish(sub.id)
      await tick(sub.id)
      expect(await planText()).toBe(PLAN)
      expect(git(root, 'status', '--porcelain')).toBe('')
      expect((await store.task(sub.id))!.planTick!.skipped).toBe('git took more than 45 seconds to commit it')
      expect(notices).toHaveLength(1)
      // The exec itself timing out: the script may have run on, so never tried again; an unknown exit throws.
      expect(planWriteResult(null, '', 'p.md', '')).toEqual({ skipped: 'writing p.md timed out: look at it before ticking by hand' })
      expect(() => planWriteResult(1, '', 'p.md', '')).toThrow(/exit 1/)
    })

    it('leaves a file the user changed during a failed commit alone', async () => {
      const { sub } = await setup()
      initRepo()
      // The user edits the plan file while the commit fails.
      await failSigning(`echo "mine" >> "${path.join(root, 'specs/tasks.md')}"\n`)
      await finish(sub.id)
      await tick(sub.id)
      expect(await planText()).toContain('- [x] T010')
      expect(await planText()).toMatch(/mine\n$/)
      expect((await store.task(sub.id))!.planTick!.skipped).toMatch(/^git could not commit it/)
    })

    it('runs the commit with no `timeout` program at all (a plain shell watchdog)', async () => {
      const { sub } = await setup()
      initRepo()
      // Every program of the usual folders but timeout and gtimeout.
      const bin = path.join(dir, 'bin')
      await fs.mkdir(bin)
      const gitDir = path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())
      for (const d of new Set(['/usr/bin', '/bin', gitDir]))
        for (const name of await fs.readdir(d).catch(() => [] as string[]))
          if (!['timeout', 'gtimeout'].includes(name)) await fs.symlink(path.join(d, name), path.join(bin, name)).catch(() => {})
      hooks.path = bin
      await finish(sub.id)
      await tick(sub.id)
      expect(git(root, 'log', '-1', '--format=%s')).toBe('WS-1: tick T010, T011 (PA-1)')
      expect(await fs.readdir(path.join(root, 'specs'))).toEqual(['tasks.md'])
    })

    it('refuses a detached HEAD for good, and a merge, rebase, cherry-pick, revert or bisect under way for now', async () => {
      const detached = await setup()
      initRepo()
      git(root, 'checkout', '-q', '--detach')
      await finish(detached.sub.id)
      await tick(detached.sub.id)
      expect((await store.task(detached.sub.id))!.planTick!.skipped).toBe('the root is on no branch (a detached HEAD)')
      expect(await planText()).toBe(PLAN)
      expect(notices).toHaveLength(1)
      notices.length = 0
      for (const [marker, what] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']] as const) {
        await fs.rm(pmDir(), { recursive: true, force: true })
        await fs.rm(path.join(root, '.git'), { recursive: true, force: true })
        const s = await setup()
        initRepo()
        await fs.writeFile(path.join(root, '.git', marker), marker.includes('-') ? '' : 'x\n')
        await finish(s.sub.id)
        await tick(s.sub.id)
        const task = (await store.task(s.sub.id))!
        expect(task.planTick, marker).toBeUndefined()
        expect(task.planTries, marker).toMatchObject({ n: 1, why: `a ${what} is under way in the root` })
        expect(await planText(), marker).toBe(PLAN)
        expect(notices).toEqual([])
      }
    })

    it('tries again while git\'s index is locked, then gives up for good after the bound, telling the user once', async () => {
      const { sub } = await setup()
      initRepo()
      await store.saveCoordinator({ ...(await store.coordinator('WS'))!, terminal: 't1', autopilot: { ...DEFAULT_AUTOPILOT, on: true } })
      await fs.writeFile(path.join(root, '.git/index.lock'), '')
      await finish(sub.id)
      const t0 = Date.now()
      await tick(sub.id, t0)
      expect((await store.task(sub.id))!.planTries).toMatchObject({ n: 1, why: 'git\'s index is locked (another git command is running)' })
      expect((await store.task(sub.id))!.log!.at(-1)!.text).toMatch(/^plan: T010, T011 not ticked yet in specs\/tasks.md: git's index is locked.*tries again$/)
      // Too soon: not tried.
      await tick(sub.id, t0 + 60_000)
      expect((await store.task(sub.id))!.planTries!.n).toBe(1)
      for (let i = 1; i < 11; i++) await tick(sub.id, t0 + i * PLAN_RETRY_MS)
      expect((await store.task(sub.id))!.planTries!.n).toBe(11)
      expect((await store.task(sub.id))!.planTick).toBeUndefined()
      expect(notices).toEqual([])
      await tick(sub.id, t0 + 11 * PLAN_RETRY_MS)
      const task = (await store.task(sub.id))!
      expect(task.planTick!.skipped).toBe('git\'s index is locked (another git command is running), still after 12 tries')
      expect(task.planTries).toBeUndefined()
      expect(notices).toEqual(['PA-1 specs/tasks.md git\'s index is locked (another git command is running), still after 12 tries'])
      expect(JSON.stringify(await store.wakes())).toMatch(/PA-1 is done, but its plan lines T010, T011 are not ticked/)
      expect(await planText()).toBe(PLAN)
      // Done: no more tries.
      await tick(sub.id, t0 + 20 * PLAN_RETRY_MS)
      expect(notices).toHaveLength(1)
    })

    it('gives up after an hour as well, and goes on at once when the lock is gone', async () => {
      const { sub } = await setup()
      initRepo()
      await fs.writeFile(path.join(root, '.git/index.lock'), '')
      await finish(sub.id)
      const t0 = Date.now()
      await tick(sub.id, t0)
      await tick(sub.id, t0 + 20 * 60_000)
      await tick(sub.id, t0 + 40 * 60_000)
      expect((await store.task(sub.id))!.planTick).toBeUndefined()
      await tick(sub.id, t0 + 60 * 60_000)
      expect((await store.task(sub.id))!.planTick!.skipped).toMatch(/index is locked.*, still after 4 tries$/)
      // Another task: the lock goes before the bound.
      await fs.rm(pmDir(), { recursive: true, force: true })
      const s = await setup()
      await finish(s.sub.id)
      await tick(s.sub.id, t0)
      await fs.rm(path.join(root, '.git/index.lock'))
      await tick(s.sub.id, t0 + PLAN_RETRY_MS)
      expect((await store.task(s.sub.id))!.planTick).toMatchObject({ ticked: ['T010', 'T011'] })
      expect((await store.task(s.sub.id))!.planTries).toBeUndefined()
      expect(git(root, 'log', '-1', '--format=%s')).toBe('WS-1: tick T010, T011 (PA-1)')
    })

    it('tries again when the file changed between its read and its write, and ticks the user\'s new text', async () => {
      const { sub } = await setup()
      await finish(sub.id)
      hooks.beforeWrite = () => { execFileSync('sh', ['-c', `printf '%s\\n' '- [ ] T300 typed meanwhile' >> "${path.join(root, 'specs/tasks.md')}"`]) }
      const t0 = Date.now()
      await tick(sub.id, t0)
      expect(await planText()).toBe(`${PLAN}- [ ] T300 typed meanwhile\n`)
      expect((await store.task(sub.id))!.planTries).toMatchObject({ n: 1, why: 'specs/tasks.md changed while it was being ticked' })
      expect((await store.task(sub.id))!.planTick).toBeUndefined()
      hooks.beforeWrite = undefined
      await tick(sub.id, t0 + PLAN_RETRY_MS)
      expect(await planText()).toContain('- [x] T010')
      expect(await planText()).toContain('- [ ] T300 typed meanwhile')
      expect((await store.task(sub.id))!.planTick).toMatchObject({ ticked: ['T010', 'T011'] })
    })

    it('coalesces ticks of one task started together: one write', async () => {
      const { sub } = await setup()
      await finish(sub.id)
      await Promise.all([tick(sub.id), tick(sub.id), tick(sub.id)])
      expect(hooks.writes).toBe(1)
      expect((await store.task(sub.id))!.planTick).toMatchObject({ ticked: ['T010', 'T011'] })
    })

    it('tells the user of a skip when no coordinator\'s autopilot is on, and of a pass that ticked nothing', async () => {
      const { sub } = await setup()
      initRepo()
      await fs.appendFile(path.join(root, 'specs/tasks.md'), '- [ ] T200 added by the user\n')
      await finish(sub.id)
      await tick(sub.id)
      expect(notices).toEqual(['PA-1 specs/tasks.md specs/tasks.md has local changes'])
      expect(await store.wakes()).toEqual([])
      // Every ref missing or ticked by hand: nothing to write, said to the user too.
      await fs.rm(pmDir(), { recursive: true, force: true })
      await fs.rm(path.join(root, '.git'), { recursive: true })
      notices.length = 0
      const s = await setup()
      await store.updateTask(s.sub.id, t => ({ ...t, refs: ['T013', 'T099'] }))
      await finish(s.sub.id)
      await tick(s.sub.id)
      expect((await store.task(s.sub.id))!.planTick).toEqual({ at: expect.any(Number), ticked: [] })
      expect(notices).toEqual(['PA-1 specs/tasks.md T013 not ticked (already ticked); T099 not ticked (not found)'])
    })

    it('says an offline machine once, waits for it, and ticks when it is back', async () => {
      const { sub } = await setup()
      await finish(sub.id)
      let up = false
      // An unreachable machine is a remote one that is offline (here, its exec runs this machine once it is online).
      const remote = () => [{ key: '', label: 'far', local: false, status: up ? 'online' : 'offline' }]
      const go = (now: number) => tickPlanFile({ store, call, machines: remote } as never, sub.id, { notify, now })
      const t0 = Date.now()
      await go(t0)
      await go(t0 + 60_000)
      await go(t0 + 120_000)
      expect((await store.task(sub.id))!.log!.filter(e => /tries again when the machine is back/.test(e.text))).toHaveLength(1)
      expect((await store.task(sub.id))!.planTries).toMatchObject({ offline: true })
      expect((await store.task(sub.id))!.planTick).toBeUndefined()
      expect(notices).toEqual([])
      up = true
      await go(t0 + 180_000)
      expect((await store.task(sub.id))!.planTick).toMatchObject({ ticked: ['T010', 'T011'] })
    })
  })
})
