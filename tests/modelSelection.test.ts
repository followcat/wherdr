import { describe, expect, it } from 'vitest'
import { currentModelOption, modelOptionCurrent } from '../app/utils/modelSelection'

describe('current model option', () => {
  it('recognizes Opus 5.5 (1M) from the Claude description and prefers the explicit row', () => {
    const options = [
      { label: 'Default (recommended)', hint: 'Opus 5.5 with 1M context · Best for everyday tasks' },
      { label: 'Opus (1M)', hint: 'Opus 5.5 with 1M context · Best for everyday tasks' },
      { label: 'Opus 5.5', hint: 'Most capable' },
    ]
    const model = { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', effort: 'medium' }
    expect(modelOptionCurrent(options[1]!, model)).toBe(true)
    expect(currentModelOption(options, model)).toBe(1)
    expect(modelOptionCurrent(options[2]!, model)).toBe(false)
  })

  it('recognizes a Codex model without a useful description', () => {
    const options = [{ label: 'GPT-6-Sol', hint: 'Workhorse model' }, { label: 'GPT-6-Luna', hint: null }]
    expect(currentModelOption(options, { id: 'gpt-6-sol', label: 'GPT-6-Sol', effort: 'high' })).toBe(0)
  })

  it('matches an omp row by its raw id before any label', () => {
    const options = [
      { label: 'anthropic/claude-haiku-4-5', hint: 'Haiku' },
      { label: 'anthropic/claude-opus-5-5', hint: 'Opus' },
    ]
    const model = { id: 'anthropic/claude-opus-5-5', label: 'Opus', effort: null }
    expect(currentModelOption(options, model)).toBe(1)
    // An id-shaped row matches by id only — the label never rescues a
    // different model that happens to share the row's text.
    expect(currentModelOption(options, { id: 'anthropic/other', label: 'anthropic/claude-haiku-4-5', effort: null })).toBe(-1)
  })

  it('falls back to the row hint when the label does not name the model', () => {
    const options = [
      { label: 'Balanced', hint: 'Sonnet 5 · everyday work' },
      { label: 'Deep', hint: 'Opus 5.5 · hardest problems' },
    ]
    expect(currentModelOption(options, { id: null, label: 'Opus 5.5', effort: null })).toBe(1)
    expect(currentModelOption(options, { id: null, label: 'Unheard 9', effort: null })).toBe(-1)
  })

  it('ignores "(current)" and "(default)" markers and normalizes spacing', () => {
    const options = [{ label: 'Sonnet 5  (current)', hint: null }, { label: 'Opus 5.5', hint: null }]
    expect(currentModelOption(options, { id: null, label: 'sonnet   5', effort: null })).toBe(0)
  })

  it('no model marks nothing', () => {
    const options = [{ label: 'Sonnet 5', hint: null }]
    expect(modelOptionCurrent(options[0]!, null)).toBe(false)
    expect(modelOptionCurrent(options[0]!, undefined)).toBe(false)
    expect(currentModelOption(options, null)).toBe(-1)
  })
})
