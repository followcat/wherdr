// New sheet › Project › Add: the name and key proposed from a folder, the git
// repositories found under a home folder, and the folder checks, each script
// run for real on a fake home folder in a temp dir.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { draftBody, folderKind, needsRemote, proposeKey, proposeName, shortHome, type ProjectDraft } from '../shared/pm/newProject'
import { findRepos, parseRepos } from '../server/utils/pmRepos'
import { pmFolderCheck, probeFolder } from '../server/utils/pmFolder'
import { createPmStore } from '../server/utils/pmStore'
import { coordinatorArgs, roleFiles } from '../shared/pm/coordinator'
import { EXAMPLES } from '../shared/pm/examples'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

describe('name and key proposal', () => {
  it('names a project after its folder', () => {
    expect(proposeName('/home/user/src/my-web/')).toBe('my-web')
    expect(proposeName('~/notes')).toBe('notes')
    expect(proposeName('')).toBe('')
  })

  it('shows a folder under the home as ~/…, any other as it is', () => {
    expect(shortHome('/home/user/projects/demo-app', '/home/user')).toBe('~/projects/demo-app')
    expect(shortHome('/home/user', '/home/user/')).toBe('~')
    expect(shortHome('/home/username/app', '/home/user')).toBe('/home/username/app')
    expect(shortHome('/srv/app', '')).toBe('/srv/app')
  })
  it('proposes initials, or a word\'s consonants, free among the taken keys', () => {
    expect(proposeKey('my-web-app')).toBe('MWA')
    expect(proposeKey('myWebApp')).toBe('MWA')
    expect(proposeKey('wherdr')).toBe('WHR')
    expect(proposeKey('api')).toBe('API')
    expect(proposeKey('2024-reports')).toBe('RPR') // a key starts with a letter
    expect(proposeKey('___')).toBe('PRJ')
    expect(proposeKey('wherdr', ['WHR', 'WHR2'])).toBe('WHR3')
  })
})

describe('folder kinds', () => {
  const probe = { path: '/home/user/x', exists: true, git: false, empty: false }
  it('tells a git, new, empty or plain folder, and offers git init only on new or empty ones', () => {
    expect(folderKind({ ...probe, git: true })).toBe('git')
    expect(folderKind({ ...probe, exists: false })).toBe('new')
    expect(folderKind({ ...probe, empty: true })).toBe('empty')
    expect(folderKind(probe)).toBe('plain')
    const d: ProjectDraft = { machine: '', path: '~/x', name: ' X ', key: 'x', gitInit: true, probe }
    expect(draftBody(d)).toEqual({ key: 'x', name: 'X', machine: '', path: '/home/user/x', plain: true, create: false, gitInit: false })
    expect(draftBody({ ...d, probe: { ...probe, exists: false } })).toMatchObject({ create: true, gitInit: true })
    expect(draftBody({ ...d, gitInit: false, probe: { ...probe, empty: true } })).toMatchObject({ gitInit: false })
  })

  it('tells the examples that need a remote from those that land locally', () => {
    expect(EXAMPLES.filter(needsRemote).map(e => e.id)).toEqual(['company', 'github', 'wherdr'])
  })
})

// A machine whose commands run here, with HOME set to the fake home folder.
let home = ''
const deps = {
  call: async (_method: string, p: { argv: string[] }) => {
    const r = spawnSync(p.argv[0]!, p.argv.slice(1), { env: { ...process.env, HOME: home }, encoding: 'buffer' })
    return { code: r.status, stdout: r.stdout.toString('base64'), stderr: r.stderr.toString('base64') }
  },
  machines: () => [{ key: '', label: 'host-a', local: true, status: 'online' }],
} as unknown as CoreAdminDeps
const mk = (...parts: string[]) => fs.mkdir(path.join(home, ...parts), { recursive: true })
beforeEach(async () => { home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pm-new-'))) })
afterEach(() => fs.rm(home, { recursive: true, force: true }))

describe('repository discovery', () => {
  it('finds repositories a few levels down, skipping hidden folders and node_modules', async () => {
    await Promise.all([
      mk('web', '.git'), mk('src', 'api', '.git'), mk('src', 'clients', 'shop', '.git'),
      mk('a', 'b', 'c', 'd', '.git'), // too deep
      mk('.herdr', 'worktrees', 'web-1', '.git'), mk('web', 'node_modules', 'dep', '.git'), mk('notes'),
    ])
    expect(await findRepos(deps, '', { refresh: true })).toEqual({
      home, repos: [path.join(home, 'src/api'), path.join(home, 'src/clients/shop'), path.join(home, 'web')],
    })
    // Cached: a new repository shows after a refresh.
    await mk('new', '.git')
    expect((await findRepos(deps, '')).repos).toHaveLength(3)
    expect((await findRepos(deps, '', { refresh: true })).repos).toContain(path.join(home, 'new'))
  })

  it('parses the script output into sorted absolute paths', () => {
    expect(parseRepos('/home/user\n./b/.git\n./a/.git\n./a/.git\n./../x/.git\n')).toEqual({ home: '/home/user', repos: ['/home/user/a', '/home/user/b'] })
  })
})

describe('folder check', () => {
  it('probes a folder: missing, empty, plain or git', async () => {
    await Promise.all([mk('empty'), mk('plain', 'one'), mk('remote')])
    spawnSync('git', ['init', '-q', path.join(home, 'repo')]); spawnSync('git', ['init', '-q', path.join(home, 'remote')])
    spawnSync('git', ['-C', path.join(home, 'remote'), 'remote', 'add', 'origin', 'https://example.com/r.git'])
    expect(await probeFolder('', '~/missing', deps)).toEqual({ path: path.join(home, 'missing'), exists: false, git: false, remote: false, empty: false })
    expect(await probeFolder('', '~/empty', deps)).toMatchObject({ exists: true, git: false, empty: true })
    expect(await probeFolder('', '~/plain', deps)).toMatchObject({ exists: true, git: false, empty: false })
    expect(await probeFolder('', '~/repo', deps)).toMatchObject({ exists: true, git: true, remote: false })
    expect(await probeFolder('', '~/remote', deps)).toMatchObject({ git: true, remote: true })
    await expect(probeFolder('', '/etc', deps)).rejects.toMatchObject({ code: 'bad_input' })
  })

  it('creates a new folder, runs git init only when asked, takes a plain folder only when allowed', async () => {
    await mk('plain', 'one')
    await expect(pmFolderCheck('', '~/plain', {}, deps)).rejects.toMatchObject({ code: 'not_git' })
    expect(await pmFolderCheck('', '~/plain', { plain: true, gitInit: true }, deps)).toEqual({ path: path.join(home, 'plain'), git: false })
    await expect(pmFolderCheck('', '~/new', { plain: true }, deps)).rejects.toMatchObject({ code: 'bad_path' })
    expect(await pmFolderCheck('', '~/new/app', { plain: true, create: true, gitInit: true }, deps)).toEqual({ path: path.join(home, 'new/app'), git: true })
    expect(await pmFolderCheck('', '~/blank', { plain: true, create: true }, deps)).toEqual({ path: path.join(home, 'blank'), git: false })
  })

  it('stores a folder without git as git: false', async () => {
    const store = createPmStore(path.join(home, 'data'))
    await store.setEnabled(true)
    await store.saveTemplate({ id: 'vibe', version: 1, taskTypes: { simple: { steps: [{ id: 'work', holder: 'worker', ends: 'report' }] } } })
    const check = async (_m: string, p: string) => ({ path: p, git: false })
    expect(await store.addProject({ key: 'ALL', machine: '', path: '/home/user/all', template: 'vibe' }, check, { plain: true }))
      .toMatchObject({ key: 'ALL', path: '/home/user/all', git: false })
  })
})

describe('coordinator of a folder without git', () => {
  const project = { key: 'ALL', name: 'Clients', machine: '', path: '/home/user/clients', addedAt: 1 }
  it('works in the folder itself, which a git repository\'s coordinator never changes', () => {
    const plain = roleFiles({ ...project, git: false }, null, [])
    expect(plain['AGENTS.md']).toContain('you do the work yourself, directly in that folder')
    expect(plain['AGENTS.md']).not.toContain('never change it')
    expect(JSON.parse(plain['.claude/settings.json']!).permissions.deny).toEqual([])
    const git = roleFiles(project, null, [])
    expect(git['AGENTS.md']).toContain('read it, never change it')
    expect(JSON.parse(git['.claude/settings.json']!).permissions.deny).toEqual(['Edit(//home/user/clients/**)'])
  })

  it('gives Codex the folder as a writable directory only then', () => {
    expect(coordinatorArgs('codex', '/c', '/home/user/clients', true)).toContain('--add-dir')
    expect(coordinatorArgs('codex', '/c', '/home/user/clients')).not.toContain('--add-dir')
    expect(coordinatorArgs('claude', '/c', '/home/user/clients', true)).toEqual(['claude', '--add-dir', '/home/user/clients'])
  })
})
