import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  claudeEffortCommand, claudeEffortLevels, claudeScreenEffort, claudeScreenModel,
  codexCachedEfforts, codexFooterModel, effortMatches, effortValue,
  learnOmpCycle, ompEffortLevels, ompScreenEffort, ompScreenModel,
  parseClaudeEffortScreen, parseClaudeEffortSlider, sameModel,
} from '../server/utils/models'
import { ompSelectorOnScreen } from '../shared/ompSelector'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('sameModel / effortValue / effortMatches', () => {
  it('compares labels without parenthesized variants', () => {
    expect(sameModel('Opus 5.5', 'opus 5.5 (1M)')).toBe(true)
    expect(sameModel('Opus 5.5', 'Sonnet 5')).toBe(false)
    expect(sameModel(null, 'x')).toBe(false)
  })
  it('normalizes effort words, "Extra high" included', () => {
    expect(effortValue('Medium (default)')).toBe('medium')
    expect(effortValue('Extra high')).toBe('xhigh')
    expect(effortValue('More reasoning…')).toBeNull()
    expect(effortMatches('Extra high', 'xhigh')).toBe(true)
    expect(effortMatches('Medium (default)', 'medium')).toBe(true)
    expect(effortMatches('Low', null)).toBe(false)
  })
})

describe('Claude effort levels and command', () => {
  it('offers efforts per model and builds a valid command', () => {
    expect(claudeEffortLevels('Opus 5.5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(claudeEffortLevels('Sonnet 4.6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(claudeEffortLevels('Opus 5.5 (1M)')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(claudeEffortLevels('Haiku 4.5')).toEqual([])
    expect(claudeEffortLevels('autre')).toEqual([])
    expect(claudeEffortCommand('max', 'Opus 5.5')).toBe('/effort')
    expect(claudeEffortCommand('ultracode', 'Opus 5.5')).toBe('/effort')
    expect(claudeEffortCommand('ultracode', 'Haiku 4.5')).toBeNull()
    expect(claudeEffortCommand('max', 'Haiku 4.5')).toBeNull()
    expect(claudeEffortCommand('high\n/clear', 'Opus 5.5')).toBeNull()
  })
})

describe('Claude /effort slider on screen', () => {
  it('reads the 2.1.283 ruler (▲ above the current label)', () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
    for (const level of ['low', 'medium', 'max', 'ultracode']) {
      expect(parseClaudeEffortScreen(fx(`claude-effort-${level}.txt`))).toEqual({ current: level, levels: all })
    }
  })
  it('ignores a closed slider and stays compatible with the old screen', () => {
    const text = fx('claude-effort-medium.txt')
    expect(parseClaudeEffortScreen(text.replace(/.*Esc to cancel.*\n?/, ''))).toBeNull()
    expect(parseClaudeEffortScreen(fx('claude-idle.txt'))).toBeNull()
    expect(parseClaudeEffortScreen('◐ Medium effort (default) ←/→ to adjust\nEnter to confirm · s to use this session only · Esc to cancel'))
      .toEqual({ current: 'medium', levels: [] })
    expect(parseClaudeEffortSlider('● High effort\ns to use this session only')).toBe('high')
    // Narrow screen: tight labels, ▲ between two words → the closest.
    const narrow = ' Effort\n  ───────────▲─┊──\n  low medium high xhigh max ultracode\n ←/→ · s for this session only · Esc'
    expect(parseClaudeEffortSlider(narrow)).toBe('high')
  })
})

describe('Claude model and effort on screen', () => {
  it('reads the current effort on the banner or the /effort output', () => {
    expect(claudeScreenEffort(fx('claude-effort-low.txt'))).toBe('medium')
    expect(claudeScreenEffort(' Opus 5.5 with low effort · Claude Pro')).toBe('low')
    expect(claudeScreenEffort('Opus 5.5 with medium effort\n⎿  Set effort level to low (for this session only)')).toBe('low')
    expect(claudeScreenEffort('nothing relevant')).toBeNull()
  })
  it('reads the model on the header of a new agent', () => {
    const head = (l: string) => ` ▐▛███▜▌   Claude Code v2.1.90\n▝▜█████▛▘  ${l}\n  ▘▘ ▝▝    ~/projets/demo\n\n────────\n❯ \n────────`
    expect(claudeScreenModel(head('Opus 5.5 with low effort · Claude Pro'))).toEqual({ id: null, label: 'Opus 5.5', effort: 'low', at: null })
    expect(claudeScreenModel(head('Sonnet 5 · Claude Max'))).toEqual({ id: null, label: 'Sonnet 5', effort: null, at: null })
    expect(claudeScreenModel(head('Fable 5.1 (1M context) with xhigh effort · Claude Max'))?.label).toBe('Fable 5.1 (1M)')
    expect(claudeScreenModel(head('Haiku 4.5 · API Usage Billing'))?.label).toBe('Haiku 4.5')
    // /model typed before the first message: the lowest wins.
    expect(claudeScreenModel(head('Opus 5.5 with low effort · Claude Pro') + '\n❯ /model\n  ⎿  Set model to Sonnet 5 for this session only')?.label).toBe('Sonnet 5')
    expect(claudeScreenModel('rien · Claude')).toBeNull()
    expect(claudeScreenModel(null)).toBeNull()
  })
})

describe('Codex model on screen', () => {
  it('reads a new Codex\'s model on its status line', () => {
    expect(codexFooterModel('\n› Write tests\n\n  GPT-5.6-Terra medium · ~/projets/demo')).toMatchObject({ label: 'GPT-5.6-Terra', effort: 'medium' })
    expect(codexFooterModel(fx('codex-idle.txt'))).toMatchObject({ label: 'GPT-6-Sol', effort: 'medium' })
    expect(codexFooterModel('a shell with no codex field')).toBeNull()
  })
  it('reads the levels the Codex catalog caches for the active model', () => {
    const json = JSON.stringify({ models: [{ slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }] }] })
    expect(codexCachedEfforts(json, 'GPT-6-Sol')).toEqual(['low', 'max', 'ultra'])
    expect(codexCachedEfforts('{bad json', 'x')).toEqual([])
  })
})

describe('omp thinking level on screen', () => {
  it('reads the compact glyph before the model name, in both status line layouts', () => {
    expect(ompScreenEffort(fx('omp-done.txt'), 'Opus 5.5')).toBe('low')
    expect(ompScreenEffort(fx('omp-idle-footer.txt'), 'Opus 5.5')).toBe('high')
    expect(ompScreenEffort(' π > ⟳ Opus 5.5 > 🗑 ~/demo > ▶─1%────', 'Opus 5.5')).toBe('auto')
    expect(ompScreenEffort(' π > ⦸ Opus 5.5 > 🗑 ~/demo > ▶─1%────', 'Opus 5.5')).toBe('off')
    expect(ompScreenEffort(' π > [xhi] Opus 5.5 > ~/demo ────', 'Opus 5.5')).toBe('xhigh')
  })
  it('reads the " · level" suffix when the compact display is off', () => {
    expect(ompScreenEffort(' π > ⬡ Opus 5.5 · ◑ med > 🗑 ~/demo ────', 'Opus 5.5')).toBe('medium')
    expect(ompScreenEffort(' π > ⬡ Opus 5.5 · [ ] off > ~/demo ────', 'Opus 5.5')).toBe('off')
  })
  it('needs the model name next to the glyph: no guess from the conversation or a selector', () => {
    expect(ompScreenEffort(' ◉ done, see above\n π > ⬡ Opus 5.5 > 🗑 ~/demo ────', 'Opus 5.5')).toBeNull()
    expect(ompScreenEffort(fx('omp-done.txt'), 'Sonnet 5')).toBeNull()
    expect(ompScreenEffort(fx('omp-selector.txt'), 'Opus 5.5')).toBeNull()
  })
})

describe('omp model on screen, without a transcript', () => {
  it('reads the model and the level from every status line layout', () => {
    expect(ompScreenModel(fx('omp-fresh-nerd.txt'))).toEqual({ id: null, label: 'Opus 5.5', effort: 'auto', at: null })
    expect(ompScreenModel(fx('omp-done.txt'))).toMatchObject({ label: 'Opus 5.5', effort: 'low' })
    expect(ompScreenModel(fx('omp-idle-footer.txt'))).toMatchObject({ label: 'Opus 5.5', effort: 'high' })
    expect(ompScreenModel(' π > [xhi] Glm 5.3 flash > ~/demo ────')).toMatchObject({ label: 'Glm 5.3 flash', effort: 'xhigh' })
  })
  it('ignores glyphs of the conversation, selectors, and a status line without a level', () => {
    expect(ompScreenModel(' ◉ done, see above\n π > ⬡ Opus 5.5 > 🗑 ~/demo ────')).toBeNull()
    expect(ompScreenModel(fx('omp-selector.txt'))).toBeNull()
  })
})

describe('omp ⇧⇥ cycle knowledge', () => {
  it('offers the common levels until presses show the model\'s own', () => {
    expect(ompEffortLevels(null)).toEqual(['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    // high → off skips xhigh and max; auto → minimal shows an extra level.
    const known = learnOmpCycle(null, ['high', 'off', 'auto', 'minimal'])
    expect(ompEffortLevels(known)).toEqual(['off', 'auto', 'minimal', 'low', 'medium', 'high'])
    // A later press that shows a level again restores it.
    expect(ompEffortLevels(learnOmpCycle(known, ['high', 'xhigh']))).toContain('xhigh')
  })
})

describe('omp selector recognition', () => {
  it('sees the boxed selector and refuses other screens', () => {
    expect(ompSelectorOnScreen(fx('omp-selector.txt'))).toBe(true)
    expect(ompSelectorOnScreen(fx('omp-idle-footer.txt'))).toBe(false)
    expect(ompSelectorOnScreen(fx('omp-ask-single.txt'))).toBe(false)
    // The "omp/models" panel (typed /model): a different picker, not ours.
    expect(ompSelectorOnScreen(fx('omp-models-panel.txt'))).toBe(false)
    expect(ompSelectorOnScreen('')).toBe(false)
    expect(ompSelectorOnScreen(null)).toBe(false)
  })
})

// Devin's status-line parsers have their own file (tests/devinMenu.test.ts).
