import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { renamed, shownTaskId, storedTaskId } from '../shared/pm/projectKey'

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-key-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const okFolder = async (_m: string, p: string) => p
const project = (key: string) => ({ key, name: `${key} app`, machine: '', path: `/src/${key}` })

describe('project keys', () => {
  it('maps a task id between its stored and its shown form', () => {
    const projects = [{ key: 'WHR', label: 'WD', aliases: ['OLD'] }, { key: 'PDS' }]
    expect(shownTaskId(projects, 'WHR-52')).toBe('WD-52')
    expect(shownTaskId(projects, 'PDS-3')).toBe('PDS-3')
    expect(['WD-52', 'wd-52', 'WHR-52', 'old-52'].map(id => storedTaskId(projects, id))).toEqual(['WHR-52', 'WHR-52', 'WHR-52', 'WHR-52'])
    expect(storedTaskId(projects, 'XX-1')).toBeNull()
    // Renamed twice (WHR → WD → WX): the middle key and any case still resolve.
    const twice = [{ key: 'WHR', ...renamed({ key: 'WHR', label: 'WD' }, 'WX') }]
    expect(['wd-5', 'whr-5', 'WX-5'].map(id => storedTaskId(twice, id))).toEqual(['WHR-5', 'WHR-5', 'WHR-5'])
    // Back to its first key: no label, the key it had stays an alias.
    expect(renamed({ key: 'WHR', label: 'WD' }, 'whr')).toEqual({ aliases: ['WD'] })
  })

  it('renames a project: old tasks read the new key, old ids resolve, a key names one project only', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.addProject(project('WEB'), okFolder)
    await store.addProject(project('API'), okFolder)
    const old = await store.addTask({ project: 'WEB', title: 'First', type: 'simple' })

    await store.updateProject('WEB', { key: 'WD' })
    expect((await store.project('wd'))).toMatchObject({ key: 'WEB', label: 'WD' })
    for (const id of ['WD-1', 'wd-1', 'WEB-1']) expect((await store.task(id))?.id).toBe(old.id)
    // New tasks keep the fixed id: WEB-2, shown WD-2; `after` takes the shown form.
    const next = await store.addTask({ project: 'wd', title: 'Second', type: 'simple', after: 'WD-1' })
    expect(next).toMatchObject({ id: 'WEB-2', project: 'WEB', after: 'WEB-1' })
    expect(shownTaskId(await store.projects(), next.id)).toBe('WD-2')

    // Unique across projects, any case, former keys and ids included.
    for (const key of ['wd', 'WEB']) await expect(store.updateProject('API', { key })).rejects.toThrow('Project WEB app already has the key')
    await expect(store.addProject(project('web'), okFolder)).rejects.toMatchObject({ code: 'exists' })
    // A project takes its own former key back.
    await store.updateProject('WD', { key: 'WEB' })
    expect(await store.project('WEB')).toMatchObject({ key: 'WEB', aliases: ['WD'] })
    expect((await store.project('WEB'))!.label).toBeUndefined()
  })

  it('gives existing projects a color once, keeping everything else', async () => {
    const before = [{ ...project('WHR'), addedAt: 1 }, { ...project('PDS'), addedAt: 2, color: 'violet' }]
    await fs.writeFile(path.join(dir, 'pm.json'), JSON.stringify({ v: 1, enabled: true, workflows: 1 }))
    await fs.writeFile(path.join(dir, 'projects.json'), JSON.stringify({ v: 1, projects: before }))
    const after = await createPmStore(dir).projects()
    expect(after).toEqual([{ ...before[0], color: 'blue' }, before[1]])
    const saved = await fs.readFile(path.join(dir, 'projects.json'), 'utf8')
    expect(await createPmStore(dir).projects()).toEqual(after)
    expect(await fs.readFile(path.join(dir, 'projects.json'), 'utf8')).toBe(saved)
    // A new project gets the next free color.
    expect((await createPmStore(dir).addProject(project('NEW'), okFolder)).color).toBe('teal')
  })
})
