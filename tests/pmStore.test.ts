import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { cleanProjectInput } from '../shared/pm/project'

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
    expect(await store.workflow('WEB')).toBeNull()
    await expect(store.setTemplate('WEB', 'company')).rejects.toMatchObject({ code: 'not_found' })
    await store.setTemplate('WEB', 'vibe')
    await store.removeProject('WEB')
    expect((await store.overview()).projects).toEqual([])
    // Added again under the same key: none of the removed project's workflow or log.
    await store.addProject({ ...input, template: '' }, okFolder)
    expect(await store.workflow('WEB')).toBeNull()
    expect(await store.workflowLog('WEB')).toEqual([])
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
    expect(await store.workflow('API')).toBeNull()
    expect(await fs.readFile(path.join(store.files.templates, 'vibe.json'), 'utf8')).toBe(library)
    // A restart changes nothing more.
    const again = createPmStore(dir)
    expect(await again.projects()).toEqual(await store.projects())
    expect(await again.workflowLog('WEB')).toHaveLength(3)
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
