import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { devinMenuOpen, devinModelSetEcho, devinStatusModel, devinStatusPair, parseDevinFusion, parseDevinModelMenu } from '../server/utils/devinMenu'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const FUSION_STATUS = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass                        See usage and cost: /session-stats
`
const FUSION_STATUS_LUNA = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
Fusion · Claude Opus 5.5 ◆ GPT-6 Luna High · bypass               See usage and cost: /session-stats
`
const PLAIN_STATUS = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
SWE-2 Max · bypass · 3 shells ↓                                   ctrl+o details · alt+t thinking
`

describe('Devin status line and echo', () => {
  it('reads the session model — "Fusion" itself under Fusion', () => {
    expect(devinStatusModel(FUSION_STATUS)).toBe('Fusion')
    expect(devinStatusModel(PLAIN_STATUS)).toBe('SWE-2 Max')
    expect(devinStatusModel('a screen without a status line')).toBeNull()
    expect(devinStatusModel(fx('devin-idle.txt'))).toBeNull()
    expect(devinStatusModel(null)).toBeNull()
  })
  it('reads the Lead ◆ Sidekick pair under Fusion', () => {
    expect(devinStatusPair(FUSION_STATUS)).toEqual({ lead: 'GPT-6.1 Sol', sidekick: 'SWE-2 High' })
    expect(devinStatusPair(FUSION_STATUS_LUNA)).toEqual({ lead: 'Claude Opus 5.5', sidekick: 'GPT-6 Luna High' })
    expect(devinStatusPair(PLAIN_STATUS)).toBeNull()
  })
  it('reads the "Model set to … for this session" echo — the latest one', () => {
    expect(devinModelSetEcho('✓ Model set to Grok 4.7 for this session')).toBe('Grok 4.7')
    expect(devinModelSetEcho('✓ Model set to Grok 4.7 for this session\n✓ Model set to SWE-2 for this session')).toBe('SWE-2')
    expect(devinModelSetEcho('Model set to Grok 4.7 for all sessions')).toBeNull()
    expect(devinModelSetEcho(null)).toBeNull()
  })
})

// Live captures (server/utils/devinMenu.ts header shows the layout).
const DEVIN_MENU = `
──────────────────────────────────────────
/
──────────────────────────────────────────
  SWE-2                                                ← ◼◼◼    → Max            Fast Mode Off
❭ Grok 4.7                                             ← ◼◼◼◼   → Medium          Fast Mode Off
↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
`
const FUSION_MENU = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                  ← ◼◼◼◼◼  → Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M

  ✱ New  ✱ Promotion  ✱ Beta  ✱ Use your ChatGPT plan  · Pairs frontier intelligence with cost-efficient execution
↑↓ select · tab lead · ←→ effort · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc cancel
`
const LEAD_OPEN = `
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
const SIDE_OPEN = `
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

describe('Devin /model menu', () => {
  it('stays open on the legend even with zero options, parses rows and cursor', () => {
    expect(devinMenuOpen(DEVIN_MENU)).toBe(true)
    expect(devinMenuOpen('no picker here')).toBe(false)
    const m = parseDevinModelMenu(DEVIN_MENU)!
    expect(m.search).toBe('')
    expect(m.options.map(o => o.label)).toEqual(['SWE-2', 'Grok 4.7'])
    expect(m.cursor).toBe(1)
  })
  it('reads the search field and skips the pricing block of the Fusion row', () => {
    const m = parseDevinModelMenu(FUSION_MENU)!
    expect(m.search).toBe('Fusion')
    expect(m.options).toHaveLength(1)
    expect(m.options[0]!.label).toBe('Fusion')
    expect(m.options[0]!.hint).toContain('Lead GPT-6.1 Sol')
    expect(m.cursor).toBe(0)
  })
  it('refuses a screen without the legend', () => {
    expect(parseDevinModelMenu(DEVIN_MENU.replace(/↑↓ select.*esc cancel/, ''))).toBeNull()
    expect(parseDevinModelMenu(null)).toBeNull()
  })
})

describe('Devin Fusion Lead/Sidekick dropdowns', () => {
  it('reads focus, the pair fields and the open Lead dropdown', () => {
    const f = parseDevinFusion(LEAD_OPEN)!
    expect(f.focus).toBe('lead')
    expect(f.lead).toBe('GPT-6.1 Sol')
    expect(f.sidekick).toBe('SWE-2 High')
    expect(f.dropdown?.which).toBe('lead')
    expect(f.dropdown?.options.map(o => o.label)).toEqual([
      'Claude Opus 5.5', 'GPT-6.1 Sol', 'Claude Fable 5.1', 'GPT-6 Astra',
      'GPT-6 Sol', 'GPT-5.6 Sol', 'Claude Opus 5', 'Claude Sonnet 5.5',
    ])
    expect(f.dropdown?.options[1]).toMatchObject({ here: true })
    expect(f.dropdown?.cursor).toBe(1)
  })
  it('reads the Sidekick dropdown, its default mark and truncation state', () => {
    const f = parseDevinFusion(SIDE_OPEN)!
    expect(f.focus).toBe('sidekick')
    expect(f.dropdown?.which).toBe('sidekick')
    expect(f.dropdown?.options[0]).toMatchObject({ label: 'SWE-2 Medium', def: true })
    expect(f.dropdown?.options[1]).toMatchObject({ label: 'SWE-2 High', here: true })
    expect(f.dropdown?.cursor).toBe(1)
  })
  it('closed menu means no Fusion state', () => {
    expect(parseDevinFusion(DEVIN_MENU)).toBeNull()
    expect(parseDevinFusion('nothing')).toBeNull()
  })
})
