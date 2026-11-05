import { describe, expect, it } from 'vitest'
import { paneAgentKind, transcriptKind } from '../shared/agentKind'
import { availableAgentKinds } from '../shared/launchableAgents'

const session = (agent: string) => ({ agent_session: { agent, kind: 'id', source: `herdr:${agent}`, value: 'x' } })

describe('paneAgentKind', () => {
  it('the process detected by Herdr wins', () => {
    expect(paneAgentKind({ agent: 'claude', ...session('claude') }, { agent: 'claude' })).toBe('claude')
    expect(paneAgentKind({ agent: 'codex' }, { agent: 'claude', ...session('claude') })).toBe('codex')
  })
  it('closed agent: the reported session rather than the launch kind', () => {
    expect(paneAgentKind({ agent_status: 'unknown' }, { agent: 'codex', ...session('claude') })).toBe('claude')
    expect(paneAgentKind({ ...session('claude') }, { agent: 'codex' })).toBe('claude')
  })
  it('without a session: the agents entry, otherwise nothing', () => {
    expect(paneAgentKind({}, { agent: 'codex' })).toBe('codex')
    expect(paneAgentKind({}, null)).toBeNull()
    expect(paneAgentKind({})).toBeNull()
  })
  it('keeps the Herdr kind of other agents', () => {
    expect(paneAgentKind({ agent: 'gemini', agent_status: 'working' }, { agent: 'codex' })).toBe('gemini')
    expect(paneAgentKind({ ...session('opencode') }, { agent: 'claude' })).toBe('opencode')
    expect(paneAgentKind({}, { agent: 'kimi' })).toBe('kimi')
  })
})

describe('availableAgentKinds', () => {
  it('only offers installed and allowed Herdr agents, in a stable order', () => {
    expect(availableAgentKinds(['kimi', 'claude', 'unknown', 'opencode', 'gemini'], ['claude', 'kimi', 'gemini']))
      .toEqual(['claude', 'gemini', 'kimi'])
    expect(availableAgentKinds([], ['claude'])).toEqual([])
  })
})

describe('transcriptKind', () => {
  it('recognizes the kind from the path', () => {
    expect(transcriptKind('/home/user/.claude/projects/-home-user-x/abc.jsonl')).toBe('claude')
    expect(transcriptKind('/Users/a/.codex/sessions/2026/09/26/rollout-x.jsonl')).toBe('codex')
    expect(transcriptKind('/Users/a/.omp/agent/sessions/-x/2026-09-30_abc.jsonl')).toBe('omp')
    expect(transcriptKind('/tmp/x.jsonl')).toBeNull()
  })
})

it('recognizes Devin transcripts and enables the shared conversation view', async () => {
  const { hasTranscript } = await import('../shared/agentKind')
  expect(hasTranscript('devin')).toBe(true)
  expect(transcriptKind('/home/user/.local/share/devin/cli/transcripts/session-a.json')).toBe('devin')
})
