import type { ModelInfo, ModelOption } from '#shared/types'

// Claude sometimes shows "Opus (1M)" while its description gives
// "Opus 5.5 with 1M context" and the transcript "Opus 5.5 (1M)".
const key = (value: string) => value.toLowerCase()
  .replace(/\bwith 1m context\b/g, '(1m)')
  .replace(/\b1m context\b/g, '1m')
  .replace(/\s*\((?:default|current)\)/g, '')
  .replace(/\s+/g, ' ').trim()

export function modelOptionCurrent(option: ModelOption, model: ModelInfo | null | undefined): boolean {
  if (!model) return false
  // omp: the options are the raw ids ("anthropic/claude-opus-5-5"), the
  // state carries the same id — compare it before the labels.
  if (model.id && option.label.includes('/')) return option.label === model.id
  const wanted = key(model.label)
  if (key(option.label) === wanted) return true
  const hintName = option.hint?.split('·')[0]?.trim() || ''
  return Boolean(hintName) && key(hintName) === wanted
}

export function currentModelOption(options: ModelOption[], model: ModelInfo | null | undefined): number {
  // Prefer the explicit name over "Default (recommended)" when both
  // point to the same model. Only check a single row.
  const explicit = options.findIndex(o => !/^default\b/i.test(o.label) && modelOptionCurrent(o, model))
  return explicit >= 0 ? explicit : options.findIndex(o => modelOptionCurrent(o, model))
}
