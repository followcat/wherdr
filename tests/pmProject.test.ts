// Project settings on the server (server/utils/pmProject.ts): who may change
// the guards, a workflow save that may not touch them, and applying a template.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { ALFRED_TOKEN_FILE, issueAlfredToken, issueToken } from '../server/utils/pmCoordinator'
import { guardsAuthor, saveProjectGuards, saveProjectWorkflow, templateFromProject, updateProject } from '../server/utils/pmProject'
import { common, company, vibe } from '../shared/pm/examples'
import { templateDiff } from '../shared/pm/coordinator'
import { startOverFrom } from '../shared/pm/workflow'

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
    expect((await updateProject(store, 'CO', { base: '' })).project).not.toHaveProperty('base')
    await expect(updateProject(store, 'CO', { base: 'a..b' })).rejects.toThrow('base: invalid branch name')
  })

  it('saves the workflow as a library template; the project is untouched, a taken id refused', async () => {
    const before = (await store.workflow('CO'))!
    expect(await templateFromProject(store, 'CO', 'co-flow')).toEqual({ template: { id: 'co-flow', version: 1 } })
    expect(await store.template('co-flow')).toMatchObject({ id: 'co-flow', taskTypes: before.taskTypes, guards: before.guards })
    expect(await store.workflow('CO')).toEqual(before)
    await expect(templateFromProject(store, 'CO', 'common')).rejects.toThrow('A template already has this id')
  })

  it('previews a start over: the kept guards are not in the diff, only what changes', () => {
    const own = { ...company, id: 'co', guards }
    const next = { ...startOverFrom(vibe, own), id: 'co' }
    expect(next.guards).toEqual(guards)
    const diff = templateDiff(own, next).split('\n')
    expect(diff.some(l => l.includes('"release"') || l.includes('"guards"'))).toBe(false)
    expect(diff).toContain('-   "instructions": "Base branch is develop.",')
    expect(diff.every(l => /^[-+] /.test(l))).toBe(true)
    expect(diff.some(l => l.includes('"prefs"'))).toBe(false) // same prefs, another key order
  })
})
