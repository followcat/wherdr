import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { devinModelSetEcho, devinStatusModel, devinStatusPair } from '../server/utils/devinMenu'

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
