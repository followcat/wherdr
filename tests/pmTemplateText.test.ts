import { describe, expect, it } from 'vitest'
import { parseTemplateText, templateChanges } from '../shared/pm/templateText'
import { EXAMPLES, company } from '../shared/pm/examples'

const text = (t: unknown) => JSON.stringify(t, null, 2)

describe('template text', () => {
  it('reads every example back as it was', () => {
    for (const ex of EXAMPLES) expect(parseTemplateText(text(ex))).toEqual({ value: ex, template: ex, errors: [] })
  })

  it('gives the line of a JSON syntax error', () => {
    const src = '{\n  "id": "x",\n  "taskTypes": {\n    "a": { "steps": [ { "id": "w" }, ] }\n  }\n}'
    expect(parseTemplateText(src).errors).toEqual([{ line: 4, path: '', message: 'unexpected ]' }])
    expect(parseTemplateText('{ "id": "x" }\n}').errors[0]).toMatchObject({ line: 2, message: 'unexpected text after the end' })
    expect(parseTemplateText('{ id: 1 }').errors[0]).toMatchObject({ line: 1, message: 'expected a field name in double quotes' })
  })

  it('gives the line of the field at fault, or of its parent when the field is missing', () => {
    const bad = structuredClone(company)
    ;(bad.taskTypes.feature!.steps[1] as { holder: string }).holder = 'robot'
    delete (bad.taskTypes.feature!.steps[2] as { sendBack?: string }).sendBack
    const src = text(bad)
    const lineOf = (needle: string) => src.split('\n').findIndex(l => l.includes(needle)) + 1
    const { template, value, errors } = parseTemplateText(src)
    expect(template).toBeUndefined()
    expect(value).toEqual(bad) // the form still shows it
    expect(errors).toEqual([
      { line: lineOf('"robot"'), path: 'taskTypes.feature.steps[1].holder', message: 'must be one of worker, reviewer, coordinator, none' },
      { line: lineOf('"id": "review"') - 1, path: 'taskTypes.feature.steps[2].sendBack', message: 'must name an earlier step' },
    ])
  })

  it('keeps a "__proto__" field as a field, refused as unknown', () => {
    const { errors } = parseTemplateText('{ "id": "x", "__proto__": { "polluted": 1 }, "taskTypes": { "a": { "steps": ["w"] } } }')
    expect(errors.map(e => e.path)).toEqual(['__proto__', 'taskTypes.a.steps[0]'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('sums up what a save changed', () => {
    const next = structuredClone(company)
    const steps = next.taskTypes.feature!.steps as { id: string, instructions?: string }[]
    steps.splice(5, 1) // deploy
    steps[1]!.instructions = 'Run every test.'
    steps.push({ id: 'notify' })
    next.taskTypes.study = { steps: ['work'] }
    next.instructions = 'Base branch is main.'
    expect(templateChanges(null, company)).toEqual([])
    expect(templateChanges(company, structuredClone(company))).toEqual([])
    // A field written back at the end (the form) is not a change.
    const moved = structuredClone(company)
    const { holder, ...rest } = moved.taskTypes.feature!.steps[1] as { holder: string }
    moved.taskTypes.feature!.steps[1] = { ...rest, holder } as never
    expect(templateChanges(company, moved)).toEqual([])
    expect(templateChanges(company, next)).toEqual(['instructions', 'feature: + notify', 'feature: - deploy', 'feature.work', '+ study'])
  })
})
