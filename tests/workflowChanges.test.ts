import { expect, it } from 'vitest'
import { changeSummary, workflowChanges } from '../shared/pm/workflowChanges'
import type { Template } from '../shared/pm/workflow'

const old: Template = {
  id: 'w',
  guards: { merge: { others: 'user' } },
  steps: { review: { id: 'review', holder: 'reviewer', ends: 'verdict', instructions: 'Read the diff.\nSay pass.' } },
  taskTypes: {
    task: { steps: [{ id: 'todo' }, { id: 'work', holder: 'worker', ends: 'report' }, 'review', { id: 'old', holder: 'coordinator' }, { id: 'done' }] },
    tiny: { steps: [{ id: 'todo' }, { id: 'done' }] },
  },
}

it('lists, per type, the steps added, removed and changed, and each changed field', () => {
  const next: Template = {
    ...old,
    guards: { merge: { others: 'engine' } },
    steps: { review: { ...old.steps!.review!, instructions: 'Read the diff.\nRun the tests.\nSay pass.' } },
    taskTypes: {
      task: { steps: [{ id: 'todo' }, { id: 'work', holder: 'coordinator', ends: 'report' }, 'review', { id: 'land', ends: 'action', action: { kind: 'github.merge', checks: ['smoke'] } }, { id: 'done' }] },
      big: { steps: [{ id: 'todo' }] },
    },
  }
  const c = workflowChanges(old, next)
  expect(c.all).toEqual([{ field: 'merge', before: 'you', after: 'automatic' }])
  expect(c.types.map(t => [t.type, t.kind])).toEqual([['task', 'changed'], ['tiny', 'removed'], ['big', 'added']])
  // The new step list, a removed step before the next one kept.
  expect(c.types[0]!.steps.map(s => [s.id, s.kind])).toEqual([['todo', 'same'], ['work', 'changed'], ['review', 'changed'], ['land', 'added'], ['old', 'removed'], ['done', 'same']])
  expect(c.types[0]!.steps[1]!.fields).toEqual([{ field: 'holder', before: 'worker', after: 'coordinator' }])
  expect(c.types[0]!.steps[2]!.fields).toEqual([{ field: 'instructions', before: 'Read the diff.\nSay pass.', after: 'Read the diff.\nRun the tests.\nSay pass.' }])
  expect(changeSummary(c, 9)).toEqual([
    'all types: merge: you → automatic',
    'task: work holder: worker → coordinator, review instructions edited, + land, − old',
    'type tiny removed',
    '+ type big (1 step, automatic merge)',
  ])
  expect(changeSummary(c)).toEqual(['all types: merge: you → automatic', 'and 3 more changes'])
})

it('a type-level guard and an action read in plain words; an unchanged workflow lists nothing', () => {
  const next: Template = { ...old, taskTypes: { ...old.taskTypes, tiny: { guards: { merge: { others: 'engine' } }, steps: [{ id: 'todo' }, { id: 'land', ends: 'action', action: { kind: 'github.merge', checks: ['smoke'] } }, { id: 'done' }] } } }
  expect(changeSummary(workflowChanges(old, next))).toEqual(['tiny: merge: none → automatic, + land'])
  expect(workflowChanges(old, next).types[0]!.steps[1]).toMatchObject({ id: 'land', kind: 'added', ends: 'action' })
  expect(workflowChanges(old, old)).toEqual({ all: [], types: [] })
})

it('a step moved among the others reads as moved', () => {
  const steps = old.taskTypes.task!.steps
  const next: Template = { ...old, taskTypes: { ...old.taskTypes, task: { steps: [steps[0]!, steps[2]!, steps[1]!, steps[3]!, steps[4]!] } } }
  const c = workflowChanges(old, next)
  expect(c.types[0]!.steps.map(s => [s.id, s.kind])).toEqual([['todo', 'same'], ['review', 'same'], ['work', 'moved'], ['old', 'same'], ['done', 'same']])
  expect(changeSummary(c)).toEqual(['task: work moved'])
})
