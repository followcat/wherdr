import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { devinMenuOpen, devinModelSetEcho, devinStatusModel, devinStatusPair, parseDevinFusion, parseDevinModelMenu } from '../server/utils/devinMenu'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
// The captures these fixtures hold are quoted in server/utils/devinMenu.ts.
const MENU = fx('devin-menu.txt')
const CONFIRMED = fx('devin-confirmed.txt')
const IDLE = fx('devin-composer.txt')

describe('Devin /model menu', () => {
  it('parses the Devin /model menu: options, cursor, search', () => {
    const m = parseDevinModelMenu(MENU)!
    expect(m).not.toBeNull()
    expect(m.search).toBe('SWE-2')
    const labels = m.options.map(o => o.label)
    expect(labels).toContain('SWE-2')
    expect(labels).toContain('Claude Opus 5.5')
    expect(labels).toContain('Claude Fable 5.1')
    expect(labels).toContain('GPT-6')
    expect(labels).toContain('Fusion')
    expect(labels).toContain('Adaptive')
    // Section labels and the "more below" marker are not options.
    expect(labels).not.toContain('Recently Used')
    expect(labels).not.toContain('Recommended')
    expect(labels).not.toContain('↓ more below')
    expect(m.options[m.cursor]!.label).toBe('SWE-2')
    expect(m.options[0]!.n).toBe(1)
  })

  it('reads an empty search field and skips the pricing block of the Fusion row', () => {
    expect(devinMenuOpen(fx('devin-menu-mini.txt'))).toBe(true)
    const m = parseDevinModelMenu(fx('devin-menu-mini.txt'))!
    expect(m.search).toBe('')
    expect(m.options.map(o => o.label)).toEqual(['SWE-2', 'Grok 4.7'])
    expect(m.cursor).toBe(1)
    const f = parseDevinModelMenu(fx('devin-fusion-effort.txt'))!
    expect(f.search).toBe('Fusion')
    expect(f.options).toHaveLength(1)
    expect(f.options[0]!.label).toBe('Fusion')
    expect(f.options[0]!.hint).toContain('Lead GPT-6.1 Sol')
    expect(f.cursor).toBe(0)
  })

  it('rejects screens without the legend', () => {
    expect(parseDevinModelMenu(CONFIRMED)).toBeNull()
    expect(parseDevinModelMenu('')).toBeNull()
    expect(parseDevinModelMenu(null)).toBeNull()
    // Legend alone is not enough — options must parse.
    expect(parseDevinModelMenu('↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel')).toBeNull()
  })

  it('keeps Thinking/1M-Context rows and reports a missing cursor as -1', () => {
    const m = parseDevinModelMenu(fx('devin-menu-nocursor.txt'))!
    expect(m.options.map(o => o.label)).toEqual(['Claude Opus 4.6', 'Claude Opus 4.7'])
    expect(m.options[0]!.hint).toContain('Thinking On')
    expect(m.cursor).toBe(-1) // no ❭ marker — callers must refuse to move
  })

  it('devinMenuOpen tracks the legend even with zero parsed options', () => {
    const empty = fx('devin-menu-empty.txt')
    expect(devinMenuOpen(empty)).toBe(true)
    expect(parseDevinModelMenu(empty)).toBeNull()
    expect(devinMenuOpen(CONFIRMED)).toBe(false)
    expect(devinMenuOpen('no picker here')).toBe(false)
  })
})

describe('Devin status line and echo', () => {
  it('reads the session model from the status line, Fusion included', () => {
    expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass                                             Context: 145k / 262k tokens (55%)`)).toBe('SWE-2 Max')
    expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass · 3 shells ↓                                 51k / 262k`)).toBe('SWE-2 Max')
    expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass                                             ctrl+o details · alt+t thinking`)).toBe('SWE-2 Max')
    expect(devinStatusModel(`${IDLE}Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass                      See usage and cost: /session-stats`)).toBe('Fusion')
    expect(devinStatusModel(`${IDLE}Fusion · Claude Opus 5.5 ◆ SWE-2 · bypass                       Press Ctrl+L to clear the screen`)).toBe('Fusion')
    expect(devinStatusModel(`${IDLE}GPT-6 Astra Medium · accept edits`)).toBe('GPT-6 Astra Medium')
    expect(devinStatusModel(fx('devin-idle.txt'))).toBeNull()
  })
  it('ignores lines that are not the status line', () => {
    expect(devinStatusModel('')).toBeNull()
    expect(devinStatusModel(null)).toBeNull()
    // The /model legend and the set echo are not a status line.
    expect(devinStatusModel(MENU)).toBeNull()
    expect(devinStatusModel(CONFIRMED)).toBeNull()
    // A "· <mode>" tail inside the conversation does not count: only the last
    // few lines are scanned, and a model name starts with a letter or digit.
    expect(devinStatusModel(`some reply\nlet's enable · bypass\n${IDLE}SWE-2 Max · bypass`)).toBe('SWE-2 Max')
    expect(devinStatusModel(`❭ draft · bypass\nlast output line`)).toBeNull()
  })
  it('devinStatusPair reads the applied "Lead ◆ Sidekick" from the status line', () => {
    expect(devinStatusPair(`${IDLE}Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass                      See usage and cost: /session-stats`))
      .toEqual({ lead: 'GPT-6.1 Sol', sidekick: 'SWE-2 High' })
    expect(devinStatusPair(`${IDLE}Fusion · Claude Opus 5.5 ◆ GPT-6 Luna High · bypass            ctrl+o details`))
      .toEqual({ lead: 'Claude Opus 5.5', sidekick: 'GPT-6 Luna High' })
    // A real status line without Fusion is not a pair.
    expect(devinStatusPair(`${IDLE}SWE-2 Max · bypass                                             Context: 145k / 262k`)).toBeNull()
    expect(devinStatusPair(MENU)).toBeNull()
    expect(devinStatusPair('')).toBeNull()
  })
  it('reads the "Model set to … for this session" echo — the latest one', () => {
    expect(devinModelSetEcho(CONFIRMED)).toBe('Grok 4.7')
    expect(devinModelSetEcho('✓ Model set to SWE-2 for this session')).toBe('SWE-2')
    expect(devinModelSetEcho('✓ Model set to Grok 4.7 for this session\n✓ Model set to SWE-2 for this session')).toBe('SWE-2')
    expect(devinModelSetEcho('Model set to Grok 4.7 for all sessions')).toBeNull()
    expect(devinModelSetEcho(null)).toBeNull()
  })
})

describe('Devin Fusion Lead/Sidekick dropdowns', () => {
  it('effort focus shows the pair and no dropdown', () => {
    const st = parseDevinFusion(fx('devin-fusion-effort.txt'))
    expect(st).toMatchObject({ lead: 'GPT-6.1 Sol', sidekick: 'SWE-2 High', focus: 'effort', dropdown: null })
  })
  it('the Lead dropdown, its entries, cursor and default', () => {
    const st = parseDevinFusion(fx('devin-fusion-lead.txt'))!
    expect(st.focus).toBe('lead')
    expect(st.dropdown!.which).toBe('lead')
    const d = st.dropdown!
    expect(d.options.map(o => o.label)).toEqual([
      'Claude Opus 5.5', 'GPT-6.1 Sol', 'Claude Fable 5.1', 'GPT-6 Astra',
      'GPT-6 Sol', 'GPT-5.6 Sol', 'Claude Opus 5', 'Claude Sonnet 5.5',
    ])
    expect(d.options[d.cursor]!.label).toBe('GPT-6.1 Sol')
    // The pending pick and the pair stay on the row above the entries.
    expect(st.lead).toBe('GPT-6.1 Sol')
    expect(st.sidekick).toBe('SWE-2 High')
  })
  it('the Sidekick dropdown marks the default with *', () => {
    const st = parseDevinFusion(fx('devin-fusion-sidekick.txt'))!
    expect(st.focus).toBe('sidekick')
    const d = st.dropdown!
    expect(d.which).toBe('sidekick')
    expect(d.options.map(o => o.label)).toEqual([
      'SWE-2 Medium', 'SWE-2 High', 'GPT-6 Luna High', 'GPT-6.1 Terra High',
      'GPT-5.6 Luna High', 'GPT-5.6 Sol High', 'GLM-5.2 High', 'Claude Sonnet 5.5 Medium',
    ])
    expect(d.options[d.cursor]!.label).toBe('SWE-2 High')
    expect(d.options.filter(o => o.def).map(o => o.label)).toEqual(['SWE-2 Medium'])
  })
  it('fast mode focus, a truncated pair field, no claim without a legend', () => {
    const effort = fx('devin-fusion-effort.txt')
    const fast = parseDevinFusion(effort.replace('tab lead · ←→ effort', 'tab effort · ←→ fast mode'))
    expect(fast!.focus).toBe('fast')
    expect(fast!.dropdown).toBeNull()
    // The row truncates a long pick ("GPT-6 Luna H…") — reported as shown.
    const trunc = parseDevinFusion(effort.replace('Sidekick SWE-2 High', 'Sidekick GPT-6 Luna H…'))
    expect(trunc!.sidekick).toBe('GPT-6 Luna H…')
    // The Fusion row is read even when the cursor sits on another row — but
    // with no "esc collapse" legend there is no dropdown claim.
    expect(parseDevinFusion(MENU)).toMatchObject({ lead: 'Claude Opus 5.5', sidekick: 'SWE-2', dropdown: null })
    expect(parseDevinFusion('')).toBeNull()
    expect(parseDevinFusion(null)).toBeNull()
  })
  it('entries overlaid on menu rows are read at the box column', () => {
    const st = parseDevinFusion(fx('devin-fusion-lead-overlay.txt'))!
    expect(st.dropdown!.which).toBe('lead')
    const d = st.dropdown!
    expect(d.options.map(o => o.label)).toEqual([
      'Claude Opus 5.5', 'GPT-6.1 Sol', 'Claude Fable 5.1', 'GPT-6 Astra',
      'GPT-6 Sol', 'GPT-5.6 Sol', 'Claude Opus 5', 'Claude Sonnet 5.5',
    ])
    expect(d.options[d.cursor]!.label).toBe('GPT-6.1 Sol')

    const side = parseDevinFusion(fx('devin-fusion-sidekick-overlay.txt'))!.dropdown!
    expect(side.which).toBe('sidekick')
    expect(side.options.map(o => o.label)).toEqual([
      'SWE-2 Medium', 'SWE-2 High', 'GPT-6 Luna High', 'GPT-6.1 Terra High',
      'GPT-5.6 Luna High', 'GPT-5.6 Sol High', 'GLM-5.2 High',
      'Claude Sonnet 5.5 Medium', 'Claude Haiku 5.5 Medium',
    ])
    expect(side.options[side.cursor]!.label).toBe('SWE-2 High')
    expect(side.options.filter(o => o.def).map(o => o.label)).toEqual(['SWE-2 Medium'])
  })
})
