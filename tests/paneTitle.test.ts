import { describe, expect, it } from 'vitest'
import type { Pane } from '../shared/types'
import { cleanTitle, maskCreds, meaningfulTitle, paneOwnTitle, paneTitle } from '../shared/paneTitle'

const pane = (overrides: Partial<Pane> = {}): Pane => ({
  id: 'w1:p1', workspace: 'w1', tab: 't1', tabLabel: null,
  agent: 'codex', name: 'codex', label: null, status: 'working',
  title: 'Read brief and act', cwd: '/tmp', agentSession: null,
  ...overrides,
})

describe('displayed pane title', () => {
  it('keeps the current title of agents, whatever their folder', () => {
    expect(paneTitle(pane({ label: 'Mon agent' }), 'Workspace')).toBe('Mon agent')
    expect(paneTitle(pane({ title: 'Corriger le menu | codex' }), 'Workspace')).toBe('Corriger le menu')
    expect(paneTitle(pane({ name: 'coordinator', cwd: '/home/user/.herdr-projects/wherdr' }), 'Projet wherdr')).toBe('Read brief and act')
  })
})

describe('name of a pane in a space with several panes', () => {
  const shell = (o: Partial<Pane> = {}) => pane({ agent: null, name: null, status: null, title: 'user@host: ~/src/demo-app', cwd: '/srv/src/demo-app', ...o })

  it('prefers the chosen name, even without any other title', () => {
    expect(paneTitle(shell({ label: 'Serveur', command: 'pnpm dev' }), 'demo-app')).toBe('Serveur')
  })
  it('takes the agent name shown by Herdr, unless it is generic', () => {
    expect(paneTitle(pane({ displayAgent: 'Relecteur', title: 'Autre chose' }))).toBe('Relecteur')
    expect(paneTitle(pane({ displayAgent: 'Codex', title: 'Corriger le menu' }))).toBe('Corriger le menu')
    expect(paneTitle(pane({ agent: 'claude', name: 'claude', displayAgent: 'Claude Code', title: 'Claude Code' }))).toBe('Claude')
  })
  it('garde un titre de terminal parlant', () => {
    expect(paneTitle(shell({ title: 'htop' }))).toBe('htop')
    expect(paneTitle(shell({ title: 'vim README.md', command: 'vim README.md' }))).toBe('vim README.md')
  })
  it('ignore le prompt du shell, le nom du shell, un chemin ou le dossier', () => {
    for (const title of ['user@host: ~/src/demo-app', 'bash', '-zsh', '/usr/bin/fish', '~/src/demo-app', 'demo-app', '', null]) {
      expect(paneTitle(shell({ title, command: 'pnpm dev' }))).toBe('pnpm dev')
    }
  })
  it('falls back on the folder name, never on the space name', () => {
    expect(paneTitle(shell(), 'Mon espace')).toBe('demo-app')
    expect(paneTitle(shell({ cwd: null }))).toBe('Shell')
  })
  it('goes back to the automatic title when the name is cleared', () => {
    const named = shell({ label: 'Serveur', command: 'pnpm dev' })
    expect(paneTitle({ ...named, label: null })).toBe('pnpm dev')
  })
})

describe('a Command Code pane', () => {
  const cmd = (o: Partial<Pane> = {}) => pane({ agent: 'cmd', name: 'cmd', title: '', ...o })

  it('is labelled by its kind when its name or title only repeats the agent', () => {
    expect(paneTitle(cmd())).toBe('Command Code')
    expect(paneTitle(cmd({ displayAgent: 'Command Code' }))).toBe('Command Code')
    for (const title of ['cmd', 'cmdc', 'command-code', 'command_code', 'commandcode', 'Command Code'])
      expect(paneTitle(cmd({ title })), title).toBe('Command Code')
    for (const name of ['cmd', 'cmdc', 'command code', 'command-code', 'command_code', 'commandcode', 'Command Code'])
      expect(paneTitle(cmd({ name })), name).toBe('Command Code')
    expect(paneOwnTitle(cmd({ name: 'cmdc' }))).toBe('cmd')
    expect(paneOwnTitle(cmd({ name: 'command-code' }))).toBe('cmd')
    expect(paneOwnTitle(cmd())).toBe('cmd')
  })

  it('keeps a name or title that says something', () => {
    expect(paneTitle(cmd({ label: 'Import fixer' }))).toBe('Import fixer')
    expect(paneTitle(cmd({ name: 'Import fixer' }))).toBe('Import fixer')
    expect(paneTitle(cmd({ name: 'review the migration' }))).toBe('review the migration')
    expect(paneTitle(cmd({ title: 'Import regression sweep' }))).toBe('Import regression sweep')
    expect(paneTitle(cmd({ name: null, title: 'Fixing the parser | cmd' }))).toBe('Fixing the parser')
  })

  it('never offers its own titles as the subject of the conversation', () => {
    expect(meaningfulTitle({ agent: 'cmd', title: 'cmdc', cwd: '/home/user' })).toBe('')
    expect(meaningfulTitle({ agent: 'cmd', title: 'Command Code', cwd: '/home/user' })).toBe('')
    expect(meaningfulTitle({ agent: 'cmd', title: 'Migrate the parser', cwd: '/home/user' })).toBe('Migrate the parser')
  })
})

describe('own title of a pane, without an added capital', () => {
  it('keeps the agent id of an unnamed agent pane as typed', () => {
    const unnamed = pane({ agent: 'omp', name: '', title: '' })
    expect(paneTitle(unnamed)).toBe('Omp')
    expect(paneOwnTitle(unnamed)).toBe('omp')
    expect(paneOwnTitle(pane({ agent: 'claude', name: 'claude', title: '' }))).toBe('claude')
    expect(paneOwnTitle(pane({ label: 'Mon agent' }))).toBe('Mon agent')
    expect(paneOwnTitle(pane({ agent: 'omp', name: 'build review', title: '' }))).toBe('build review')
  })
})

describe('credentials in names', () => {
  it('masks the userinfo of a URI pasted into a name', () => {
    expect(maskCreds('HTTPS_PROXY=http://user1:secre7@10.0.0.1:3128')).toBe('HTTPS_PROXY=http://…@10.0.0.1:3128')
    expect(maskCreds('postgres://alice:p%40ss@db.acme/app')).toBe('postgres://…@db.acme/app')
  })
  it('leaves names without a password alone', () => {
    expect(maskCreds('ssh://git@github.com/acme/shop')).toBe('ssh://git@github.com/acme/shop')
    expect(maskCreds('git@github.com:acme/shop.git')).toBe('git@github.com:acme/shop.git')
    expect(maskCreds('mailto:alice@acme.dev')).toBe('mailto:alice@acme.dev')
  })
  it('cleanTitle masks too, so every title path is covered', () => {
    expect(cleanTitle('PROXY=http://user1:secre7@proxy.local:8080')).toBe('PROXY=http://…@proxy.local:8080')
  })
})
