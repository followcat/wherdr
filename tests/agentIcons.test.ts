import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { agentIcon, AGENT_ICON } from '../app/utils/agentIcons'

describe('agentIcon', () => {
  it('gives each brand agent its own logo', () => {
    expect(agentIcon('claude')).toBe('i-herdr-claude-code')
    expect(agentIcon('codex')).toBe('i-herdr-codex')
    expect(agentIcon('omp')).toBe('i-herdr-omp')
    expect(agentIcon('cmd')).toBe('i-lucide-square-terminal')
  })

  it('names Command Code like its transcript capability does', async () => {
    const { TRANSCRIPT_AGENTS, transcriptKind } = await import('../shared/agentKind')
    expect(TRANSCRIPT_AGENTS).toContain('cmd')
    expect(transcriptKind('/home/user/.commandcode/projects/a/s.jsonl')).toBe('cmd')
    expect(agentIcon('cmd')).toBeTruthy()
  })

  it('has no logo for unknown agents, terminals or inherited keys', () => {
    expect(agentIcon('qwen')).toBeNull()
    expect(agentIcon(null)).toBeNull()
    expect(agentIcon(undefined)).toBeNull()
    expect(agentIcon('toString')).toBeNull()
  })

  it('points every herdr icon at an SVG of the collection', () => {
    for (const name of Object.values(AGENT_ICON).filter(n => n.startsWith('i-herdr-')))
      expect(existsSync(`app/assets/icons/${name.slice('i-herdr-'.length)}.svg`), name).toBe(true)
  })
})
