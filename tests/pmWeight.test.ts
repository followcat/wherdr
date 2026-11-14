import { expect, it } from 'vitest'
import { reviveWeight, weightOf, weightText } from '../shared/pm/weight'
import { validateTemplate, type Template } from '../shared/pm/workflow'
import { company, wherdr } from '../shared/pm/examples'

it('weight: the task\'s own first, then its type\'s, then its steps (screenshots heavy, no code light, else standard)', () => {
  const typed: Template = { ...wherdr, taskTypes: { ...wherdr.taskTypes, study: { ...wherdr.taskTypes.study!, weight: 'heavy' } } }
  expect(weightOf(typed, { type: 'visual', weight: 'light' })).toEqual({ weight: 'light', from: 'task' })
  expect(weightOf(typed, { type: 'study' })).toEqual({ weight: 'heavy', from: 'type' })
  expect(weightOf(wherdr, { type: 'visual' })).toEqual({ weight: 'heavy', from: 'screenshots' })
  expect(weightOf(wherdr, { type: 'study' })).toEqual({ weight: 'light', from: 'no code' })
  expect(weightOf(wherdr, { type: 'simple' })).toEqual({ weight: 'standard', from: 'steps' })
  expect(weightOf(company, { type: 'feature' })).toEqual({ weight: 'standard', from: 'steps' })
  expect(weightOf(null, { type: 'gone' })).toEqual({ weight: 'standard', from: 'steps' })
  expect(weightText(weightOf(wherdr, { type: 'visual' }))).toBe('heavy (screenshots)')
})

it('a task type\'s weight is one of the classes', () => {
  const bad = { ...company, taskTypes: { feature: { ...company.taskTypes.feature!, weight: 'huge' } } }
  expect(validateTemplate(bad)).toEqual([{ path: 'taskTypes.feature.weight', message: 'must be one of light, standard, heavy' }])
  expect(validateTemplate({ ...bad, taskTypes: { feature: { ...company.taskTypes.feature!, weight: 'light' } } })).toEqual([])
})

it('a worker started again is weighed by its step: heavy only while the step still lacks its screenshots', () => {
  const shots = { id: 'build', text: '', evidence: ['screenshots' as const] }, merge = { id: 'merge', text: '' }
  expect(reviveWeight('heavy', merge, {})).toBe('standard')
  expect(reviveWeight('heavy', shots, {})).toBe('heavy')
  expect(reviveWeight('heavy', shots, { build: [{ phase: 'after', file: 'a.png', at: 0 }] })).toBe('standard')
  expect(reviveWeight('light', merge, undefined)).toBe('light')
})
