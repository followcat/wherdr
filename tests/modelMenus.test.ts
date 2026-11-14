import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ompSelectorCaption, parseModelMenu, parseOmpSelector, switchConfirmKeys } from '../server/utils/modelMenus'
import { effortMatches, effortValue } from '../server/utils/models'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('Claude/Codex /model menu', () => {
  it('Claude: 10 visible options, scrolling, check mark, descriptions, effort, "s" confirmation', () => {
    const m = parseModelMenu(fx('claude-model-1.txt'))!
    expect(m.kind).toBe('model')
    expect(m.cursor).toBe(1)
    expect(m.options.map(o => o.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6'])
    expect(m.options[0]).toMatchObject({ current: true, hint: 'Sonnet 5 · Efficient for routine tasks' })
    expect(m.options[1]).toMatchObject({ current: false, hint: 'Most capable for ambitious work' })
    expect(m.scrollDown).toBe(true) // "↓ 10." and "… +1 model"
    expect(m.sessionKey).toBe(true)
    expect(m.enterSelects).toBe(false) // Enter = save as default: never
    expect(m.effort).toBe('high')
    expect(effortValue(m.effort || '')).toBe('high')
  })
  it('Claude: next page (↑ 2. … ❯ 11.)', () => {
    const m = parseModelMenu(fx('claude-model-2.txt'))!
    expect(m.cursor).toBe(11)
    expect(m.options[0]!.n).toBe(2)
    expect(m.options[m.options.length - 1]).toMatchObject({ n: 11, label: 'Sonnet 4.6' })
  })
  it('Codex: model (default, current), then effort', () => {
    const m = parseModelMenu(fx('codex-model-1.txt'))!
    expect(m.kind).toBe('model')
    expect(m.options.map(o => o.label)).toEqual(['GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5'])
    expect(m.options[0]!.isDefault).toBe(true)
    expect(m.options[1]!.current).toBe(true)
    expect(m.cursor).toBe(2)
    expect(m.scrollDown).toBe(false)
    expect(m.enterSelects).toBe(true)
    expect(m.sessionKey).toBe(false)

    const e = parseModelMenu(fx('codex-model-2.txt'))!
    expect(e.kind).toBe('effort')
    expect(e.options.map(o => o.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'More reasoning…'])
    expect(e.cursor).toBe(2)
    expect(e.sessionKey).toBe(true)
    expect(e.enterSelects).toBe(false)
    expect(effortMatches('Extra high', 'xhigh')).toBe(true)
    expect(effortMatches('Medium (default)', 'medium')).toBe(true)
  })
  it('no menu: idle screen, or menu closed', () => {
    expect(parseModelMenu(fx('claude-idle.txt'))).toBeNull()
    expect(parseModelMenu(fx('codex-idle.txt'))).toBeNull()
    expect(parseModelMenu(fx('codex-model-1.txt').replace('enter select · esc back', ''))).toBeNull()
  })
})

describe('Claude "Switch model?" confirmation', () => {
  it('answers only the exact requested model, and only that question', () => {
    const text = fx('claude-model-confirm.txt')
    expect(parseModelMenu(text)).toBeNull()
    expect(switchConfirmKeys(text, 'Sonnet 4.6')).toEqual(['enter'])
    // A different model's prompt refuses — answering would switch the wrong one.
    expect(switchConfirmKeys(text, 'Opus 5.5')).toBeNull()
    expect(switchConfirmKeys(fx('claude-ask.txt'), 'Sonnet 4.6')).toBeNull()
    expect(switchConfirmKeys(null, 'Sonnet 4.6')).toBeNull()
  })
})

describe('omp selector parsing', () => {
  it('reads the nerd-font symbol preset (omp 18.6) like the unicode one', () => {
    const s = parseOmpSelector(fx('omp-selector-nerd.txt'))!
    expect(s.task).toBe(false)
    expect(s.search).toBe('')
    expect(s.options.map(o => o.label)).toContain('anthropic/claude-sonnet-5-5')
    expect(s.options[s.cursor]).toMatchObject({ label: 'anthropic/claude-opus-5-5', current: true })
    expect(ompSelectorCaption(fx('omp-selector-nerd.txt'), 'anthropic/claude-opus-5-5')).toEqual({ name: 'Claude Opus 5.5', roles: ['current'] })
  })
  it('reads the models, the cursor, the search and the current mark', () => {
    const s = parseOmpSelector(fx('omp-selector.txt'))!
    expect(s.options.map(o => o.label)).toEqual([
      'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5-5',
      'anthropic/claude-sonnet-5', 'openrouter/z-ai/glm-5.3-flash', 'anthropic/claude-opus-5',
      'omlx/Qwen3.8-27B-8bit', 'opencode-zen/nemotron-3.5-lightning-free', 'nvidia/moonshotai/kimi-k3',
      'opencode-zen/nemotron-3-ultra-free',
    ])
    expect(s.cursor).toBe(0)
    expect(s.options[0]).toMatchObject({ current: true, hint: null })
    expect(s.options[1]).toMatchObject({ hint: 'context>200k' })
    expect(s.options[1]!.current).toBeFalsy()
    expect(s.options[6]).toMatchObject({ hint: 'context>262k' })
    expect(s.search).toBe('')
    expect(s.task).toBe(false)
  })
  it('reads the search field and the separator of a filtered list', () => {
    const s = parseOmpSelector(fx('omp-selector-search.txt'))!
    expect(s.search).toBe('glm')
    expect(s.separator).toBe(1)
    expect(s.options[0]!.label).toBe('openrouter/z-ai/glm-5.3-flash')
  })
  it('recognizes the Task-model variant and refuses other screens', () => {
    expect(parseOmpSelector(fx('omp-idle-footer.txt'))).toBeNull()
    expect(parseOmpSelector(fx('omp-ask-single.txt'))).toBeNull()
    expect(parseOmpSelector(fx('omp-models-panel.txt'))).toBeNull()
    // Task variant: same box, "Switch Task Model" title.
    const task = fx('omp-selector.txt').replace('╭─ Switch Model ', '╭─ Switch Task Model ')
      .replace('use for this session', 'use for Task subagents')
    expect(parseOmpSelector(task)?.task).toBe(true)
  })
  it('reads the caption omp itself gives, with the roles', () => {
    const t = fx('omp-selector.txt')
    expect(ompSelectorCaption(t, 'anthropic/claude-opus-5-5')).toEqual({
      name: 'Claude Opus 5.5',
      roles: ['current', 'default', 'slow', 'plan', 'designer'],
    })
    const s = parseOmpSelector(fx('omp-selector-search.txt'))!
    expect(ompSelectorCaption(fx('omp-selector-search.txt'), s.options[s.cursor].label)?.name).toBe('GLM 5.3 Flash')
    expect(ompSelectorCaption(t, 'anthropic/claude-sonnet-5-5')).toBeNull()
  })
  it('flags a selector cut by a narrow pane, footer included (omp 18.8, 38 columns)', () => {
    const s = parseOmpSelector(fx('omp-selector-narrow-nerd.txt'))!
    expect(s).toMatchObject({ truncated: true, width: 38, task: false })
    // Once widened, the same selector is complete.
    const w = parseOmpSelector(fx('omp-selector-wide-nerd.txt'))!
    expect(w.truncated).toBe(false)
    expect(w.options[w.cursor]).toMatchObject({ label: 'anthropic/claude-sonnet-4-5', current: true })
    expect(w.options.map(o => o.label)).toContain('anthropic/claude-opus-5-5')
  })
  it('reads the ascii symbol preset', () => {
    const t = fx('omp-selector-ascii.txt')
    const s = parseOmpSelector(t)!
    expect(s).toMatchObject({ truncated: false, task: false, search: '' })
    expect(s.options[s.cursor]).toMatchObject({ label: 'anthropic/claude-sonnet-4-5', current: true })
    expect(s.options).toHaveLength(21)
    // "[/]" marks a role the model does not hold.
    expect(ompSelectorCaption(t, 'anthropic/claude-sonnet-4-5')).toEqual({ name: 'Claude Sonnet 4.5', roles: ['current', 'default'] })
  })
})
