import { expect, it } from 'vitest'
import { common, company, github, vibe, wherdr } from '../shared/pm/examples'
import { planSteps } from '../shared/pm/steps'
import { actionLabel, describeStep, endHint, holderHint } from '../shared/pm/describe'
import { ACTIONS, ENDS, HOLDERS, type Template } from '../shared/pm/workflow'

// The sentence of each step of a task type, as the editor's plan shows it.
const say = (t: Template, type: string) => {
  const plan = planSteps(t, { type })
  return Object.fromEntries(plan.map((s, n) => [s.id, describeStep(s, undefined, { first: n === 0, last: n === plan.length - 1 })]))
}
const TODO = 'The task waits here until it starts.'
const DONE = 'The task is done.'

it('vibe: the engine lands the branch on dev without a PR', () => {
  expect(say(vibe, 'simple')).toEqual({
    todo: TODO,
    work: 'The worker does the task and says when it is done.',
    land: 'The engine merges the task’s branch into dev and pushes it, without a PR. A conflict sends it back to the agent.',
    done: DONE,
  })
})

it('company: review rounds, a PR link, your merge checked, the engine watching the deploy', () => {
  expect(say(company, 'feature')).toMatchObject({
    review: 'The reviewer checks the work: a major finding sends it back to work, up to 2 times, then you decide.',
    pr: 'The worker does the task and says when it is done; it must attach a link.',
    merge: 'Waits here until you act (button “I merged it”). Then: the engine checks the branch is merged into develop; if not, it waits for you.',
    deploy: 'The engine follows the GitHub Actions runs of develop’s latest commit every 2m, up to 90m. A failure is said to the coordinator and comes to you.',
  })
})

it('github: the engine opens the PR and merges it', () => {
  expect(say(github, 'simple')).toMatchObject({
    pr: 'The engine pushes the branch and opens a GitHub PR to next.',
    merge: 'The engine merges the GitHub PR.',
  })
})

it('common: a report, then proposed tasks you create', () => {
  expect(say(common, 'study').work).toBe('The worker does the task and says when it is done; it must attach a report.')
  expect(say(common, 'feature-split')).toEqual({
    split: 'The worker does the task and says when it is done; it must attach the proposed tasks.',
    pick: 'Waits here until you act (button “Create these tasks”).',
    done: DONE,
  })
})

it('wherdr: screenshots, timeouts and a squash merge once smoke is green', () => {
  expect(say(wherdr, 'visual')).toMatchObject({
    work: 'The worker does the task and says when it is done; it must attach screenshots. After 3h, it comes to you.',
    review: 'The reviewer checks the work: a major finding sends it back to work, up to 3 times, then you decide. After 45m, it comes to you.',
    merge: 'Waits here until you act (button “Accept”). Then: the engine merges the GitHub PR (squash) once smoke is green.',
  })
  expect(say(wherdr, 'simple').merge).toBe('The engine merges the GitHub PR (squash) once smoke is green.')
})

it('says when a merge is left to you, and what a step with no end does', () => {
  const t: Template = { ...vibe, taskTypes: { simple: { steps: [
    { id: 'land', ends: 'action', action: { kind: 'git.land', target: 'main' } },
    { id: 'push', ends: 'action', action: { kind: 'git.push' } },
    { id: 'pass' },
    { id: 'shots', holder: 'worker', ends: 'report', evidence: ['screenshots', 'commit'], screenshots: 'before-after' },
  ] } } }
  expect(say(t, 'simple')).toEqual({
    land: 'The engine merges the task’s branch into main and pushes it, without a PR. A conflict sends it back to the agent. main is protected: it waits for you to merge.',
    push: 'The engine pushes the task’s branch. Uncommitted changes send it back to the agent.',
    pass: 'Nothing happens here: the task goes straight on.',
    shots: 'The worker does the task and says when it is done; it must attach screenshots before and after, the commit.',
  })
  expect(describeStep({ id: 'x', ends: 'action' })).toBe('The engine runs an action: choose which.')
})

it('labels every action, holder and end, in French too', () => {
  const fr = (_en: string, f: string) => f
  expect(ACTIONS.map(kind => actionLabel({ kind, target: 'dev', base: 'dev' }))).toEqual([
    'Merge into dev (no PR)', 'Push the branch', 'Open a GitHub PR to dev', 'Merge the GitHub PR', 'Merge the Bitbucket PR', 'Check it is merged into dev', 'Watch the pipeline',
  ])
  expect(actionLabel({ kind: 'github.pr' })).toBe('Open a GitHub PR to the working branch')
  for (const h of HOLDERS) expect(holderHint(h, fr)).not.toBe(holderHint(h))
  for (const e of [...ENDS, ''] as const) expect(endHint(e, fr)).not.toBe(endHint(e))
  expect(describeStep(vibe.taskTypes.simple!.steps[2] as never, fr)).toBe('Le moteur fusionne la branche de la tâche dans dev et la pousse, sans PR. Un conflit la renvoie à l’agent.')
})
