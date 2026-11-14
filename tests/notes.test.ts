// WHR-295: the notes whiteboard: its store (add, edit, remove, scope, links
// inside the notes folder, no path out of it) and a coordinator's default scope.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { machineScope, noteLinks, noteTabs, notesShown, parseNotes, resolveScope, projectScopes, NOTES_FOLLOW, type Note } from '../shared/notes'
import { parseAlfredCommand } from '../shared/pm/alfredCli'
import { parseCommand } from '../shared/pm/coordinator'
import { notesStore, runNotes } from '../server/utils/notesStore'

const groups = [{ id: '*group:work', name: 'Work', machines: ['mac'] }, { id: '*group:home', name: 'Home', machines: ['', 'pi'] }]
const project = { key: 'WD', machine: '', machines: ['pi'] }
const tabs = noteTabs(['*', ...groups.map(g => g.id)], groups, k => k)
let dir: string, settingsFile: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-'))
  settingsFile = path.join(dir, 'settings.json')
  await fs.writeFile(settingsFile, JSON.stringify({ v: 1, settings: { machineGroups: JSON.stringify(groups) } }))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const run = (argv: string[], input?: string, who: Parameters<typeof runNotes>[3] = { by: 'Alfred' }) => {
  const cmd = parseAlfredCommand(['notes', ...argv])
  if ('error' in cmd || cmd.name !== 'notes') throw new Error('error' in cmd ? cmd.error : cmd.name)
  return runNotes(notesStore(path.join(dir, 'notes')), cmd.notes, input, who, settingsFile) as Promise<Record<string, any>>
}

describe('notes store', () => {
  it('adds, edits and removes a note, logs who did it, and keeps its file readable', async () => {
    const { added } = await run(['add', 'Look at the plan', '--scope', 'home'], '- [ ] Read the **[Plan](plans/x.md)**\n')
    expect(added).toMatchObject({ id: 'look-at-the-plan', scope: 'Home', body: '- [ ] Read the **[Plan](plans/x.md)**' })
    expect((await run(['add', 'Look at the plan'], 'again')).added.id).toBe('look-at-the-plan-2')
    await run(['file', 'put', 'plans/x.md'], '# Plan\n')
    expect((await run(['edit', 'look-at-the-plan', '--title', 'Plan for X', '--scope', 'all'], '')).edited).toMatchObject({ title: 'Plan for X', scope: 'all', body: added.body })
    expect(await run(['list'])).toMatchObject({ notes: [{ id: 'look-at-the-plan', title: 'Plan for X' }, { id: 'look-at-the-plan-2' }], files: ['plans/x.md'] })
    expect((await run(['show', 'plans/x.md'])).text).toBe('# Plan\n')
    await run(['remove', 'look-at-the-plan'])
    expect((await run(['list'])).notes.map((n: { id: string }) => n.id)).toEqual(['look-at-the-plan-2'])
    const log = (await fs.readFile(path.join(dir, 'notes/.log.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(log.map(l => `${l.by} ${l.action} ${l.what}`)).toEqual(['Alfred add look-at-the-plan', 'Alfred add look-at-the-plan-2', 'Alfred file put plans/x.md', 'Alfred edit look-at-the-plan', 'Alfred remove look-at-the-plan'])
  })

  it('keeps notes short and says which links lead nowhere yet', async () => {
    await expect(run(['add', 'Long'], Array(13).fill('- line').join('\n'))).rejects.toThrow(/linked file/)
    expect(await run(['add', 'Links'], '[a](other.md) [b](plans/y.md) [c](#/board?task=WD-1) [d](https://example.com)')).toMatchObject({ missing: ['other.md', 'plans/y.md'] })
  })

  it('never reaches outside the notes folder', async () => {
    for (const p of ['../x.md', 'plans/../../x.md', '/etc/x.md', 'x.md', 'plans/.log.md', 'plans/x.txt']) expect(parseNotes(['file', 'put', p], {})).toHaveProperty('error')
    expect(noteLinks('[x](../secret.md)')).toHaveProperty('error')
    expect(noteLinks('[x](plans/../../secret.md)')).toHaveProperty('error')
    await expect(run(['add', 'Bad'], '[x](../../settings.json)')).rejects.toThrow(/never \.\./)
    await expect(run(['show', '../settings.json'])).rejects.toThrow(/No file/)
  })
})

describe('notes scope rules', () => {
  it('lets a coordinator list, edit, move and remove any note, adding to its project\'s tab by default', async () => {
    expect(projectScopes(project, undefined, groups, tabs)).toEqual(['*group:home'])
    expect(projectScopes(project, '*', groups, tabs)).toEqual(['all', '*group:work', '*group:home'])
    expect(projectScopes(project, '*group:work', groups, tabs)).toEqual(['*group:work'])
    expect(projectScopes(project, undefined, [], [])).toEqual(['all'])
    const wd = { by: 'coordinator WD', project }
    expect((await run(['add', 'Mine'], 'x', wd)).added.scope).toBe('Home')
    await run(['add', 'Alfred\'s', '--scope', 'work'], 'x')
    expect((await run(['list'], undefined, wd)).notes.map((n: { id: string }) => n.id).sort()).toEqual(['alfred-s', 'mine'])
    expect((await run(['edit', 'alfred-s', '--title', 'Moved', '--scope', 'all'], 'y', wd)).edited).toMatchObject({ title: 'Moved', scope: 'all', body: 'y' })
    expect((await run(['add', 'Theirs', '--scope', 'Work'], 'x', wd)).added.scope).toBe('Work')
    expect(await run(['remove', 'alfred-s'], undefined, wd)).toEqual({ removed: 'alfred-s' })
    const log = (await fs.readFile(path.join(dir, 'notes/.log.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(log.map(l => `${l.by} ${l.action} ${l.what}`)).toEqual(['coordinator WD add mine', 'Alfred add alfred-s', 'coordinator WD edit alfred-s', 'coordinator WD add theirs', 'coordinator WD remove alfred-s'])
  })

  it('takes a machine shown as its own tab as a scope, and shows its notes on that tab and on its group', async () => {
    const all = noteTabs(['*', '*group:work', 'laptop'], groups, k => (k === 'laptop' ? 'Laptop' : k))
    expect(all.map(t => t.name)).toEqual(['Work', 'Laptop'])
    expect(resolveScope('laptop', all)).toBe(machineScope('laptop'))
    expect(resolveScope('Nope', all)).toEqual({ error: 'Unknown scope Nope: all, or a home tab (Work, Laptop)' })
    expect(projectScopes({ machine: 'laptop' }, undefined, groups, all)).toEqual([machineScope('laptop')])
    const n = (id: string, scope: string): Note => ({ id, title: id, scope, body: '', created: '', updated: '' })
    const list = [n('every', 'all'), n('lap', machineScope('laptop')), n('work', '*group:work'), n('home', '*group:home')]
    const ids = (filter: string, followed: string | null, g = groups) => notesShown(list, filter, followed, g).map(x => x.id)
    expect(ids(NOTES_FOLLOW, machineScope('laptop'))).toEqual(['every', 'lap'])
    expect(ids(machineScope('laptop'), null)).toEqual(['every', 'lap'])
    expect(ids(NOTES_FOLLOW, '*group:work')).toEqual(['every', 'work'])
    // the laptop joins the Work group: its note shows there too
    expect(ids(NOTES_FOLLOW, '*group:work', [{ ...groups[0]!, machines: ['mac', 'laptop'] }, groups[1]!])).toEqual(['every', 'lap', 'work'])
    expect(ids(NOTES_FOLLOW, null)).toEqual(['every', 'lap', 'work', 'home'])
    await fs.writeFile(settingsFile, JSON.stringify({ v: 1, settings: { machineGroups: JSON.stringify(groups), machineBarHidden: JSON.stringify(['pi', 'mac', '']) } }))
    const cmd = parseAlfredCommand(['notes', 'add', 'Charge it', '--scope', 'Laptop'])
    if ('error' in cmd || cmd.name !== 'notes') throw new Error('not a notes command')
    const machines = ['', 'mac', 'pi', 'laptop'].map(key => ({ key, label: key === 'laptop' ? 'Laptop' : key, local: !key, status: 'online' as const, error: null }))
    expect(await runNotes(notesStore(path.join(dir, 'notes')), cmd.notes, 'x', { by: 'Alfred' }, settingsFile, machines)).toMatchObject({ added: { scope: 'Laptop' } })
    // the laptop joins Work and its tab is taken off the bar: its note stays readable and writable
    await fs.writeFile(settingsFile, JSON.stringify({ v: 1, settings: { machineGroups: JSON.stringify([{ ...groups[0]!, machines: ['mac', 'laptop'] }, groups[1]!]), machineBarHidden: JSON.stringify(['laptop']) } }))
    const again = async (argv: string[], who: Parameters<typeof runNotes>[3]) => {
      const c = parseAlfredCommand(['notes', ...argv])
      if ('error' in c || c.name !== 'notes') throw new Error('not a notes command')
      return runNotes(notesStore(path.join(dir, 'notes')), c.notes, '', who, settingsFile, machines) as Promise<Record<string, any>>
    }
    expect((await again(['list'], { by: 'Alfred' })).notes).toMatchObject([{ id: 'charge-it', scope: 'Laptop' }])
    expect((await again(['list'], { by: 'coordinator L', project: { key: 'L', machine: 'mac' } })).notes.map((x: { id: string }) => x.id)).toEqual(['charge-it'])
    expect(await again(['remove', 'charge-it'], { by: 'Alfred' })).toEqual({ removed: 'charge-it' })
  })

  it('parses the same notes words under wherdr pm', () => {
    expect(parseCommand(['notes', 'edit', 'a-note', '--title', 'New'])).toEqual({ name: 'notes', notes: { verb: 'edit', id: 'a-note', title: 'New' } })
    expect(parseCommand(['notes', 'remove', 'a', '--scope', 'all'])).toHaveProperty('error')
  })
})

describe('notes under load and linked files', () => {
  it('keeps both notes when two agents add the same title at once', async () => {
    const store = notesStore(path.join(dir, 'notes'))
    const r = await Promise.allSettled([1, 2, 3].map(i => store.add({ title: 'Same', scope: 'all', body: `body ${i}` }, 'Alfred')))
    expect(r.map(x => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect((await store.list()).map(n => n.body).sort()).toEqual(['body 1', 'body 2', 'body 3'])
  })

  it('lets a coordinator change a linked file another project\'s note links to', async () => {
    const wd = { by: 'coordinator WD', project }
    await run(['add', 'Work plan', '--scope', 'work'], '[Plan](plans/work.md)')
    await run(['file', 'put', 'plans/work.md'], '# Work\n')
    await run(['file', 'put', 'plans/work.md'], '# New\n', wd)
    expect((await run(['show', 'plans/work.md'])).text).toBe('# New\n')
    expect(await run(['file', 'remove', 'plans/work.md'], undefined, wd)).toEqual({ removed: 'plans/work.md' })
  })
})
