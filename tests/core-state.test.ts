import { describe, expect, it } from 'vitest'
import { coreRowCounts, coreState } from '../shared/coreState'
import type { CoreTerminal } from '../shared/coreInventory'
const terminal = (address: string, extra = {}): CoreTerminal => ({ address, cwd: '/workspace/demo', state: 'live', ...extra })
describe('core state for the existing interface', () => {
  it('groups a cwd on its machine, preserves addresses and stable navigation IDs', () => {
    const terminals = [terminal('t1'), terminal('t2', { template: 'codex', status: { state: 'working' } }), terminal('host-a/t1')]
    const state = coreState(terminals, [{ name: 'host-a', state: 'connected' }])
    expect(state.workspaces).toHaveLength(2)
    expect(state.tabs).toHaveLength(3)
    expect(state.panes.map(p => [p.coreAddress, p.agent, p.status])).toEqual([
      ['t1', null, 'unknown'], ['t2', 'codex', 'working'], ['host-a/t1', null, 'unknown'],
    ])
    expect(coreState([...terminals].reverse(), []).panes.map(p => p.id).reverse()).toEqual(state.panes.map(p => p.id))
    expect(state.machines?.[1]?.status).toBe('online')
  })
  it('keeps a disconnected machine distinct from an agent status', () => {
    const state = coreState([terminal('host-a/t1', { status: { state: 'error', app: 'claude-code' } })], [{ name: 'host-a', state: 'unreachable' }])
    expect(state.panes[0]).toMatchObject({ agent: 'claude', status: 'blocked' })
    expect(state.machines?.[1]?.status).toBe('offline')
  })
})

it('groups every reported program by status and lifts mixed workspaces', async () => {
  const { spaceRows, rowGroup, tabStates } = await import('../shared/spaces')
  const state = coreState([
    terminal('t1', { cwd: '/workspace/delta', agent: 'delta-worker', status: { state: 'working' } }),
    terminal('t2', { cwd: '/workspace/beta', template: 'codex', status: { state: 'idle' } }),
    terminal('t3', { cwd: '/workspace/beta', status: { state: 'working' } }),
    terminal('t4', { cwd: '/workspace/gamma' }),
    terminal('t5', { cwd: '/workspace/epsilon', template: 'claude' }),
    terminal('t6', { cwd: '/workspace/alpha', status: { state: 'idle' } }),
    terminal('t7', { cwd: '/workspace/zeta', status: { state: 'blocked' } }),
  ], [])
  expect(state.panes[0]?.agent).toBe('delta-worker')
  const rows = spaceRows(state)
  expect(rows.map(rowGroup)).toEqual(['working', 'working', 'unknown', 'unknown', 'ready', 'blocked'])
  expect(coreRowCounts(rows)).toEqual({ working: 2, blocked: 1, ready: 3 })
  expect(rows[1]?.lead.coreAddress).toBe('t3')
  expect(tabStates(rows[1]!)).toEqual(['idle', 'working'])
})

it('lists three agents of one folder as three rows counted 1/1/1', async () => {
  const { spaceRows } = await import('../shared/spaces')
  const { individualAgentRows } = await import('../app/utils/homeAgentRows')
  const state = coreState([
    terminal('a1', { cwd: '/workspace/same', template: 'claude', status: { state: 'working' } }),
    terminal('a2', { cwd: '/workspace/same', template: 'claude', status: { state: 'blocked' } }),
    terminal('a3', { cwd: '/workspace/same', template: 'codex', status: { state: 'idle' } }),
  ], [])
  const rows = individualAgentRows(spaceRows(state))
  expect(rows).toHaveLength(3)
  expect(coreRowCounts(rows)).toEqual({ working: 1, blocked: 1, ready: 1 })
})

it('recognizes a Devin command when core supplies no agent field', () => {
  expect(coreState([terminal('t1', { argv: ['/opt/bin/devin', '-r', 'session-a'] })], []).panes[0]?.agent).toBe('devin')
})

describe('Command Code agent kind', () => {
  const agentOf = (extra = {}) => coreState([terminal('t1', extra)], []).panes[0]?.agent
  it('canonicalizes trusted Command Code aliases to cmd', () => {
    for (const extra of [
      { agent: 'command-code' }, { agent: 'command_code' }, { agent: 'commandcode' }, { agent: 'cmd' }, { agent: 'cmdc' },
      { template: 'command-code' }, { template: 'command_code' }, { template: 'commandcode' }, { template: 'cmdc' },
      { status: { state: 'idle', app: 'command-code' } }, { status: { state: 'idle', app: 'commandcode' } },
    ]) expect(agentOf(extra), JSON.stringify(extra)).toBe('cmd')
  })
  it('names Command Code by its launched program, never by an operand', () => {
    for (const argv of [['cmdc', '--resume', 's-1'], ['/usr/local/bin/commandcode'], ['/opt/bin/command-code'], ['npx', 'cmdc'], ['bunx', 'command_code']])
      expect(agentOf({ argv }), argv.join(' ')).toBe('cmd')
    expect(agentOf({ foreground: { argv: ['cmdc'] }, argv: ['bash'] })).toBe('cmd')
    for (const argv of [['bash', '-c', 'cmdc --resume s-1'], ['git', 'commit', '-m', 'mention commandcode'], ['vim', 'cmdc.txt'], ['ssh', 'host-a', 'commandcode']])
      expect(agentOf({ argv }), argv.join(' ')).toBeNull()
  })
  it('never takes Windows cmd or a bare cmd name for Command Code', () => {
    for (const argv of [['cmd'], ['cmd.exe', '/c', 'dir'], ['C:\\Windows\\system32\\cmd.exe', '/k']])
      expect(agentOf({ argv }), argv.join(' ')).toBeNull()
    expect(agentOf({ argv: ['/bin/sh', '-c', 'cmd /c dir'] })).toBeNull()
  })
  it('keeps an opaque declared agent kind exactly as core reported it', () => {
    for (const agent of ['acme/tool', 'vendor/command-code', 'delta-worker'])
      expect(agentOf({ agent }), agent).toBe(agent)
    expect(agentOf({ agent: 'command-code' })).toBe('cmd')
  })
  it('lets a declared kind win over an argv operand, and stays a transcript agent', async () => {
    expect(agentOf({ template: 'command-code', argv: ['tool', 'claude'] })).toBe('cmd')
    const { TRANSCRIPT_AGENTS } = await import('../shared/agentKind')
    expect(TRANSCRIPT_AGENTS).toContain('cmd')
  })
})

it('keeps a Codex stopped by its update as a Codex waiting for a restart, and tells an installing one', () => {
  const state = coreState([
    terminal('t1', { labels: { 'wherdr.codex-updated': '1' } }),
    terminal('t2', { template: 'codex', title: 'Installing Codex 0.167.0', status: { state: 'idle' } }),
    terminal('t3', { agent: 'codex', labels: { 'wherdr.codex-updated': '1' }, status: { state: 'idle' } }),
  ], [])
  expect(state.panes.map(p => [p.agent, p.status, p.stopped?.reason ?? null, p.installing ?? false])).toEqual([
    ['codex', 'blocked', 'update', false], ['codex', 'idle', null, true], ['codex', 'idle', null, false],
  ])
})
