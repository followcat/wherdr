import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { REAL_ALL_SCRIPT, REAL_SCRIPT, adoptRefusal, adoptedSince, foldersOn, realLines, realRepo, repoUnder } from '../shared/pm/workspaceAdopt'
import { parseCommand } from '../shared/pm/coordinator'
import { healthSummary } from '../shared/pm/health'
import { placeTask, type Candidate } from '../shared/pm/placement'
import { readyOf, readyRefusal } from '../shared/pm/ready'
import { createPmStore } from '../server/utils/pmStore'
import { adoptRepo } from '../server/utils/pmAdopt'
import { PREPARE_SCRIPT, PROBE_SCRIPT } from '../server/utils/pmFolder'
import { REMOTE_SCRIPT } from '../server/utils/pmVisibility'
import type { Project } from '../shared/pm/project'

const ws = { key: 'WS', name: 'Work', machine: 'home', path: '/h/work', kind: 'workspace', git: false, addedAt: 1 } as Project

describe('repo adopt: what it refuses', () => {
  it('parses one repository, and refuses a path outside the root', () => {
    expect(parseCommand(['repo', 'adopt', 'payroll-api', '--project', 'WS'])).toEqual({ name: 'repo adopt', repo: 'payroll-api', project: 'WS' })
    expect(parseCommand(['repo', 'adopt'])).toEqual({ error: expect.stringMatching(/usage: wherdr pm repo adopt/) })
    expect(repoUnder('apps/web-app/', '/h/work')).toBe('apps/web-app')
    expect(repoUnder('~/work/payroll-api', '/h/work/', '/h')).toBe('payroll-api')
    for (const out of ['/h/other/api', '../api', '/h/work', '~/api']) expect(repoUnder(out, '/h/work', '/h')).toEqual({ error: expect.stringMatching(/outside the workspace's root/) })
  })

  it('refuses a folder already a project (of any workspace), without git, or without the origin its workflow needs', () => {
    const other = { key: 'PA', name: 'Payroll', machine: 'home', path: '/h/work/payroll-api', workspace: 'WS2', addedAt: 1 } as Project
    const repo = { exists: true, git: true, remote: true }
    const own = (ps: Project[]) => foldersOn(ps, 'home', '/h').map(o => ({ project: o.project, folders: [o.folder] }))
    expect(adoptRefusal(['/h/work/payroll-api'], own([other]), repo, true)).toMatch(/already project PA \(workspace WS2\)/)
    expect(adoptRefusal(['/h/work/ledger'], own([other]), { ...repo, git: false }, true)).toMatch(/not a git repository/)
    expect(adoptRefusal(['/h/work/ledger'], own([other]), { ...repo, exists: false }, true)).toMatch(/does not exist/)
    expect(adoptRefusal(['/h/work/ledger'], own([other]), { ...repo, remote: false }, true)).toMatch(/no origin/)
    expect(adoptRefusal(['/h/work/ledger'], own([other]), { ...repo, remote: false }, false)).toBe('')
    // Another project's clone on this machine (~ expanded), its home elsewhere.
    const cloned = { key: 'LED', name: 'Ledger', machine: 'box', path: '/srv/ledger', machines: ['box', 'home'], clones: { home: '~/work/ledger/' }, addedAt: 1 } as Project
    expect(adoptRefusal(['/h/work/ledger'], own([cloned]), repo, true)).toMatch(/already project LED/)
    // Named through a link, resolved to a project's folder.
    expect(adoptRefusal(['/h/work/alias', '/h/work/payroll-api'], own([other]), repo, true)).toMatch(/already project PA/)
  })

  it('resolves symlinks on the machine: a link out of the root is refused, one inside is named by its target', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pm-real-')))
    await fs.mkdir(path.join(tmp, 'work/api'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'outside'))
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'work/linked'))
    await fs.symlink(path.join(tmp, 'work/api'), path.join(tmp, 'work/alias'))
    const real = (rel: string) => {
      const [root = '', folder = ''] = execFileSync('sh', ['-c', REAL_SCRIPT, 'sh', `${tmp}/work`, `${tmp}/work/${rel}`]).toString().trim().split('\n')
      return realRepo(rel, root, folder)
    }
    expect(real('linked')).toEqual({ error: expect.stringMatching(/leads outside the workspace's root/) })
    expect(real('alias')).toBe('api')
    expect(real('missing')).toBe('missing')
    // Other projects' folders, resolved in one call: a missing one keeps its place.
    const all = execFileSync('sh', ['-c', REAL_ALL_SCRIPT, 'sh', `${tmp}/nope`, `${tmp}/work/alias`]).toString().trim()
    expect(realLines(all, 2)).toEqual(['', `${tmp}/work/api`])
    await fs.rm(tmp, { recursive: true, force: true })
  })
})

describe('repo adopt: the new member', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-adopt-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('inherits every shared field, fills its map line, is logged and listed in the next health check', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const shared = { machines: ['box'], clones: { box: '/srv/work' }, placement: 'balance', base: 'develop', branchName: 'feat/{id}', archiveAfter: 3, deleteBranch: false, prefs: { agent: 'codex' }, worktree: { command: 'npm ci' } }
    await fs.writeFile(path.join(dir, 'projects.json'), JSON.stringify({ v: 1, projects: [{ ...ws, color: 'blue', shared }] }))
    await store.changeMap('WS', () => ({ entries: [{ repo: 'payroll-api', path: '/h/work/payroll-api', does: 'Pays', talks: [], usedBy: [], readAt: 1 }] }))
    const call = async (_m: string, p: { argv: string[] }) => {
      const [, , script] = p.argv
      const out = script === REAL_ALL_SCRIPT ? (p.argv.slice(4).map(a => `x${a}`).join('\n')) : script === REAL_SCRIPT ? '/h/work\n/h/work/payroll-api' : script === PROBE_SCRIPT ? 'dir\ngit\nremote' : script === PREPARE_SCRIPT ? 'git' : script!.includes(REMOTE_SCRIPT.split('\n').at(-2)!) ? 'git@github.com:acme/payroll-api.git\n{"visibility":"PRIVATE"}' : script!.includes('$HOME') ? '/h' : ''
      return { code: 0, stdout: Buffer.from(out).toString('base64') }
    }
    const deps = { store, call, machines: () => [{ key: 'home', label: 'home', local: true }] } as unknown as Parameters<typeof adoptRepo>[0]
    const r = await adoptRepo(deps, ws, await store.projects(), { name: 'repo adopt', repo: 'payroll-api' }, 'WS coordinator')
    expect(r.adopted).toMatchObject({ key: 'PA', name: 'payroll-api', repo: 'payroll-api', visibility: 'private', color: expect.any(String) })
    expect(r.adopted.color).not.toBe('blue')
    const member = (await store.project('PA'))!
    expect(member).toMatchObject({ workspace: 'WS', machines: ['home', 'box'], clones: { box: '/srv/work/payroll-api' }, placement: 'balance', base: 'develop', branchName: 'feat/{id}', archiveAfter: 3, deleteBranch: false })
    expect(await store.workflow('PA')).toMatchObject({ prefs: shared.prefs, worktree: shared.worktree })
    expect((await store.map('WS')).entries[0]).toMatchObject({ project: 'PA' })
    const log = await store.projectLog('WS')
    expect(log.at(-1)).toMatchObject({ by: 'WS coordinator', text: 'adopted payroll-api as project PA' })
    expect(healthSummary([], {}, Date.now(), [], adoptedSince(log, 0))[0]).toBe('Repositories adopted since the last check: PA (payroll-api).')
    expect(adoptedSince(log, Date.now() + 1)).toEqual([])
    // Again: already a project.
    await expect(adoptRepo(deps, ws, await store.projects(), { name: 'repo adopt', repo: '/h/work/payroll-api' }, 'WS coordinator')).rejects.toThrow(/already project PA/)
  })

  it('leaves out of placement a machine without the clone under its root', () => {
    const ready = readyOf('clone fail no git repository in /srv/work/payroll-api', 'git@github.com:acme/payroll-api.git')
    const why = readyRefusal(ready)
    expect(why).toMatch(/^clone: no git repository/)
    const at = (key: string, more: Partial<Candidate> = {}): Candidate => ({ key, label: key, online: true, settings: {}, running: [], capacity: { cores: 16, total: 65536, available: 60000, swapTotal: 0, swapFree: 0, load1: 0 }, ...more })
    // The machine without the clone is the stronger one: the task still goes home.
    expect(placeTask({ weight: 'heavy', home: 'home', candidates: [at('home', { capacity: { cores: 4, total: 16384, available: 12000, swapTotal: 0, swapFree: 0, load1: 0 } }), at('box', { wait: `not ready (${why})` })] })).toEqual({ machine: 'home' })
  })
})
