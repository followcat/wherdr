import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/pm/project'
import { WORKSPACE_FIRST, workspaceInput, workspaceInstructions, cleanWorkspaceFields, effectiveProject, effectiveWorkflow, followShared, liftShared, memberOverrides, workflowOverrides, workspaceErrors, workspaceTaskError } from '../shared/pm/workspace'
import { defaultWorkflow, type Template } from '../shared/pm/workflow'
import { taskGuards } from '../shared/pm/actions'
import { cleanProjectUpdate } from '../shared/pm/project'
import { instructionsText, parseWsFiles, wsFilesSection } from '../shared/pm/run'
import { reviewFile } from '../shared/pm/advance'

const ws: Project = {
  key: 'WS', name: 'Work', machine: 'home', path: '~/work', git: false, kind: 'workspace', group: 'g1', addedAt: 1,
  shared: {
    machines: ['big'], clones: { big: '/srv/work' }, paused: ['big'], placement: 'balance', base: 'develop', branchName: 'ws/{id}',
    prefs: { agent: 'codex', model: 'gpt-5', reviewFallbackAgent: 'claude', reviewFallbackModel: 'opus' }, worktree: { share: ['node_modules'] }, archiveAfter: 30, deleteBranch: false,
  },
}
const member: Project = { key: 'PAY', name: 'payroll-api', machine: 'home', path: '~/work/payroll-api', workspace: 'WS', addedAt: 2 }

describe('workspaceInput', () => {
  it('a new workspace from its form: its home machine first, the others shared with their roots', () => {
    const one = workspaceInput({ key: 'WS', name: 'Work', roots: [['', '~/work']] })
    expect(one).toEqual({ key: 'WS', name: 'Work', machine: '', path: '~/work', kind: 'workspace' })
    expect(cleanWorkspaceFields(workspaceInput({ key: 'WS', group: 'g1', roots: [['', '~/work'], ['big', '/srv/work']] }))).toEqual({
      fields: { kind: 'workspace', group: 'g1', shared: { machines: ['big'], clones: { big: '/srv/work' } } }, errors: [],
    })
    expect(WORKSPACE_FIRST).toContain('wherdr pm map list')
  })
})

describe('workspaces', () => {
  it('a member inherits every shared field, its clone under each machine\'s root', () => {
    expect(effectiveProject(member, ws)).toEqual({
      ...member, machines: ['home', 'big'], clones: { big: '/srv/work/payroll-api' }, paused: ['big'],
      placement: 'balance', base: 'develop', branchName: 'ws/{id}', archiveAfter: 30, deleteBranch: false,
    })
    expect(effectiveWorkflow('PAY', null, member, ws)).toMatchObject({ prefs: ws.shared!.prefs, worktree: ws.shared!.worktree })
    // Not a member: as is.
    expect(effectiveProject({ ...member, workspace: undefined }, ws)).toEqual({ ...member, workspace: undefined })
    // The workspace's sheet shows them from its shared settings.
    expect(liftShared(ws)).toMatchObject({ placement: 'balance', base: 'develop', branchName: 'ws/{id}', archiveAfter: 30, deleteBranch: false })
  })

  it('an override wins, and clearing it falls back to the shared value', () => {
    const own: Project = { ...member, base: 'main', machines: ['home'], placement: 'home', overrides: ['base', 'machines', 'placement', 'prefs'] }
    const e = effectiveProject(own, ws)
    expect(e).toMatchObject({ base: 'main', machines: ['home'], placement: 'home', branchName: 'ws/{id}' })
    expect(e.clones).toBeUndefined()
    expect(effectiveWorkflow('PAY', null, own, ws).prefs).toEqual(defaultWorkflow('PAY').prefs)
    // A base of '' clears the override.
    const cleared = { ...own, base: undefined, ...memberOverrides(own, { base: '' }) }
    expect(cleared.overrides).toEqual(['machines', 'placement', 'prefs'])
    expect(effectiveProject(cleared, ws).base).toBe('develop')
    expect(memberOverrides(member, { archiveAfter: 0 })).toEqual({ overrides: ['archiveAfter'] })
    // "Use <workspace>'s" on one field: that one alone back on the workspace's.
    const placed = followShared(own, 'placement')
    expect(placed).toMatchObject({ base: 'main', machines: ['home'], overrides: ['base', 'machines', 'prefs'] })
    expect(effectiveProject(placed, ws).placement).toBe(ws.shared?.placement)
    expect(followShared(followShared(placed, 'machines'), 'base')).not.toHaveProperty('machines')
  })

  it('keeps the workspace\'s pause on a member\'s home machine, and a workflow differing from the shared one is an override', () => {
    expect(effectiveProject({ ...member, machine: 'big', path: '/srv/work/payroll-api' }, ws)).toMatchObject({ machines: ['big', 'home'], paused: ['big'] })
    expect(workflowOverrides(member, ws, { prefs: { agent: 'claude' }, worktree: ws.shared!.worktree })).toEqual({ overrides: ['prefs'] })
    expect(workflowOverrides({ ...member, overrides: ['prefs', 'worktree'] }, ws, { prefs: ws.shared!.prefs })).toEqual({})
  })

  it('a member runs the workspace\'s workflow, its own file wins, the workspace\'s guards stay on both', () => {
    const steps = [{ id: 'todo', column: 'To do' }, { id: 'done', column: 'Done' }]
    const shared: Template = { id: 'ws', version: 3, guards: { protected: ['main'], merge: { others: 'user' } }, taskTypes: { bug: { steps } } }
    const runs = effectiveWorkflow('PAY', null, member, ws, shared)
    expect(runs).toMatchObject({ id: 'pay', version: 3, taskTypes: shared.taskTypes, workspaceGuards: shared.guards, prefs: ws.shared!.prefs })
    const mine: Template = { id: 'pay', version: 1, guards: { protected: ['release'], merge: { others: 'engine' } }, taskTypes: { chore: { steps } } }
    const own = effectiveWorkflow('PAY', mine, member, ws, shared)
    expect(Object.keys(own.taskTypes)).toEqual(['chore'])
    // Its own guards add a protected branch but cannot loosen the workspace's merge rule.
    const g = taskGuards(own, 'chore')
    expect(g.protected.map(p => `${p.value}:${p.source}`)).toEqual(['main:workspace', 'release:project'])
    expect(g.merge.others).toEqual({ value: 'user', source: 'workspace' })
    // Not a member: its own file or the default, never a workspace's guards.
    expect(effectiveWorkflow('PAY', null, { ...member, workspace: undefined }, ws, shared)).toEqual(defaultWorkflow('PAY'))
  })

  it('a member without its own worktree setup runs the workspace\'s, wherever the workspace keeps it', () => {
    const bare: Project = { ...ws, shared: {} }, file: Template = { id: 'ws', version: 1, taskTypes: {}, worktree: { copy: ['.env'] } }
    // In the workspace's workflow file (where its sheet saves it), its shared settings first.
    expect(effectiveWorkflow('PAY', null, member, bare, file).worktree).toEqual({ copy: ['.env'] })
    expect(effectiveWorkflow('PAY', null, member, ws, file).worktree).toEqual(ws.shared!.worktree)
    // The member's own file without an override: still the workspace's.
    expect(effectiveWorkflow('PAY', { id: 'pay', version: 1, taskTypes: {} }, member, bare, file).worktree).toEqual({ copy: ['.env'] })
    // A member override wins; the same setup as the workspace's file is none.
    const own = { ...member, overrides: ['worktree' as const], worktree: { setup: 'npm ci' } }
    expect(effectiveWorkflow('PAY', null, own, bare, file).worktree).toEqual({ setup: 'npm ci' })
    expect(workflowOverrides(member, bare, { worktree: { copy: ['.env'] } }, file)).toEqual({})
    // The machines set on the workspace's sheet (on itself) reach its members too.
    const machines: Project = { ...bare, machines: ['home', 'big'], clones: { big: '/srv/work' } }
    expect(effectiveProject(member, machines)).toMatchObject({ machines: ['home', 'big'], clones: { big: '/srv/work/payroll-api' } })
  })

  it('a workspace refuses a normal task, a project takes it', () => {
    expect(workspaceTaskError(ws, 'task')).toMatch(/features only/)
    expect(workspaceTaskError(ws, 'feature')).toBe('')
    expect(workspaceTaskError(member, 'task')).toBe('')
  })

  it('refuses a workspace with git, an unknown workspace, a nested one and an unknown override', () => {
    expect(workspaceErrors([ws, member])).toEqual([])
    expect(workspaceErrors([{ ...ws, git: undefined }])).toEqual(['Workspace WS is stored without git (git: false): a git repository at its root is a member project'])
    expect(workspaceErrors([member])).toEqual(['PAY names no existing workspace'])
    expect(workspaceErrors([ws, { ...member, workspace: 'PAY' }, { ...member, key: 'X', workspace: 'WS' }])).toEqual(['PAY names no existing workspace'])
    expect(workspaceErrors([ws, { ...ws, key: 'W2', workspace: 'WS' }])).toEqual(['Workspace W2 cannot be in a workspace'])
    expect(workspaceErrors([ws, { ...member, overrides: ['name' as never] }])).toEqual(['PAY overrides an unknown field'])
    expect(cleanWorkspaceFields({ kind: 'workspace', shared: { base: 'a..b', prefs: { agent: 3 } } }).errors.map(e => e.path)).toEqual(['shared.base', 'shared.prefs.agent'])
  })
})

describe('workspace instructions files', () => {
  const list = (m: Project, w: Project = ws) => [w, m]
  it('a member inherits the default (first of AGENTS.md, CLAUDE.md) or the workspace\'s list, turns them off or replaces them', () => {
    expect(workspaceInstructions(member, list(member))).toEqual({ machine: 'home', root: '~/work', paths: ['AGENTS.md', 'CLAUDE.md'], first: true })
    const set = { ...ws, shared: { ...ws.shared, instructionsFiles: ['docs/rules.md'] } }
    expect(workspaceInstructions(member, list(member, set))).toEqual({ machine: 'home', root: '~/work', paths: ['docs/rules.md'] })
    expect(workspaceInstructions(member, list(member, { ...ws, shared: { instructionsFiles: [] } }))).toBeUndefined()
    expect(workspaceInstructions({ ...member, overrides: ['instructionsFiles'], instructionsFiles: [] }, list(member, set))).toBeUndefined()
    expect(workspaceInstructions({ ...member, overrides: ['instructionsFiles'], instructionsFiles: ['OWN.md'] }, list(member, set))?.paths).toEqual(['OWN.md'])
    expect(workspaceInstructions({ ...member, workspace: undefined }, list(member))).toBeUndefined()
    // [] turns them off, null gives the workspace's back; paths stay under the root.
    expect(memberOverrides(member, { instructionsFiles: [] })).toEqual({ overrides: ['instructionsFiles'] })
    expect(memberOverrides({ ...member, overrides: ['instructionsFiles'] }, { instructionsFiles: null })).toEqual({})
    for (const bad of [['../x.md'], ['/etc/x'], ['*.md']]) expect(cleanProjectUpdate({ instructionsFiles: bad }).errors[0]?.path).toBe('instructionsFiles')
  })

  it('read: a missing file skipped with a log line, a long one cut at the cap; the default takes the first found', () => {
    const out = '--wherdr-missing-- RULES.md\n--wherdr-file-- AGENTS.md\nUse psql.\n--wherdr-file-- CLAUDE.md\n0123456789'
    expect(parseWsFiles(out, 5)).toEqual({
      files: [{ path: 'AGENTS.md', text: 'Use p' }, { path: 'CLAUDE.md', text: '01234' }],
      log: ['Workspace instructions: RULES.md not found at the workspace\'s root, skipped', 'Workspace instructions: AGENTS.md is longer than 5 characters, cut there', 'Workspace instructions: CLAUDE.md is longer than 5 characters, cut there'],
    })
    expect(parseWsFiles(out, 100, true)).toEqual({ files: [{ path: 'AGENTS.md', text: 'Use psql.' }], log: [] })
  })

  it('the worker\'s and the reviewer\'s instructions give them after the workflow\'s', () => {
    const lines = wsFilesSection([{ path: 'AGENTS.md', text: 'Use psql.' }])
    const task = { id: 'PAY-1', project: 'PAY', title: 'T', description: 'D', type: 'feature', state: 'todo' as const, createdAt: 0 }
    const run = { worktree: '/w', branch: 'task/PAY-1' }
    const worker = instructionsText(member, defaultWorkflow('PAY'), task, run, undefined, undefined, lines)
    expect(worker).toContain('## Workspace instructions (AGENTS.md)\n\nUse psql.')
    expect(worker.indexOf('## Instructions')).toBeLessThan(worker.indexOf('## Workspace instructions'))
    expect(reviewFile(task, run, 'Review it.', '/v.json', false, lines)).toMatch(/Review it\.\n\n## Workspace instructions \(AGENTS\.md\)\n\nUse psql\./)
  })
})
