import { expect, it } from 'vitest'
import { freedMerge, guardEffects } from '../shared/pm/guardEffects'
import { planSteps } from '../shared/pm/steps'
import type { Template } from '../shared/pm/workflow'

const t: Template = {
  id: 'web',
  version: 1,
  steps: { land: { id: 'land', holder: 'none', ends: 'action', action: { kind: 'git.land', target: 'dev' } } },
  taskTypes: {
    feature: {
      guards: { protected: ['develop'], merge: { others: 'user' } },
      steps: [
        { id: 'work', holder: 'worker', ends: 'report' },
        { id: 'pr', holder: 'none', ends: 'action', action: { kind: 'github.pr' } },
        { id: 'merge', holder: 'none', ends: 'action', action: { kind: 'github.merge' } },
      ],
    },
    fix: { steps: ['land'] },
  },
}

it('lists what each task type adds and who merges at each merging step, the PR base from the project', () => {
  expect(guardEffects(t, { protected: ['main'] }, 'main')).toEqual({
    types: [{ type: 'feature', protects: ['develop'], merge: { others: 'user' } }],
    steps: [
      { type: 'feature', step: 'merge', into: 'main', by: 'user' },
      { type: 'fix', step: 'land', into: 'dev', by: 'engine' },
    ],
  })
})

it('follows the guards being edited at once', () => {
  const g = guardEffects(t, { protected: ['main', 'dev'], merge: { protected: 'engine', others: 'user' } }, 'main')
  // The task type asks what the project already says: nothing to add.
  expect(g.types).toEqual([{ type: 'feature', protects: ['develop'], merge: {} }])
  expect(g.steps.map(s => s.by)).toEqual(['engine', 'engine'])
})

it('frees a merge its old guards refused once the new ones give it to the engine, and nothing else', () => {
  const was = planSteps({ ...t, guards: { protected: ['main'] } }, { type: 'feature' }, 'main')
  const now = planSteps({ ...t, guards: { protected: ['main'], merge: { protected: 'engine' } } }, { type: 'feature' }, 'main')
  const refused = { state: 'working' as const, step: { at: 2, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'action' as const, badge: 'merge: main is protected: only you may merge into it' } } }
  expect(freedMerge(refused, was, now)).toBe('main')
  // Still the user's, already running, stopped, or not waiting on the merge.
  expect(freedMerge(refused, was, was)).toBeUndefined()
  expect(freedMerge({ ...refused, step: { ...refused.step, acting: true } }, was, now)).toBeUndefined()
  expect(freedMerge({ ...refused, stopped: { at: 1, by: 'user' } } as never, was, now)).toBeUndefined()
  expect(freedMerge({ ...refused, step: { ...refused.step, at: 0 } }, was, now)).toBeUndefined()
})
