import { expect, it } from 'vitest'
import { agentCatchingUp, refusalSaid, turnText } from '../shared/pm/refusal'
import { initialState } from '../shared/pm/steps'

it('says each merge refusal in plain words, never a command', () => {
  const short = (error: string, told = false) => refusalSaid(`Merge: ${error}`, told).short
  expect(short('merge: the PR conflicts with v3')).toBe('The PR conflicts with v3')
  expect(short('merge: the PR conflicts with v3', 'updating')).toBe('The PR conflicts with v3: the agent is updating it')
  expect(refusalSaid('merge: the PR conflicts with v3', 'updating').waits).toBe(true)
  expect(short('merge: the PR conflicts with v3', 'updated')).toBe('The agent brought the PR up to date with v3')
  expect(short('catch-up: conflict with v3 in app.vue')).toBe('The PR conflicts with v3')
  expect(short('merge: X Pull request #5 is not mergeable')).toBe('The PR conflicts with its target branch')
  expect(short('merge: 2 check(s) failed')).toBe('checks failed')
  expect(short('merge: checks still running')).toBe('checks still running')
  expect(short('merge: waiting for check smoke')).toBe('checks still running')
  expect(short('merge: the PR head is not the task\'s commit')).toBe('The PR is not at the task\'s latest commit')
  expect(short('merge: base branch policy prohibits the merge')).toBe('GitHub\'s branch rules refuse the merge')
  expect(short('merge: no open PR for this task')).toBe('no open PR')
  // An old error that kept GitHub's hint: the command is never shown.
  expect(refusalSaid('Merge: merge: gh pr checkout 505 && git fetch origin v3 && git merge origin/v3')).toEqual({
    short: 'GitHub refused the merge', long: 'GitHub refused the merge. Press again, or ask the coordinator to look at the task.',
  })
  expect(refusalSaid('merge: the task was stopped').short).toBe('the task was stopped')
  expect(refusalSaid('merge: new commits since the review (abc..def)').short).toBe('new commits since the review (abc..def)')
})

it('drops the user\'s turn while the agent fixes the conflict, and gives it back once the PR is clean', () => {
  const error = 'merge: the PR conflicts with v3', badge = `Look at the screenshots, then merge: ${error}`
  const card = { yourTurn: badge, state: { ...initialState(), started: true, since: 10, yourTurn: { reason: 'action' as const, badge, error } }, log: [] as { at: number, by: string, text: string }[] }
  expect(turnText(card)).toBe('Look at the screenshots, then merge: The PR conflicts with v3')
  const told = { ...card, log: [{ at: 20, by: 'engine', text: 'catch-up: sent to the agent' }], prNow: 'conflict with its base' }
  expect(agentCatchingUp(told)).toBe('updating')
  expect(turnText(told)).toBeUndefined()
  expect(turnText({ ...told, prNow: 'behind its base' })).toBeUndefined()
  // The agent pushed its fix: the PR reads clean again, the user presses again.
  for (const prNow of ['waiting for checks (smoke)', 'ready to merge', undefined]) {
    expect(agentCatchingUp({ ...told, prNow })).toBe('updated')
    expect(turnText({ ...told, prNow })).toBe('Look at the screenshots, then merge: The agent brought the PR up to date with v3')
  }
  expect(agentCatchingUp({ ...card, log: [{ at: 5, by: 'engine', text: 'catch-up: sent to the agent' }] })).toBeUndefined() // before this step
  expect(turnText({ yourTurn: 'Look at the screenshots, then merge' })).toBe('Look at the screenshots, then merge')
})
