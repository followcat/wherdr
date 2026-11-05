import { describe, expect, it } from 'vitest'
import { validateTaskInput, validateTemplate, type Template } from '../shared/pm/workflow'
import { combineGuards, mayMerge } from '../shared/pm/guards'

const template = (): Template => ({
  id: 'pr-flow',
  guards: { protected: ['main'], merge: { protected: 'user', others: 'engine' } },
  instructions: 'Commit small, clear commits.',
  steps: { review: { id: 'review', column: 'Review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', rounds: 2 } },
  taskTypes: {
    simple: {
      steps: [
        { id: 'todo', column: 'To do' },
        { id: 'work', column: 'Working', holder: 'worker', ends: 'report', instructions: 'Run the quick check.' },
        { id: 'pr', column: 'Review', ends: 'action', action: { kind: 'github.pr', base: 'dev' } },
        'review',
        { id: 'merge', column: 'Review', holder: 'none', ends: 'user', userLabel: 'Merged', badge: 'Merge the PR', action: { kind: 'git.verify-merged', target: 'dev' } },
        { id: 'deploy', holder: 'coordinator', ends: 'report', recheck: '5m', timeout: '90m' },
        { id: 'done', column: 'Done' },
      ],
    },
    split: {
      childType: 'simple',
      steps: [{ id: 'split', holder: 'worker', ends: 'report', evidence: ['proposed-tasks'] }, { id: 'done' }],
    },
  },
})

const paths = (errs: { path: string }[]) => errs.map(e => e.path)

describe('validateTemplate', () => {
  it('accepts a well-formed template', () => {
    expect(validateTemplate(template())).toEqual([])
  })

  it('points at each field at fault', () => {
    const t = template() as any
    const steps = t.taskTypes.simple.steps
    steps[1].holder = 'robot'
    steps[2].action = { kind: 'github.pr' }
    steps[5].recheck = 'soon'
    steps.push({ id: 'again', holder: 'reviewer', ends: 'verdict', sendBack: 'later', rounds: 0 })
    steps.push({ id: 'todo' })
    t.taskTypes.split.childType = 'nope'
    t.extra = 1
    expect(paths(validateTemplate(t))).toEqual([
      'extra',
      'taskTypes.simple.steps[1].holder',
      'taskTypes.simple.steps[2].action.base',
      'taskTypes.simple.steps[5].recheck',
      'taskTypes.simple.steps[7].sendBack',
      'taskTypes.simple.steps[7].rounds',
      'taskTypes.simple.steps[8].id',
      'taskTypes.split.childType',
    ])
  })

  it('checks a shared step against the task type that reuses it', () => {
    const t = template()
    t.taskTypes.simple.steps.splice(1, 1) // remove "work", the review's sendBack
    expect(validateTemplate(t)).toEqual([{ path: 'taskTypes.simple.steps[2]', message: 'sendBack "work" is not an earlier step here' }])
    t.taskTypes.simple.steps.push('missing')
    expect(paths(validateTemplate(t))).toContain('taskTypes.simple.steps[6]')
  })

  it('does not take object built-ins for steps or task types', () => {
    const t = { id: 'x', taskTypes: { a: { childType: 'constructor', steps: ['toString', { id: 'w', holder: 'worker', ends: 'report' }] } } }
    expect(paths(validateTemplate(t))).toEqual(['taskTypes.a.childType', 'taskTypes.a.steps[0]'])
  })

  it('needs at least one task type', () => {
    expect(paths(validateTemplate({ id: 'x', taskTypes: {} }))).toEqual(['taskTypes'])
  })
})

describe('validateTaskInput', () => {
  it('lets a task add instructions and a timeout', () => {
    expect(validateTaskInput({ type: 'simple', instructions: 'Also update the docs.', steps: { work: { instructions: 'x', timeout: '2h' } } })).toEqual([])
  })

  it('refuses a task that changes rounds, sendBack or the holder', () => {
    const errs = validateTaskInput({ type: 'simple', steps: { review: { rounds: 5, sendBack: 'todo', holder: 'none' } } })
    expect(paths(errs)).toEqual(['steps.review.rounds', 'steps.review.sendBack', 'steps.review.holder'])
    expect(errs[0]!.message).toMatch(/edit the template/)
  })
})

describe('combineGuards', () => {
  const project = template().guards

  it('keeps the defaults when nobody sets a guard', () => {
    const g = combineGuards([])
    expect(g.merge.protected).toEqual({ value: 'user', source: 'builtin' })
    expect(g.merge.others).toEqual({ value: 'engine', source: 'builtin' })
  })

  it('lets a task harden the guards but never loosen them', () => {
    const g = combineGuards([
      { source: 'task', guards: { protected: [], merge: { protected: 'engine', others: 'user' } } },
      { source: 'project', guards: project },
      { source: 'task-type', guards: { protected: ['release'] } },
    ])
    expect(g.protected).toEqual([{ value: 'main', source: 'project' }, { value: 'release', source: 'task-type' }])
    expect(g.merge.protected).toEqual({ value: 'user', source: 'project' })
    expect(g.merge.others).toEqual({ value: 'user', source: 'task' })
    expect(mayMerge(g, 'main', 'engine')).toBe(false)
    expect(mayMerge(g, 'feature', 'engine')).toBe(false)
    expect(mayMerge(g, 'main', 'user')).toBe(true)
  })

  it('keeps the default when only a task type or a task speaks', () => {
    for (const source of ['task', 'task-type'] as const) {
      const g = combineGuards([
        { source, guards: { merge: { protected: 'engine', others: 'user' } } },
        { source: 'project', guards: { protected: ['main'] } },
      ])
      expect(g.merge.protected).toEqual({ value: 'user', source: 'builtin' })
      expect(g.merge.others).toEqual({ value: 'user', source })
      expect(mayMerge(g, 'main', 'engine')).toBe(false)
    }
  })

  it('lets the user and the project choose, the stricter of the two winning', () => {
    const vibe = combineGuards([{ source: 'project', guards: { merge: { protected: 'engine' } } }])
    expect(mayMerge(vibe, 'main', 'engine')).toBe(true) // nothing protected
    const g = combineGuards([
      { source: 'user', guards: { protected: ['main'], merge: { others: 'user' } } },
      { source: 'project', guards: { protected: ['dev'], merge: { others: 'engine' } } },
    ])
    expect(g.merge.others).toEqual({ value: 'user', source: 'user' })
    expect(g.protected.map(p => p.value)).toEqual(['main', 'dev'])
  })
})
