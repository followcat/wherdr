import { describe, expect, it } from 'vitest'
import { readHiddenAgents, selectedAgentKind, visibleAgentKinds } from '../app/utils/agentChoices'

describe('choix des agents', () => {
  it('offers all installed agents by default, and keeps Terminal', () => {
    expect(visibleAgentKinds(['claude', 'codex', 'kimi'], readHiddenAgents(null)))
      .toEqual(['claude', 'codex', 'kimi', 'shell'])
    expect(visibleAgentKinds(['claude', 'codex', 'kimi'], ['kimi']))
      .toEqual(['claude', 'codex', 'shell'])
  })

  it('crosses the setting with the installations of the chosen machine', () => {
    expect(visibleAgentKinds(['codex', 'kimi'], ['kimi'])).toEqual(['codex', 'shell'])
    expect(visibleAgentKinds(['kimi'], ['kimi'])).toEqual(['shell'])
    expect(visibleAgentKinds([], [])).toEqual(['shell'])
  })

  it('falls back to the first available kind when the choice disappears', () => {
    expect(selectedAgentKind('kimi', ['claude', 'codex', 'shell'], 'codex')).toBe('claude')
    expect(selectedAgentKind('codex', ['claude', 'codex', 'shell'])).toBe('codex')
    expect(selectedAgentKind('', ['claude', 'codex', 'shell'], 'codex')).toBe('codex')
  })

  it('ignores malformed preferences and never hides Terminal', () => {
    expect(readHiddenAgents('{')).toEqual([])
    expect(readHiddenAgents('["kimi","kimi","shell",4]')).toEqual(['kimi'])
  })

})
