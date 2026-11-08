import { describe, expect, it } from 'vitest'
import { prMergeRefusal, type ContributorPr } from '../shared/pm/contributorPr'
import type { Guards } from '../shared/pm/workflow'

const pr = (more: Partial<ContributorPr> = {}): ContributorPr => ({
  number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', baseRefName: 'v3', headRefName: 'fix-typo', headRefOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...more,
})
const on: Guards = { protected: ['main'], contributorPrs: 'others' }
const why = (more: Partial<Parameters<typeof prMergeRefusal>[0]> = {}) =>
  prMergeRefusal({ guards: on, turn: 'user', userSaid: 'yes, merge #7', pr: pr(), taskLinks: [], ...more })

describe('pr merge refusals', () => {
  it('allows an open, green, mergeable contributor PR after the user\'s yes', () => {
    expect(why()).toBeUndefined()
    // 'all' also reaches a branch reserved for the user.
    expect(why({ guards: { ...on, contributorPrs: 'all' }, pr: pr({ baseRefName: 'main' }) })).toBeUndefined()
  })

  it('refuses with the guard off, in a wake, or without the user\'s words', () => {
    expect(why({ guards: { protected: ['main'] } })).toMatch(/guard "Contributor PRs: the coordinator may merge after your yes" is off/)
    expect(why({ turn: 'wake' })).toMatch(/never a wake/)
    expect(why({ turn: 'none' })).toMatch(/never a wake/)
    expect(why({ userSaid: ' ' })).toMatch(/needs the user's yes/)
  })

  it('refuses red or running checks, a conflict, a draft, a closed or unknown PR', () => {
    expect(why({ pr: pr({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }) })).toBe('PR #7: 1 check(s) failed')
    expect(why({ pr: pr({ statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }) })).toBe('PR #7: checks still running')
    expect(why({ pr: pr({ mergeable: 'CONFLICTING' }) })).toMatch(/not mergeable \(conflicting\)/)
    expect(why({ pr: pr({ mergeStateStatus: 'BLOCKED' }) })).toMatch(/blocked by the branch's rules/)
    expect(why({ pr: pr({ isDraft: true }) })).toMatch(/draft/)
    expect(why({ pr: pr({ state: 'MERGED' }) })).toMatch(/not open \(merged\)/)
    expect(why({ pr: null })).toMatch(/No such PR/)
  })

  it('refuses a board task\'s PR, and a branch reserved for the user unless the guard says all', () => {
    expect(why({ pr: pr({ headRefName: 'task/WHR-42' }) })).toMatch(/board task's: the engine merges it/)
    expect(why({ taskLinks: ['https://github.com/o/r/pull/7'] })).toMatch(/board task's/)
    expect(why({ pr: pr({ baseRefName: 'main' }) })).toBe('main is reserved for the user: only they merge into it')
    expect(why({ guards: { ...on, merge: { others: 'user' } } })).toBe('v3 is reserved for the user: only they merge into it')
  })
})
