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

it('recognizes a Cline command when core supplies no agent field', () => {
  // The pane's foreground is `node …/bin/cline -i …`.
  const cline = { foreground: { argv: ['/opt/nvm/bin/node', '/opt/nvm/bin/cline', '-i', 'List the files'] } }
  expect(coreState([terminal('t1', cline)], []).panes[0]?.agent).toBe('cline')
  expect(coreState([terminal('t1', { argv: ['/opt/nvm/bin/cline', '-i', 'hello'] })], []).panes[0]?.agent).toBe('cline')
  // A script or a prompt that merely mentions the name is not Cline.
  for (const argv of [['vim', 'cline.txt'], ['bash', '-c', 'cline -i x'], ['node', 'scripts/cline.js']])
    expect(coreState([terminal('t1', { argv })], []).panes[0]?.agent, argv.join(' ')).toBeNull()
})

describe('Command Code in core terminals', () => {
  const agentOf = (extra: object) => coreState([terminal('t1', extra)], []).panes[0]?.agent

  it('reads a declared Command Code name, whatever its spelling', () => {
    for (const extra of [
      { agent: 'command-code' }, { agent: 'command_code' }, { agent: 'commandcode' }, { agent: 'cmd' }, { agent: 'cmdc' },
      { template: 'command-code' }, { template: 'command_code' }, { template: 'commandcode' }, { template: 'cmdc' },
      { status: { state: 'idle', app: 'command-code' } }, { status: { state: 'idle', app: 'commandcode' } },
      { status: { state: 'working', app: 'Command Code' } },
    ]) expect(agentOf(extra), JSON.stringify(extra)).toBe('cmd')
  })

  it('recognizes its launch argv and the package entrypoint', () => {
    for (const argv of [['cmdc', '--resume', 'session-a'], ['/usr/local/bin/commandcode'], ['/opt/bin/command-code'], ['npx', 'command-code'], ['bunx', 'command_code']])
      expect(agentOf({ argv }), argv.join(' ')).toBe('cmd')
    expect(agentOf({ foreground: { argv: ['cmdc'] }, argv: ['bash'] })).toBe('cmd')
    expect(agentOf({ argv: ['node', '/usr/lib/node_modules/command-code/dist/cli.mjs'] })).toBe('cmd')
    expect(agentOf({ argv: ['/opt/command-code/bin/cmd'] })).toBe('cmd')
  })

  it('never takes a bare cmd, nor a word that only mentions it, for the agent', () => {
    for (const extra of [
      { argv: ['cmd'] },
      { argv: ['cmd.exe'] },
      { argv: ['cmd.exe', '/c', 'dir'] },
      { argv: ['C:\\Windows\\system32\\cmd.exe', '/k'] },
      { argv: ['cmd', '/c', 'dir'] },
      { argv: ['/usr/bin/cmd'] },
      { argv: ['/bin/sh', '-c', 'cmd /c dir'] },
      { argv: ['vim', 'cmd'] },
      { argv: ['ls', 'cmd'] },
      { argv: ['node', 'build.js', 'cmd'] },
      { argv: ['sh', '-c', 'cmd'] },
      { argv: ['bash', '-c', 'cmdc --resume s-1'] },
      { argv: ['git', 'commit', '-m', 'mention commandcode'] },
      { argv: ['vim', 'cmdc.txt'] },
      { argv: ['ssh', 'host-a', 'commandcode'] },
    ]) expect(agentOf(extra), JSON.stringify(extra)).toBeNull()
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

it('masks credentials a terminal or document name carries', () => {
  const state = coreState([
    terminal('t1', { name: 'HTTPS_PROXY=http://user1:secre7@10.0.0.1:3128' }),
    terminal('t2', { title: 'postgres://alice:p%40ss@db.acme/app' }),
    terminal('t3', { name: 'git@github.com:acme/shop.git' }),
    terminal('t4', {}),
  ], [], {
    '': { spaces: [{ id: 's1', name: 'http://user1:secre7@proxy.local', folder: '/srv/app',
      tabs: [{ id: 'b1', name: 'socks5://u2:p2@10.0.0.2:1080', root: { terminal: 't4' } }] }] },
  })
  const [env, db, git, doc] = state.panes
  expect(env?.name).toBe('HTTPS_PROXY=http://…@10.0.0.1:3128')
  expect(env?.tabLabel).toBe('HTTPS_PROXY=http://…@10.0.0.1:3128')
  expect(db?.title).toBe('postgres://…@db.acme/app')
  expect(git?.name).toBe('git@github.com:acme/shop.git')
  // A terminal the herdr-app document places keeps the doc's space and
  // tab names — masked the same way.
  expect(doc?.tabLabel).toBe('socks5://…@10.0.0.2:1080')
  expect(state.workspaces.find(w => w.id === doc?.workspace)?.label).toBe('http://…@proxy.local')
})
