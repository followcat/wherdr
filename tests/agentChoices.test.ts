import { describe, expect, it } from 'vitest'
import { moveAgent, offeredAgents, orderAgents, readAgentOrder, readHiddenAgents, selectedAgentKind, visibleAgentKinds } from '../app/utils/agentChoices'

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

  it('keeps the choice while it is offered, else the first one (the default)', () => {
    expect(selectedAgentKind('kimi', ['claude', 'codex', 'shell'])).toBe('claude')
    expect(selectedAgentKind('codex', ['claude', 'codex', 'shell'])).toBe('codex')
    expect(selectedAgentKind('', ['omp', 'claude', 'shell'])).toBe('omp')
    expect(selectedAgentKind('', [])).toBe('shell')
  })

  it('orders the installed programs as the user did, new ones after in install order', () => {
    expect(orderAgents(['claude', 'codex', 'omp', 'kimi', 'shell'], ['omp', 'codex'])).toEqual(['omp', 'codex', 'claude', 'kimi'])
    // An ordered program not installed here takes no place.
    expect(orderAgents(['claude', 'codex'], ['gemini', 'codex'])).toEqual(['codex', 'claude'])
    expect(orderAgents(['codex', 'codex', 'claude'], [])).toEqual(['codex', 'claude'])
  })

  it('offers the ordered programs minus the hidden ones: the first is the default, Terminal last', () => {
    expect(offeredAgents(['claude', 'codex', 'omp'], ['omp'], ['omp', 'codex'])).toEqual(['codex', 'claude'])
    expect(offeredAgents(['claude', 'codex', 'omp'], ['claude', 'codex', 'omp'])).toEqual([])
    expect(visibleAgentKinds(['claude', 'omp'], [], ['omp'])).toEqual(['omp', 'claude', 'shell'])
  })

  it('moves a program, keeping the place of those not shown now', () => {
    const list = ['claude', 'codex', 'omp']
    expect(moveAgent(list, [], 2, 0)).toEqual(['omp', 'claude', 'codex'])
    expect(moveAgent(list, ['kimi'], 0, 1)).toEqual(['codex', 'claude', 'omp', 'kimi'])
    expect(moveAgent(list, ['codex'], 0, 3)).toEqual(['codex'])
    expect(moveAgent(list, ['codex'], 1, 1)).toEqual(['codex'])
    expect(readAgentOrder('["omp","shell",1]')).toEqual(['omp'])
  })

  it('ignores malformed preferences and never hides Terminal', () => {
    expect(readHiddenAgents('{')).toEqual([])
    expect(readHiddenAgents('["kimi","kimi","shell",4]')).toEqual(['kimi'])
  })

})
