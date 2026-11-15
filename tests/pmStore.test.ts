import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { cleanProjectInput } from '../shared/pm/project'
import { defaultWorkflow } from '../shared/pm/workflow'
import { initialState, onEvent, planSteps } from '../shared/pm/steps'

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-store-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const okFolder = async (_m: string, p: string) => p.replace(/^~/, '/home/u')
const template = { id: 'vibe', version: 1, taskTypes: { simple: { steps: [{ id: 'work', holder: 'worker', ends: 'report' }] } } }
const input = { key: 'web', name: 'Web app', machine: '', path: '~/src/web', template: 'vibe' }

describe('pm store', () => {
  it('is off by default, and off it refuses every write without touching the disk', async () => {
    const store = createPmStore(dir)
    expect(await store.overview()).toEqual({ enabled: false, projects: [], templates: [], tasks: [] })
    const writes = [
      store.addProject(input, okFolder), store.setTemplate('WEB', 'vibe'),
      store.removeProject('WEB'), store.saveTemplate(template),
    ]
    for (const r of await Promise.allSettled(writes)) expect(r).toMatchObject({ status: 'rejected', reason: { code: 'pm_off' } })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('saves a new project\'s autopilot with no daily limit, Auto, Task done and Task stuck on, and keeps the values a project saved', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(template)
    await store.saveCoordinator({ project: 'WEB', tokenHash: '', autopilot: { on: true, goal: '', events: [], perDay: 10, atOnce: 2 } })
    await store.addProject(input, okFolder)
    await store.addProject({ ...input, key: 'api', path: '~/src/api' }, okFolder)
    expect((await store.coordinator('WEB'))?.autopilot).toMatchObject({ perDay: 10, atOnce: 2, events: [] })
    // quiet: the old-default cleanup (quietEvents) leaves the new defaults alone.
    expect(await store.coordinator('API')).toMatchObject({ quiet: true, autopilot: { perDay: null, atOnce: null, events: ['done', 'stuck'] } })
  })

  it('keeps projects and templates across a restart, and refuses again once switched off', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    expect(await store.saveTemplate(template)).toEqual({ id: 'vibe', version: 1 })
    // Same content: no new version. A change: version 2 and a line of the log.
    await expect(store.saveTemplate(template)).rejects.toMatchObject({ code: 'exists' }) // never overwritten by mistake
    expect(await store.saveTemplate(template, { replace: true })).toEqual({ id: 'vibe', version: 1 })
    const changed = { ...template, instructions: 'Small commits.' }
    expect(await store.saveTemplate(changed, { replace: true })).toEqual({ id: 'vibe', version: 2 })
    expect((await store.templateLog('vibe')).map(e => [e.version, e.changes])).toEqual([[1, []], [2, ['instructions']]])
    await store.saveTemplate({ ...template, version: 9 }, { replace: true }) // back to the first content: version 3, whatever the client said
    const added = await store.addProject(input, okFolder)
    expect(added).toMatchObject({ key: 'WEB', name: 'Web app', machine: '', path: '/home/u/src/web', from: { template: 'vibe', version: 3 } })

    const restarted = createPmStore(dir)
    expect(await restarted.overview()).toEqual({ enabled: true, projects: [added], templates: [{ id: 'vibe', version: 3 }], tasks: [] })

    await restarted.setEnabled(false)
    await expect(restarted.removeProject('WEB')).rejects.toMatchObject({ code: 'pm_off' })
    expect((await createPmStore(dir).overview()).projects).toEqual([added])
  })

  it('checks keys, folders and templates', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await expect(store.addProject(input, okFolder)).rejects.toMatchObject({ code: 'not_found' }) // no template yet
    await store.saveTemplate(template)
    await store.addProject(input, okFolder)
    await expect(store.addProject(input, okFolder)).rejects.toMatchObject({ code: 'exists' })
    await expect(store.addProject({ ...input, key: 'API', path: '/home/u/src/web' }, okFolder)).rejects.toThrow('already a project')
    const notGit = () => Promise.reject(Object.assign(new Error('not git'), { code: 'not_git' }))
    await expect(store.addProject({ ...input, key: 'API', path: '/x' }, notGit)).rejects.toMatchObject({ code: 'not_git' })
    await expect(store.saveTemplate({ ...template, taskTypes: { simple: { steps: [{ id: 'w', holder: 'robot', ends: 'report' }] } } }))
      .rejects.toMatchObject({ code: 'bad_input' })
    await expect(store.saveTemplate({ ...template, id: '../evil' })).rejects.toMatchObject({ code: 'bad_input' })

    expect(await store.setTemplate('WEB', '')).not.toHaveProperty('from')
    expect(await store.savedWorkflow('WEB')).toBeNull()
    // No workflow accepted yet: the minimal default runs a task, todo → work → done.
    const t = (await store.workflow('WEB'))!
    expect(t).toEqual(defaultWorkflow('WEB'))
    const plan = planSteps(t, { type: 'task' })
    expect(plan.map(s => s.id)).toEqual(['todo', 'work', 'done'])
    const started = onEvent(plan, initialState(), { kind: 'start' }, 0).state
    expect(plan[started.at]!.holder).toBe('worker')
    expect(onEvent(plan, started, { kind: 'report', from: 'worker' }, 1).state).toMatchObject({ at: 2, done: true })
    await expect(store.setTemplate('WEB', 'company')).rejects.toMatchObject({ code: 'not_found' })
    await store.setTemplate('WEB', 'vibe')
    await store.removeProject('WEB')
    expect((await store.overview()).projects).toEqual([])
    // Added again under the same key: none of the removed project's workflow or log.
    await store.addProject({ ...input, template: '' }, okFolder)
    expect(await store.savedWorkflow('WEB')).toBeNull()
    expect(await store.workflowLog('WEB')).toEqual([])
  })
})

describe('runs', () => {
  it('reads a run file again only when it changed', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const run = (id: string, state: 'running' | 'ended') => ({ id, task: 'WEB-1', role: 'worker' as const, program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'b', instructions: '/i', attempt: 1, state, startedAt: 1 })
    await store.saveRun(run('a', 'ended'))
    await store.saveRun(run('b', 'running'))
    expect((await store.runs()).map(r => r.id)).toEqual(['a', 'b'])
    const reads = vi.spyOn(fs, 'readFile')
    try {
      await store.runs()
      expect(reads.mock.calls.filter(c => String(c[0]).includes('runs'))).toEqual([])
      await store.saveRun(run('b', 'ended'))
      expect((await store.runs()).map(r => r.state)).toEqual(['ended', 'ended'])
      expect(reads.mock.calls.filter(c => String(c[0]).includes('runs')).map(c => path.basename(String(c[0])))).toEqual(['b.json'])
    } finally { reads.mockRestore() }
  })
})

describe('workflows migration', () => {
  it('copies each project\'s template and log into its own workflow, once, leaving the library as is', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(template)
    await store.saveTemplate({ ...template, instructions: 'Small commits.' }, { replace: true })
    const library = await fs.readFile(path.join(store.files.templates, 'vibe.json'), 'utf8')
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [
      { key: 'WEB', name: 'Web', machine: '', path: '/w', template: 'vibe', addedAt: 1 },
      { key: 'API', name: 'Api', machine: '', path: '/a', addedAt: 1 },
    ] }))
    expect(await store.projects()).toEqual([
      { key: 'WEB', name: 'Web', machine: '', path: '/w', from: { template: 'vibe', version: 2 }, addedAt: 1, color: 'violet' },
      { key: 'API', name: 'Api', machine: '', path: '/a', addedAt: 1, color: 'blue' },
    ])
    expect(await store.workflow('WEB')).toMatchObject({ id: 'web', version: 2, instructions: 'Small commits.' })
    expect((await store.workflowLog('WEB')).map(e => [e.version, e.changes])).toEqual([[1, []], [2, ['instructions']], [2, ['copied from template vibe v2']]])
    expect(await store.savedWorkflow('API')).toBeNull()
    expect(await fs.readFile(path.join(store.files.templates, 'vibe.json'), 'utf8')).toBe(library)
    // A restart changes nothing more.
    const again = createPmStore(dir)
    expect(await again.projects()).toEqual(await store.projects())
    expect(await again.workflowLog('WEB')).toHaveLength(3)
  })
})

describe('template library', () => {
  it('renames a template with its version and log, and deletes it; the project keeps its own workflow', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(template)
    await store.addProject(input, okFolder)
    await store.saveTemplate({ ...template, id: 'other' })
    await expect(store.renameTemplate('vibe', 'other')).rejects.toMatchObject({ code: 'exists' })
    await expect(store.renameTemplate('vibe', 'Bad Id')).rejects.toMatchObject({ code: 'bad_input' })
    await store.renameTemplate('vibe', 'team')
    expect((await store.overview()).templates).toEqual([{ id: 'other', version: 1 }, { id: 'team', version: 1 }])
    expect((await store.templateLog('team')).map(e => e.changes)).toEqual([[], ['renamed from vibe']])
    expect((await store.project('WEB'))?.from).toEqual({ template: 'team', version: 1 }) // "Based on" follows the name
    await store.removeTemplate('team')
    await expect(store.removeTemplate('team')).rejects.toMatchObject({ code: 'not_found' })
    expect(await store.templateLog('team')).toEqual([])
    expect(await store.workflow('WEB')).toMatchObject({ id: 'web' })
  })

  it('stores a member\'s own fields only, serves it with its workspace\'s settings, and refuses what breaks a workspace', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.addProject({ key: 'ws', name: 'Work', machine: '', path: '~/work', kind: 'workspace', group: 'g1', shared: { base: 'develop', machines: ['big'], clones: { big: '/srv/work' } } }, okFolder)
    await store.addProject({ key: 'pay', machine: '', path: '~/work/payroll-api', workspace: 'ws', base: 'main', color: 'red' }, okFolder)
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'projects.json'), 'utf8')).projects
    expect(Object.keys(raw[1]).sort()).toEqual(['addedAt', 'color', 'key', 'machine', 'name', 'path', 'workspace'])
    expect(raw[0]).toMatchObject({ kind: 'workspace', git: false, group: 'g1' })
    expect(await store.project('PAY')).toMatchObject({ base: 'develop', clones: { big: '/srv/work/payroll-api' } })
    expect(await store.coordinator('PAY')).toBeNull()
    await expect(store.addTask({ project: 'WS', title: 'Fix', type: 'task' })).rejects.toThrow('features only')
    await expect(store.addProject({ key: 'xy', machine: '', path: '~/x', workspace: 'NOPE' }, okFolder)).rejects.toThrow('no existing workspace')
    // An override is the member's own; '' gives it back.
    await store.updateProject('PAY', { base: 'main' })
    expect(await store.project('PAY')).toMatchObject({ base: 'main', overrides: ['base'] })
    await store.updateProject('PAY', { base: '' })
    expect((await store.project('PAY'))?.base).toBe('develop')
    await store.setBase('PAY', 'main')
    expect((await store.project('PAY'))?.base).toBe('main')
    await store.setBase('PAY', '')
    expect((await store.project('PAY'))?.base).toBe('develop')
    // Without its own file, the member runs the workspace's; a served copy saves without the workspace's guards.
    await store.saveWorkflow('WS', { ...defaultWorkflow('WS'), guards: { protected: ['main'] } })
    expect(await store.workflow('PAY')).toMatchObject({ id: 'pay', workspaceGuards: { protected: ['main'] } })
    await store.saveWorkflow('PAY', { ...defaultWorkflow('PAY'), prefs: { agent: 'claude' }, worktree: { copy: ['config.json'] }, workspaceGuards: { protected: ['x'] } })
    expect(await store.savedWorkflow('PAY')).not.toHaveProperty('workspaceGuards')
    await store.saveWorkflow('PAY', { ...defaultWorkflow('PAY'), prefs: { agent: 'claude' }, worktree: { copy: ['config.json'] } })
    expect(await store.workflow('PAY')).toMatchObject({ prefs: { agent: 'claude' }, worktree: { copy: ['config.json'] } })
  })
})

describe('cleanProjectInput', () => {
  it('normalises the key and refuses bad fields', () => {
    expect(cleanProjectInput({ key: ' whr ', machine: 'mac', path: '/w', base: 'v3' }).project)
      .toEqual({ key: 'WHR', name: 'WHR', machine: 'mac', path: '/w', base: 'v3' })
    const { errors } = cleanProjectInput({ key: '1x', machine: 3, path: 'rel', base: 'a..b', template: 'Bad Id' })
    expect(errors.map(e => e.path)).toEqual(['key', 'machine', 'path', 'base', 'template'])
  })
})
