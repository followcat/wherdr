import { describe, expect, it } from 'vitest'
import { checkable, mergedArchive, openWhy, type PrView } from '../shared/pm/ghCheck'
import { taskGuards } from '../shared/pm/actions'
import { parseCommand } from '../shared/pm/coordinator'
import { initialState, planSteps } from '../shared/pm/steps'
import { wherdr } from '../shared/pm/examples'

const plan = planSteps(wherdr, { type: 'simple' }) // todo, work, pr, review, merge, done
const at = (id: string) => plan.findIndex(p => p.id === id)
const url = 'https://github.com/example/repo/pull/7'
const withPr = { ...initialState(), started: true, proofs: { pr: { link: url } } }
const pr = (over: Partial<PrView> = {}): PrView => ({ url, state: 'OPEN', baseRefName: 'v3', headRefOid: 'abc', statusCheckRollup: [], ...over })

describe('Check on GitHub', () => {
  it('is offered at a merge step or on an archived task, with a PR only', () => {
    expect(checkable(plan, { ...withPr, at: at('merge') })).toBe(true)
    expect(checkable(plan, { ...withPr, at: at('review') })).toBe(false)
    expect(checkable(plan, { ...withPr, at: at('merge'), done: true, abandoned: true })).toBe(true)
    expect(checkable(plan, { ...withPr, at: at('merge'), done: true })).toBe(false)
    expect(checkable(plan, { ...initialState(), started: true, at: at('merge') })).toBe(false)
  })

  it('says why an open PR waits: checks, review, guard', () => {
    const g = taskGuards(wherdr, 'simple')
    const why = openWhy(pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }), [], g, { ...plan[at('merge')]!, guarded: true })
    expect(why).toBe('The PR is open: waiting for checks (test); changes were requested; only you may merge into v3')
  })

  it('an archived task whose PR was merged ends as merged', () => {
    const s = mergedArchive(plan, { ...withPr, at: at('merge'), done: true, abandoned: true }, url)
    expect(s.abandoned).toBeUndefined()
    expect(s.proofs.merge).toEqual({ link: url })
  })

  it('wherdr pm task check <task>', () => {
    expect(parseCommand(['task', 'check', 'WH-1'])).toEqual({ name: 'task check', task: 'WH-1' })
    expect(parseCommand(['task', 'check'])).toHaveProperty('error')
  })
})
