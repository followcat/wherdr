// Project settings on the server (server/utils/pmProject.ts): who may change
// the guards, a workflow save that may not touch them, and applying a template.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { ALFRED_TOKEN_FILE, issueAlfredToken, issueToken } from '../server/utils/pmCoordinator'
import { guardsAuthor, projectView, saveProjectGuards, saveProjectWorkflow, templateFromProject, updateProject } from '../server/utils/pmProject'
import { common, company, vibe } from '../shared/pm/examples'
import { templateDiff } from '../shared/pm/coordinator'
import { startOverFrom } from '../shared/pm/workflow'
import { machineNamed, machinesOf, pausedEverywhere, projectCoordinatorName, taskMachine } from '../shared/pm/project'

let dir = '', store: ReturnType<typeof createPmStore>
const guards = { protected: ['main', 'release'], merge: { protected: 'user' as const, others: 'user' as const } }

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-project-'))
  store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(common)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Company', machine: '', path: '/src/co', addedAt: 1 }] }))
  await store.setTemplate('CO', 'example:company')
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('machineNamed', () => {
  it('finds an allowed machine by its name in any case, or its key; another is refused with the allowed ones', () => {
    const p = { machine: '', machines: ['b'] }, known = [{ key: '', label: 'machine-a' }, { key: 'b', label: 'machine-b' }, { key: 'c', label: 'machine-c' }]
    expect([machineNamed(p, known, 'Machine-B'), machineNamed(p, known, 'b')]).toEqual([{ machine: 'b' }, { machine: 'b' }])
    expect(machineNamed(p, known, 'machine-c')).toEqual({ refused: 'No machine named machine-c among the project\'s: machine-a, machine-b' })
  })
})

describe('a machine paused for a project', () => {
  const p = { machine: '', machines: ['b', 'c'], paused: ['', 'b'] }
  it('takes no new task: placement skips it, a start on it is refused with why, a task started there goes on', () => {
    expect(taskMachine({}, p)).toEqual({ machine: 'c' })
    expect(taskMachine({}, p, 'b')).toEqual({ refused: 'This machine is paused for this project: switch it on in the project\'s settings' })
    expect(taskMachine({ machine: 'b' }, p)).toEqual({ machine: 'b' })
    expect(taskMachine({}, { ...p, paused: ['', 'b', 'c'] })).toEqual({ refused: 'Every machine of the project is paused for this project: switch one on in the project\'s settings' })
  })
  it('stays paused while allowed, and shows as paused everywhere only when every project allowing it has it paused', () => {
    expect(machinesOf({ ...p, clones: { b: '~/b', c: '~/c' } }, { machines: ['c'] }).paused).toEqual([''])
    expect(pausedEverywhere([p, { machine: 'x' }], 'b')).toBe(true)
    expect(pausedEverywhere([p, { machine: 'x', machines: ['b'] }], 'b')).toBe(false)
    expect(pausedEverywhere([p], 'z')).toBe(false)
  })
})

describe('guardsAuthor', () => {
  it('takes the user\'s session and Alfred\'s token; a project coordinator\'s token is refused', async () => {
    expect(await guardsAuthor(store, undefined)).toBe('user')
    await issueAlfredToken(store, dir)
    const alfred = (await fs.readFile(path.join(dir, ALFRED_TOKEN_FILE), 'utf8')).trim()
    expect(await guardsAuthor(store, `Bearer ${alfred}`)).toBe('Alfred')
    const coordinator = await issueToken(store, 'CO')
    await expect(guardsAuthor(store, `Bearer ${coordinator}`)).rejects.toThrow('the user does it in Settings › Projects › CO › Guards')
    await expect(guardsAuthor(store, `Bearer ${'f'.repeat(64)}`)).rejects.toThrow('by the user or by Alfred only')
  })
})

describe('project settings', () => {
  it('saves the guards apart; a workflow save that changes them is refused', async () => {
    await saveProjectGuards(store, 'CO', guards, 'Alfred')
    const t = (await store.workflow('CO'))!
    expect(t.guards).toEqual(guards)
    expect((await store.workflowLog('CO')).at(-1)).toMatchObject({ by: 'Alfred' })
    await expect(saveProjectWorkflow(store, 'CO', { ...t, guards: { protected: [] } })).rejects.toThrow('Guards are saved in Settings › Projects › CO › Guards')
    expect(await saveProjectWorkflow(store, 'CO', { ...t, instructions: 'Base branch is v3.' })).toMatchObject({ workflow: { version: t.version! + 1 } })
  })

  it('applies a template and keeps the project\'s guards unless asked', async () => {
    // A project without a workflow yet gets the template's guards.
    await store.setTemplate('CO', '')
    await store.setTemplate('CO', 'example:company', { keepGuards: true })
    expect((await store.workflow('CO'))!.guards).toEqual(company.guards)
    await saveProjectGuards(store, 'CO', guards, 'user')
    expect(await store.setTemplate('CO', 'common', { keepGuards: true })).toMatchObject({ from: { template: 'common' } })
    expect((await store.workflow('CO'))).toMatchObject({ taskTypes: common.taskTypes, guards })
    await store.setTemplate('CO', 'example:company')
    expect((await store.workflow('CO'))!.guards).toEqual(company.guards)
  })

  it('changes the name, base and agents', async () => {
    expect(await updateProject(store, 'CO', { name: 'Co', base: 'develop', prefs: { agent: 'codex', model: '' } })).toMatchObject({ project: { name: 'Co', base: 'develop' } })
    expect((await store.workflow('CO'))!.prefs).toEqual({ agent: 'codex' })
    // The worktree setup: empty fields dropped, all empty removes it, a bad path refused.
    await updateProject(store, 'CO', { worktree: { copy: ['.env'], share: [], command: 'npm ci', timeout: '' } })
    expect((await store.workflow('CO'))!.worktree).toEqual({ copy: ['.env'], share: [], command: 'npm ci' }) // share [] kept: none
    await updateProject(store, 'CO', { worktree: { copy: [], command: 'npm ci' } })
    expect((await store.workflow('CO'))!.worktree).toEqual({ command: 'npm ci' }) // no share: node_modules
    await expect(updateProject(store, 'CO', { worktree: { copy: ['../secret'] } })).rejects.toThrow(/worktree\.copy/)
    await updateProject(store, 'CO', { worktree: { copy: [], command: '' } })
    expect((await store.workflow('CO'))!.worktree).toBeUndefined()
    expect((await updateProject(store, 'CO', { base: '' })).project).not.toHaveProperty('base')
    await expect(updateProject(store, 'CO', { base: 'a..b' })).rejects.toThrow('base: invalid branch name')
  })

  it('names its coordinator after the project unless the user named it; a rename follows only then', async () => {
    const name = async (update: Record<string, unknown>) => projectCoordinatorName((await updateProject(store, 'CO', update)).project)
    expect(await name({ name: 'Acme' })).toBe('Acme')
    expect(await name({ name: 'Acme site' })).toBe('Acme site')
    expect(await name({ coordinatorName: ' Pilot ' })).toBe('Pilot')
    expect(await name({ name: 'Acme shop' })).toBe('Pilot')
    expect(await name({ coordinatorName: '' })).toBe('Acme shop')
  })

  it('allows other machines, each with its clone; back to home only drops both fields', async () => {
    await expect(updateProject(store, 'CO', { machines: ['', 'b'] })).rejects.toThrow('clones.b: the clone\'s folder on that machine')
    await expect(updateProject(store, 'CO', { machines: ['b'], clones: { b: '~me/src' } })).rejects.toThrow('clones.b: an absolute folder path')
    expect((await updateProject(store, 'CO', { machines: ['b'], clones: { b: '~/co', c: '/c' } })).project).toMatchObject({ machines: ['', 'b'], clones: { b: '~/co' } })
    expect((await updateProject(store, 'CO', { name: 'Co' })).project).toMatchObject({ machines: ['', 'b'] })
    const back = (await updateProject(store, 'CO', { machines: [] })).project
    expect(back).not.toHaveProperty('machines')
    expect(back).not.toHaveProperty('clones')
  })

  it('saves the workflow as a library template; the project is untouched, a taken id refused', async () => {
    const before = (await store.workflow('CO'))!
    expect(await templateFromProject(store, 'CO', 'co-flow')).toEqual({ template: { id: 'co-flow', version: 1 } })
    expect(await store.template('co-flow')).toMatchObject({ id: 'co-flow', taskTypes: before.taskTypes, guards: before.guards })
    expect(await store.workflow('CO')).toEqual(before)
    await expect(templateFromProject(store, 'CO', 'common')).rejects.toThrow('A template already has this id')
  })

  it('previews a start over: the kept guards and worktree setup are not in the diff, only what changes', () => {
    const own = { ...company, id: 'co', guards, worktree: { copy: ['.env'] } }
    const next = { ...startOverFrom(vibe, own), id: 'co' }
    expect(next.guards).toEqual(guards)
    expect(next.worktree).toEqual(own.worktree)
    const diff = templateDiff(own, next).split('\n')
    expect(diff.some(l => l.includes('"release"') || l.includes('"guards"') || l.includes('"worktree"'))).toBe(false)
    expect(diff).toContain('-   "instructions": "Base branch is develop.",')
    expect(diff.every(l => /^[-+] /.test(l))).toBe(true)
    expect(diff.some(l => l.includes('"prefs"'))).toBe(false) // same prefs, another key order
  })
})

describe('a member project\'s sheet', () => {
  it('shows the workspace\'s workflow it runs, until it has its own', async () => {
    const ok = async (_m: string, f: string) => ({ path: f, git: !f.endsWith('work') })
    await store.addProject({ key: 'WS', name: 'Work', machine: '', path: '~/work', kind: 'workspace' }, ok)
    await store.addProject({ key: 'PAY', machine: '', path: '~/work/payroll-api', workspace: 'WS' }, ok)
    expect(await projectView(store, 'PAY')).toMatchObject({ workflow: null })
    await store.saveWorkflow('WS', { ...company, id: 'ws' })
    const v = await projectView(store, 'PAY')
    expect(v).toMatchObject({ inherited: 'WS', workflow: { id: 'pay', guards: company.guards } })
    expect(v.workflow).not.toHaveProperty('workspaceGuards')
    await saveProjectGuards(store, 'PAY', guards, 'user')
    expect(await projectView(store, 'PAY')).not.toHaveProperty('inherited')
  })
})
