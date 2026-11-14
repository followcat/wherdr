import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOES_MAX, LIST_TTL, parseRepoList, renderMap, setEntry } from '../shared/pm/workspaceMap'
import { parseCommand } from '../shared/pm/coordinator'
import { createPmStore } from '../server/utils/pmStore'
import { runMap } from '../server/utils/pmMap'
import { REPO_LIST_SCRIPT } from '../server/utils/pmRepos'
import type { Project } from '../shared/pm/project'

describe('map commands', () => {
  it('parses set, show, list and remove', () => {
    expect(parseCommand(['map', 'set', 'payroll-api', '--does', '  Pays\n people  ', '--talks', 'bank-gw, ledger', '--used-by', 'web-app'])).toEqual({ name: 'map set', repo: 'payroll-api', does: 'Pays people', talks: ['bank-gw', 'ledger'], usedBy: ['web-app'] })
    expect(parseCommand(['map', 'list', '--refresh', '--project', 'WS'])).toEqual({ name: 'map list', refresh: true, project: 'WS' })
    expect(parseCommand(['map', 'show'])).toEqual({ name: 'map show' })
    expect(parseCommand(['map', 'remove', 'apps/web-app'])).toEqual({ name: 'map remove', repo: 'apps/web-app' })
    expect(parseCommand(['map', 'set', 'clients/café app', '--does', 'Orders'])).toMatchObject({ repo: 'clients/café app' })
  })

  it('refuses what is past its limits', () => {
    const err = (argv: string[]) => (parseCommand(argv) as { error?: string }).error
    expect(err(['map', 'set', 'a', '--does', 'x'.repeat(DOES_MAX + 1)])).toMatch(/160 characters/)
    expect(err(['map', 'set', 'a'])).toMatch(/usage: wherdr pm map set/)
    expect(err(['map', 'set', '../etc', '--does', 'x'])).toMatch(/usage/)
    expect(err(['map', 'set', 'a', '--talks', 'b,../c', '--does', 'x'])).toMatch(/--talks is a list/)
    expect(err(['map', 'set', 'a', '--does', 'x', '--color', 'red'])).toBe('unknown option --color')
    expect(err(['map', 'show', 'extra'])).toMatch(/usage: wherdr pm map show/)
  })
})

describe('the map file', () => {
  it('a new line needs --does; a later set keeps what it leaves out; map.md renders it', () => {
    expect(setEntry({ entries: [] }, { name: 'map set', repo: 'ledger', talks: ['a'] }, '~/work', undefined, 0)).toEqual({ error: expect.stringMatching(/--does/) })
    const one = setEntry({ entries: [] }, { name: 'map set', repo: 'payroll-api', does: 'Pays people', talks: ['bank-gw'] }, '~/work/', 'PA', Date.UTC(2026, 0, 2)) as Exclude<ReturnType<typeof setEntry>, { error: string }>
    const two = setEntry(one, { name: 'map set', repo: 'payroll-api', usedBy: ['web-app'] }, '~/work', 'PA', Date.UTC(2026, 0, 3)) as typeof one
    expect(two.entries).toEqual([{ repo: 'payroll-api', path: '~/work/payroll-api', does: 'Pays people', talks: ['bank-gw'], usedBy: ['web-app'], project: 'PA', readAt: Date.UTC(2026, 0, 3) }])
    expect(renderMap({ key: 'WS', name: 'Work', path: '~/work' }, two)).toContain('## payroll-api (project PA)\n\nPays people\n\n- talks to: bank-gw\n- used by: web-app\n- path: ~/work/payroll-api\n- read: 2026-01-03\n')
    expect(renderMap({ key: 'WS', name: 'Work', path: '~/work' }, { entries: [] })).toContain('No repository mapped yet.')
  })
})

describe('map list', () => {
  it('reads names and descriptions: manifest first, else the README\'s first sentence', () => {
    const out = ['', 'payroll-api\n\x1fpackage.json\n{"name":"p","description":"Payroll \\"API\\" for payslips"}\n\x1fREADME.md\n# Payroll\n\nIgnored.',
      'apps/web-app\n\x1fREADME.md\n# Web app\n\n[![ci](x)](y)\n\nThe [customer](http://a) web app. It calls payroll-api.',
      'tools/cli\n\x1fCargo.toml\n[package]\nname = "cli"\ndescription = "A command line"\n', 'empty\n', '.\n',
      'payroll api\n\x1fpyproject.toml\n[project]\nname = \'payroll\'\ndescription = \'Pays "people"\'\n\x1fREADME.md\nNot this.', 'café\n'].join('\x1e')
    expect(parseRepoList(out, '/src/work/')).toEqual([
      { repo: 'apps/web-app', path: '/src/work/apps/web-app', does: 'The customer web app.' },
      { repo: 'café', path: '/src/work/café', does: '' },
      { repo: 'empty', path: '/src/work/empty', does: '' },
      { repo: 'payroll api', path: '/src/work/payroll api', does: 'Pays "people"' },
      { repo: 'payroll-api', path: '/src/work/payroll-api', does: 'Payroll "API" for payslips' },
      { repo: 'tools/cli', path: '/src/work/tools/cli', does: 'A command line' },
    ])
  })

  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-map-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('caches the list a day, marks mapped repositories and writes map.md after a set', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const ws = { key: 'WS', name: 'Work', machine: 'home', path: '/src/work', kind: 'workspace', git: false, addedAt: 1 } as Project
    const pa = { key: 'PA', name: 'Payroll', machine: 'home', path: '/src/work/payroll-api', workspace: 'WS', addedAt: 1 } as Project
    const lists: string[] = [], written: string[] = []
    const call = async (_m: string, p: { argv: string[], input?: string }) => {
      const [, , script, , ...args] = p.argv
      if (script === REPO_LIST_SCRIPT) return lists.push(args[0]!), { code: 0, stdout: Buffer.from('\x1epayroll-api\n\x1fpackage.json\n{"description":"Pays"}').toString('base64') }
      if (script!.includes('$HOME')) return { code: 0, stdout: Buffer.from('/h').toString('base64') }
      written.push(`${args[0]}\n${Buffer.from(p.input!, 'base64').toString()}`)
      return { code: 0, stdout: '' }
    }
    const deps = { store, call, machines: () => [{ key: 'home', label: 'home', local: true }] } as unknown as Parameters<typeof runMap>[0]
    const t0 = Date.UTC(2026, 0, 1)
    const first = await runMap(deps, ws, [ws, pa], { name: 'map list' }, t0)
    expect(first).toMatchObject({ root: '/src/work', repos: [{ repo: 'payroll-api', does: 'Pays', mapped: false }] })
    await runMap(deps, ws, [ws, pa], { name: 'map set', repo: 'payroll-api', does: 'Pays people' }, t0)
    expect(written[0]).toMatch(/^\/h\/\.wherdr\/pm\/coordinators\/WS\/map\.md\n# Map of workspace Work/)
    expect(await runMap(deps, ws, [ws, pa], { name: 'map list' }, t0 + LIST_TTL - 1)).toMatchObject({ repos: [{ mapped: true }] })
    expect(lists).toEqual(['/src/work'])
    await runMap(deps, ws, [ws, pa], { name: 'map list', refresh: true }, t0 + 1)
    await runMap(deps, ws, [ws, pa], { name: 'map list' }, t0 + LIST_TTL + 2)
    expect(lists).toHaveLength(3)
    expect((await store.map('WS')).entries[0]).toMatchObject({ project: 'PA' })
    await expect(runMap(deps, pa, [ws, pa], { name: 'map show' })).rejects.toThrow(/workspace/)
  })
})
