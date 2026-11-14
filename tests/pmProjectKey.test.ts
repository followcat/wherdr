import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { renamed, showIds, shownTaskId, storedTaskId } from '../shared/pm/projectKey'

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

describe('showIds', () => {
  const projects = [{ key: 'CP', label: 'CMP' }, { key: 'PDS' }]
  it('shows a renamed project\'s task ids in texts and outputs, never in paths, branches or tags', () => {
    expect(showIds(projects, 'CP-9 (Fix): stuck. After CP-12, PDS-3.')).toBe('CMP-9 (Fix): stuck. After CMP-12, PDS-3.')
    expect(showIds(projects, '~/.wherdr/pm/worktrees/CP-9 on task/CP-9, CP-9.json, pm-stall-CP-9, CP-9/x, xCP-9, CP-90a')).toBe('~/.wherdr/pm/worktrees/CP-9 on task/CP-9, CP-9.json, pm-stall-CP-9, CP-9/x, xCP-9, CP-90a')
    expect(showIds(projects, { tasks: [{ id: 'CP-1', n: 2, ok: true }], none: null })).toEqual({ tasks: [{ id: 'CMP-1', n: 2, ok: true }], none: null })
    expect(showIds([{ key: 'PDS' }], 'PDS-3')).toBe('PDS-3')
  })
})

// The engine's ways out to people and agents: each passes its text through
// showIds (or names the task with shownTaskId), so no text names a task by the
// fixed key of a renamed project.
describe('every message the engine sends goes through the shown key', () => {
  // Sends of texts that hold no task id, or not the engine's own words.
  const NO_ID = [
    /Review again: read \$\{files\.review\}/, // a path
    /text: said \}/, // the coordinator's own words, relayed
    /text: msg \}/, // the user's report, its id from shownTaskId (pmReport.ts)
  ]
  it('terminal sends, PR titles and pushes', async () => {
    const dir = path.resolve('server/utils')
    const files = (await fs.readdir(dir)).filter(f => /^pm.*\.ts$/.test(f))
    const bad: string[] = []
    for (const f of files) {
      for (const [i, line] of (await fs.readFile(path.join(dir, f), 'utf8')).split('\n').entries()) {
        const sends = line.includes('\'terminal.send\'') || line.includes('SCRIPT.pr,') || /pushSend\(\{ title: `\$\{/.test(line)
        if (sends && !/showIds|shownTaskId|\$\{shown|job\.shown/.test(line) && !NO_ID.some(r => r.test(line))) bad.push(`${f}:${i + 1}`)
      }
    }
    expect(bad).toEqual([])
  })
})
