import { expect, it } from 'vitest'
import { devinMenuOpen, devinModelSetEcho, devinStatusModel, devinStatusPair, parseDevinFusion, parseDevinModelMenu } from '../server/utils/devinMenu'

// Live capture (wA:p1, Devin v3000.11.x): /model opens a searchable picker.
const MENU = `
─────────────────────────────────────────────────────────────────────────
/ SWE-2
─────────────────────────────────────────────────────────────────────────
  Adaptive
  Fusion                                                ◼◼◼◼◼    Max            Lead Claude Opus 5.5 ▾ Sidekick SWE-2 ▾
  Recently Used
❭ SWE-2                                               ✱   ← ◼◼◼    → Max            Fast Mode Off
  Claude Opus 5.5                                       ◼◼◼◼◼    Medium          Fast Mode Off
  Recommended
  Claude Fable 5.1                                      ◼◼◼◼◼    Medium
  GPT-6                                                  ◼◼◼◼◼    Low             Fast Mode Off
  ↓ more below
↑↓ select · ←→ reasoning effort · ↵ confirm · alt+↵ this session only · esc cancel
`

const CONFIRMED = `
  Some transcript line
  ✓ Model set to Grok 4.7 for this session
  ❭
─────────────────────────────────────────────────────────────────────────
`

it('parses the Devin /model menu: options, cursor, search', () => {
  const m = parseDevinModelMenu(MENU)
  expect(m).not.toBeNull()
  expect(m!.search).toBe('SWE-2')
  const labels = m!.options.map(o => o.label)
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
  expect(m!.options[m!.cursor]!.label).toBe('SWE-2')
  expect(m!.options[0]!.n).toBe(1)
})

it('rejects screens without the legend', () => {
  expect(parseDevinModelMenu(CONFIRMED)).toBeNull()
  expect(parseDevinModelMenu('')).toBeNull()
  expect(parseDevinModelMenu(null)).toBeNull()
  // Legend alone is not enough — options must parse.
  expect(parseDevinModelMenu('↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel')).toBeNull()
})

it('reads the alt+↵ confirmation echo', () => {
  expect(devinModelSetEcho(CONFIRMED)).toBe('Grok 4.7')
  expect(devinModelSetEcho('✓ Model set to SWE-2 for this session')).toBe('SWE-2')
  expect(devinModelSetEcho('Model set to X globally')).toBeNull()
})

it('keeps Thinking/1M-Context rows and reports a missing cursor as -1', () => {
  const m = parseDevinModelMenu(`
  Claude Opus 4.6                                  Thinking On      1M Context Off
  Claude Opus 4.7                                  ◼◼◼◼◼    Medium
↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
`)
  expect(m!.options.map(o => o.label)).toEqual(['Claude Opus 4.6', 'Claude Opus 4.7'])
  expect(m!.options[0]!.hint).toContain('Thinking On')
  expect(m!.cursor).toBe(-1) // no ❭ marker — callers must refuse to move
})

it('devinMenuOpen tracks the legend even with zero parsed options', () => {
  const empty = `
/ no-such-model
────────────────────────────────────────
↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
`
  expect(devinMenuOpen(empty)).toBe(true)
  expect(parseDevinModelMenu(empty)).toBeNull()
  expect(devinMenuOpen(CONFIRMED)).toBe(false)
})

// Live captures: the status line under the composer names the session's model —
// "SWE-2 Max · bypass", and under Fusion "Fusion · <lead> ◆ <sidekick> · bypass".
const IDLE = `
 ⏺ ~/work
─────────────────────────────────────────────────────────────────────────
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
`

it('reads the session model from the status line, Fusion included', () => {
  expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass                                             Context: 145k / 262k tokens (55%)`)).toBe('SWE-2 Max')
  expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass · 3 shells ↓                                 51k / 262k`)).toBe('SWE-2 Max')
  expect(devinStatusModel(`${IDLE}SWE-2 Max · bypass                                             ctrl+o details · alt+t thinking`)).toBe('SWE-2 Max')
  expect(devinStatusModel(`${IDLE}Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass                      See usage and cost: /session-stats`)).toBe('Fusion')
  expect(devinStatusModel(`${IDLE}Fusion · Claude Opus 5.5 ◆ SWE-2 · bypass                       Press Ctrl+L to clear the screen`)).toBe('Fusion')
  expect(devinStatusModel(`${IDLE}GPT-6 Astra Medium · accept edits`)).toBe('GPT-6 Astra Medium')
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

// Live captures: the Fusion row carries "Lead X ▾  Sidekick Y ▾"; tab on the
// row cycles effort → Lead → Sidekick → Fast Mode, and an open dropdown shows
// its entries with "▸" on the pick and "*" on the default.
const FUSION_EFFORT = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                  ← ◼◼◼◼◼  → Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M
↑↓ select · tab lead · ←→ effort · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc cancel
`

const FUSION_LEAD_OPEN = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                    ◼◼◼◼◼    Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off
                                                   Claude Opus 5.5
                                                 ▸ GPT-6.1 Sol
                                                   Claude Fable 5.1
                                                   GPT-6 Astra
                                                   GPT-6 Sol
                                                   GPT-5.6 Sol
                                                   Claude Opus 5
                                                   Claude Sonnet 5.5

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M
↑↓ select · tab sidekick · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc collapse
`

const FUSION_SIDEKICK_OPEN = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                    ◼◼◼◼◼    Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off
                                                                           SWE-2 Medium *
                                                                         ▸ SWE-2 High
                                                                           GPT-6 Luna High
                                                                           GPT-6.1 Terra High
                                                                           GPT-5.6 Luna High
                                                                           GPT-5.6 Sol High
                                                                           GLM-5.2 High
                                                                           Claude Sonnet 5.5 Medium

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M
↑↓ select · tab fast mode · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc collapse
`

it('parseDevinFusion: effort focus shows the pair and no dropdown', () => {
  const st = parseDevinFusion(FUSION_EFFORT)
  expect(st).toMatchObject({ lead: 'GPT-6.1 Sol', sidekick: 'SWE-2 High', focus: 'effort', dropdown: null })
})

it('parseDevinFusion: the Lead dropdown, its entries, cursor and default', () => {
  const st = parseDevinFusion(FUSION_LEAD_OPEN)
  expect(st!.focus).toBe('lead')
  expect(st!.dropdown!.which).toBe('lead')
  const d = st!.dropdown!
  expect(d.options.map(o => o.label)).toEqual([
    'Claude Opus 5.5', 'GPT-6.1 Sol', 'Claude Fable 5.1', 'GPT-6 Astra',
    'GPT-6 Sol', 'GPT-5.6 Sol', 'Claude Opus 5', 'Claude Sonnet 5.5',
  ])
  expect(d.options[d.cursor]!.label).toBe('GPT-6.1 Sol')
  // The pending pick and the pair stay on the row above the entries.
  expect(st!.lead).toBe('GPT-6.1 Sol')
  expect(st!.sidekick).toBe('SWE-2 High')
})

it('parseDevinFusion: the Sidekick dropdown marks the default with *', () => {
  const st = parseDevinFusion(FUSION_SIDEKICK_OPEN)
  expect(st!.focus).toBe('sidekick')
  const d = st!.dropdown!
  expect(d.which).toBe('sidekick')
  expect(d.options.map(o => o.label)).toEqual([
    'SWE-2 Medium', 'SWE-2 High', 'GPT-6 Luna High', 'GPT-6.1 Terra High',
    'GPT-5.6 Luna High', 'GPT-5.6 Sol High', 'GLM-5.2 High', 'Claude Sonnet 5.5 Medium',
  ])
  expect(d.options[d.cursor]!.label).toBe('SWE-2 High')
  expect(d.options.filter(o => o.def).map(o => o.label)).toEqual(['SWE-2 Medium'])
})

it('parseDevinFusion: fast mode focus, a truncated pair field, no claim without a legend', () => {
  const fast = parseDevinFusion(FUSION_EFFORT.replace('tab lead · ←→ effort', 'tab effort · ←→ fast mode'))
  expect(fast!.focus).toBe('fast')
  expect(fast!.dropdown).toBeNull()
  // The row truncates a long pick ("GPT-6 Luna H…") — reported as shown.
  const trunc = parseDevinFusion(FUSION_EFFORT.replace('Sidekick SWE-2 High', 'Sidekick GPT-6 Luna H…'))
  expect(trunc!.sidekick).toBe('GPT-6 Luna H…')
  // The Fusion row is read even when the cursor sits on another row — but
  // with no "esc collapse" legend there is no dropdown claim.
  expect(parseDevinFusion(MENU)).toMatchObject({ lead: 'Claude Opus 5.5', sidekick: 'SWE-2', dropdown: null })
  expect(parseDevinFusion('')).toBeNull()
  expect(parseDevinFusion(null)).toBeNull()
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
