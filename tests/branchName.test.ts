import { describe, expect, it } from 'vitest'
import { branchFor, branchNameError, followedBranch, reportedBranch, slugOf } from '../shared/pm/branchName'
import { cleanProjectUpdate } from '../shared/pm/project'

const task = { id: 'WHR-12', title: 'Fix the login page', type: 'bug', tags: ['PROJ-345'] }
const TPL = '{type}/{tag}-{slug}'

describe('branch name template', () => {
  it('fills {type}, {tag}, {slug} and {id}; none set: task/{id}', () => {
    expect(branchFor(TPL, task)).toBe('bugfix/PROJ-345-fix-the-login-page')
    expect(branchFor('{type}/{id}', { ...task, type: 'feature' })).toBe('feature/WHR-12')
    expect(branchFor(undefined, task)).toBe('task/WHR-12')
    expect(branchFor('', task)).toBe('task/WHR-12')
  })

  it('prefers a ticket key among the tags; no tag: the task id', () => {
    expect(branchFor(TPL, { ...task, tags: ['urgent', 'PROJ-9'] })).toBe('bugfix/PROJ-9-fix-the-login-page')
    expect(branchFor(TPL, { ...task, tags: ['urgent'] })).toBe('bugfix/urgent-fix-the-login-page')
    expect(branchFor(TPL, { ...task, tags: undefined })).toBe('bugfix/WHR-12-fix-the-login-page')
  })

  it('cuts a long title on a word, and drops the characters git refuses', () => {
    expect(slugOf('Add a branch name template per project so that every pushed branch matches')).toBe('add-a-branch-name-template-per-project')
    expect(slugOf('x'.repeat(60))).toBe('x'.repeat(40))
    expect(branchFor(TPL, { ...task, title: 'Éditer: ~les ^fichiers [vite]?', tags: ['a b..c@{x}'] })).toBe('bugfix/a-b.c-x-editer-les-fichiers-vite')
    // A title with no letters leaves no stray dash.
    expect(branchFor(TPL, { ...task, title: '!!!' })).toBe('bugfix/PROJ-345')
  })

  it('refuses a template that names no task or that git refuses', () => {
    expect(branchNameError(TPL)).toBeUndefined()
    expect(branchNameError('feature/{slug}')).toMatch(/needs \{id\} or \{tag\}/)
    expect(branchNameError('{kind}/{id}')).toMatch(/unknown field \{kind\}/)
    expect(branchNameError('a..b/{id}')).toBe('not a valid branch name')
    expect(cleanProjectUpdate({ branchName: 'x {id}' }).errors).toEqual([{ path: 'branchName', message: 'not a valid branch name' }])
    expect(cleanProjectUpdate({ branchName: '' }).update).toEqual({ branchName: '' })
  })
})

describe('the branch the worker pushed', () => {
  it('a Branch: line, else a link\'s source branch, else the worktree\'s branch', () => {
    expect(reportedBranch('Done.\nBranch: `feature/PROJ-1-x`\nhttps://example.com/pr/1')).toBe('feature/PROJ-1-x')
    expect(reportedBranch('PR: https://bitbucket.org/example-org/example-repo/pull-requests/new?source=feature%2FPROJ-1-x&t=1')).toBe('feature/PROJ-1-x')
    expect(reportedBranch('Branch: not a branch')).toBeUndefined()
    const start = 'task/WHR-1'
    expect(followedBranch(start, { note: 'done', branch: 'feature/PROJ-1' }, start)).toBe('feature/PROJ-1')
    expect(followedBranch(start, { note: 'done', branch: start }, start)).toBeUndefined()
    // Pushed without a checkout: followed, and a later report without the line keeps it.
    expect(followedBranch(start, { note: 'Branch: bugfix/PROJ-2', branch: start }, start)).toBe('bugfix/PROJ-2')
    expect(followedBranch('bugfix/PROJ-2', { note: 'Fixed the findings.', branch: start }, start)).toBeUndefined()
  })
})
