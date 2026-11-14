import { describe, expect, it, vi } from 'vitest'
import { CoreError } from '../server/utils/core'
import { coreAddMachine, coreForgetMachine, coreRenameMachine, coreStatus, coreCreate, sendFirstMessage, sendAfterDialog, coreIsGit, coreListDirs, type CoreAdminDeps } from '../server/utils/coreCreate'
import type { MachineInfo, Pane, Workspace } from '../shared/types'
import core16 from './fixtures/core-0.1.16.json'
import core17 from './fixtures/core-0.1.17.json'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const machines: MachineInfo[] = [
  { key: '', label: 'Local', local: true, status: 'online', error: null },
  { key: '7667', label: 'vps', local: false, status: 'online', error: null },
  { key: '6f66', label: 'off', local: false, status: 'offline', error: null },
]
let workspaces: Workspace[] = []
function setup(reply: (method: string, params: any) => unknown = () => ({})) {
  const calls: [string, any][] = []
  const deps: CoreAdminDeps = {
    call: async (method, params) => {
      calls.push([method, params])
      const r = method === 'machine.exec' ? execReply(params) : reply(method, params)
      if (r instanceof Error) throw r
      return r as never
    },
    machines: () => machines,
    panes: () => [{ id: 'w1:p1', workspace: 'w1', coreAddress: 'vps/t7' } as Pane, { id: 'w2:p2', workspace: 'w2', coreAddress: 't3' } as Pane],
    workspaces: () => workspaces,
    settle: async () => {},
    recent: async () => [],
    remember: async () => {},
    launchWatchMs: 0,
  }
  const execReply = (params: any) => {
    const script: string = params.argv[2]
    if (script.includes('$HOME"') && script.startsWith('printf')) return { code: 0, stdout: b64('/home/u') }
    if (script.startsWith('test -d')) return { code: params.argv[4] === '/home/u/missing' ? 1 : 0, stdout: '' }
    if (script.startsWith('test -e')) return { code: 0, stdout: '' }
    if (script.includes('command -v')) return { code: 0, stdout: b64('claude\ncodex\n') }
    return { code: 0, stdout: b64('g api\nd docs\n') }
  }
  return { deps, calls, runs: () => calls.filter(c => c[0] === 'terminal.run') }
}

describe('core creation', () => {
  it('labels a new terminal for herdr-app: a new tab of the space holding the folder', async () => {
    workspaces = [{ id: 'ws1', label: 'App', coreSpace: 'spapp', path: '/home/u/app', number: 1, status: null, worktree: false },
      { id: 'ws2', label: 'x', path: '/home/u/app/deep', number: 2, status: null, worktree: false }]
    const t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u/app/src' })
    const l = t.runs()[0]![1].labels
    expect(l['herdr.space']).toBe('spapp')
    expect(l['herdr.tab']).toMatch(/^tb[0-9a-f]{32}$/)
    expect(l['herdr.seen']).toBe('0')
  })
  it('puts a "new tab" in the space it was asked for, and in a new space when no folder matches', async () => {
    workspaces = [{ id: 'ws1', label: 'App', coreSpace: 'spapp', path: '/elsewhere', number: 1, status: null, worktree: false },
      { id: 'ws2', label: 'Dir', path: '/home/u', number: 2, status: null, worktree: false }]
    let t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u', workspace: 'ws1' })
    expect(t.runs()[0]![1].labels['herdr.space']).toBe('spapp')
    t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u' })
    expect(t.runs()[0]![1].labels['herdr.space']).toMatch(/^sp[0-9a-f]{32}$/)
    // A folder-grouped workspace: no herdr label, the terminal stays beside the others.
    t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u', workspace: 'ws2' })
    expect(Object.keys(t.runs()[0]![1].labels)).toEqual(['wherdr-request'])
  })

  it('reports an agent that exits with an error right away, with its last output', async () => {
    const t = setup((method) => {
      if (method === 'terminal.run') return { address: 't3' }
      if (method === 'terminal.get') return { state: 'finished', exit_code: 127 }
      if (method === 'terminal.read') return { text: 'one\n\nclaude: command not found\n' }
      return {}
    })
    await expect(coreCreate(t.deps, { kind: 'claude', cwd: '/home/u' })).rejects.toMatchObject({
      code: 'launch_failed', message: 'claude stopped right after starting (exit code 127). Last output:\none\nclaude: command not found',
    })
  })
  it('does not call a clean exit a failure', async () => {
    const t = setup((method) => method === 'terminal.run' ? { address: 't3' } : method === 'terminal.get' ? { state: 'finished', exit_code: 0 } : {})
    expect(await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u' })).toMatchObject({ pane_id: 'w2:p2' })
  })
  it('runs a terminal without parent, with a correlation label, on a machine', async () => {
    const t = setup(() => ({ address: 'vps/t7' }))
    const r = await coreCreate(t.deps, { kind: 'shell', machine: '7667', cwd: '/home/u/app', name: 'My Shell' })
    const p = t.runs()[0]![1]
    expect(p).toMatchObject({ cwd: '/home/u/app', on: 'vps', name: 'my-shell', no_parent: true, wait: false })
    expect(p.line).toBeUndefined()
    expect(p.labels['wherdr-request']).toMatch(/^[0-9a-f]{16}$/)
    expect(r).toMatchObject({ pane_id: 'w1:p1', workspace_id: 'w1', name: null })
  })
  it('starts an installed agent CLI through the machine shell, not an uninstalled one', async () => {
    const t = setup(() => ({ address: 't3' }))
    expect(await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u' })).toMatchObject({ pane_id: 'w2:p2', name: 'claude' })
    expect(t.runs()[0]![1].line).toMatch(/exec claude$/)
    expect(t.runs()[0]![1].on).toBeUndefined()
    await expect(coreCreate(t.deps, { kind: 'gemini', cwd: '/home/u' })).rejects.toMatchObject({ code: 'not_installed' })
    expect(t.runs()).toHaveLength(1)
  })
  it('refuses a bad kind, offline machine, outside or missing folder before running anything', async () => {
    const t = setup()
    await expect(coreCreate(t.deps, { kind: 'rm -rf' })).rejects.toMatchObject({ code: 'bad_kind' })
    await expect(coreCreate(t.deps, { kind: 'shell', machine: '6f66' })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(coreCreate(t.deps, { kind: 'shell', machine: 'zz' })).rejects.toMatchObject({ code: 'bad_machine' })
    await expect(coreCreate(t.deps, { kind: 'shell', cwd: '/etc' })).rejects.toMatchObject({ code: 'bad_cwd' })
    await expect(coreCreate(t.deps, { kind: 'shell', cwd: '/home/u/missing' })).rejects.toMatchObject({ code: 'bad_cwd' })
    expect(t.runs()).toHaveLength(0)
  })
  it('reconciles a lost answer by label and never runs twice', async () => {
    let label = ''
    const t = setup((method, params) => {
      if (method === 'terminal.run') { label = params.labels['wherdr-request']; return new CoreError('timeout', 'x') }
      return { terminals: [{ address: 't3', labels: { 'wherdr-request': label } }] }
    })
    expect(await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u' })).toMatchObject({ pane_id: 'w2:p2' })
    expect(t.runs()).toHaveLength(1)
    const lost = setup((method) => method === 'terminal.run' ? new CoreError('timeout', 'x') : { terminals: [] })
    await expect(coreCreate(lost.deps, { kind: 'shell', cwd: '/home/u' })).rejects.toMatchObject({ code: 'uncertain' })
    expect(lost.runs()).toHaveLength(1)
  })
  it('maps core refusals', async () => {
    const t = setup(() => new CoreError('name_taken', 'x'))
    await expect(coreCreate(t.deps, { kind: 'shell', cwd: '/home/u', name: 'a' })).rejects.toMatchObject({ code: 'name_taken' })
  })
  it('lists and checks folders through machine.exec, under home only', async () => {
    const t = setup()
    const l = await coreListDirs(t.deps, null, '7667')
    expect(l).toMatchObject({ path: '/home/u', home: '/home/u', parent: null })
    expect(l.dirs.map(d => d.name)).toEqual(['api', 'docs'])
    expect(t.calls.find(c => c[0] === 'machine.exec' && c[1].on)).toBeTruthy()
    await expect(coreListDirs(t.deps, '/etc', '')).rejects.toMatchObject({ code: 'bad_path' })
    expect(await coreIsGit(t.deps, '/home/u/api', '')).toEqual({ git: true })
    expect(await coreIsGit(t.deps, '/etc', '')).toEqual({ git: false })
  })
  it('adds a machine by SSH target only, never as an option', async () => {
    const t = setup()
    await coreAddMachine(t.deps, { target: 'me@10.0.0.7:2222', name: 'box' })
    expect(t.calls.at(-1)).toEqual(['machine.add', { target: 'me@10.0.0.7:2222', name: 'box' }])
    for (const target of ['-oProxyCommand=x', '', 'a b', 'x;y']) await expect(coreAddMachine(t.deps, { target })).rejects.toMatchObject({ code: 'bad_target' })
    await expect(coreAddMachine(t.deps, { target: 'x', name: 'Bad Name' })).rejects.toMatchObject({ code: 'bad_name' })
    const taken = setup(() => new CoreError('already_added', 'x'))
    await expect(coreAddMachine(taken.deps, { target: 'vps' })).rejects.toMatchObject({ code: 'already_added' })
  })
  it('refuses host:port when rpc.discover shows the core takes no port (recorded 0.1.16 and 0.1.17)', async () => {
    // Same version string either way: only the discover document decides.
    const old = setup(m => m === 'rpc.discover' ? core16.discover : { version: '9.9.9' })
    await expect(coreAddMachine(old.deps, { target: 'me@10.0.0.7:2222' })).rejects.toMatchObject({ code: 'port_unsupported' })
    expect(old.calls.some(([m]) => m === 'machine.add')).toBe(false)
    // Without a port, the old core still adds it, with no capability read.
    await coreAddMachine(old.deps, { target: 'me@10.0.0.7' })
    expect(old.calls.slice(-1)).toEqual([['machine.add', { target: 'me@10.0.0.7' }]])
    const current = setup(m => m === 'rpc.discover' ? core17.discover : { version: '0.0.1' })
    await coreAddMachine(current.deps, { target: 'me@[::1]:2222' })
    expect(current.calls.map(([m]) => m)).toEqual(['rpc.discover', 'machine.add'])
    // Discover unreadable: machine.add answers for itself.
    const unknown = setup(m => m === 'rpc.discover' ? new CoreError('timeout', 'x') : {})
    await coreAddMachine(unknown.deps, { target: 'me@10.0.0.7:2222' })
    expect(unknown.calls.at(-1)![0]).toBe('machine.add')
  })
  it('renames a machine by its listed name and maps a taken name', async () => {
    const t = setup()
    await coreRenameMachine(t.deps, { key: '7667', name: 'box' })
    expect(t.calls.at(-1)).toEqual(['machine.rename', { machine: 'vps', new_name: 'box' }])
    await expect(coreRenameMachine(t.deps, { key: '7667', name: 'Bad Name' })).rejects.toMatchObject({ code: 'bad_name' })
    await expect(coreRenameMachine(t.deps, { key: '', name: 'box' })).rejects.toMatchObject({ code: 'bad_machine' })
    const taken = setup(() => new CoreError('name_taken', 'x'))
    await expect(coreRenameMachine(taken.deps, { key: '7667', name: 'off' })).rejects.toMatchObject({ code: 'name_taken' })
  })
  it('forgets a remote machine only and reports the core status', async () => {
    const t = setup(m => m === 'server.status' ? { version: '0.1.17', pid: 4, uptime_ms: 5000, live: 2, finished: 0, core: { name: 'me' } } : {})
    await coreForgetMachine(t.deps, '7667')
    expect(t.calls.at(-1)).toEqual(['machine.rm', { machine: 'vps' }])
    await expect(coreForgetMachine(t.deps, '')).rejects.toMatchObject({ code: 'bad_machine' })
    expect(await coreStatus(t.deps)).toEqual({ version: '0.1.17', pid: 4, uptimeMs: 5000, live: 2, finished: 0, name: 'me', hostPort: null })
    const withDiscover = (discover: unknown) => setup(m => m === 'server.status' ? { version: '0.1.17', pid: 4, uptime_ms: 5000, live: 2, finished: 0 } : m === 'rpc.discover' ? discover : {})
    expect((await coreStatus(withDiscover(core17.discover).deps) as { hostPort: unknown }).hostPort).toBe(true)
    expect((await coreStatus(withDiscover(core16.discover).deps) as { hostPort: unknown }).hostPort).toBe(false)
  })
})

describe('resume and first message', () => {
  const idle = (extra: object = {}) => (method: string) => method === 'terminal.run' ? { address: 't3' }
    : method === 'terminal.get' ? { state: 'live', status: { app: 'x', state: 'idle' } } : method === 'terminal.read' ? { text: '> ' } : extra
  it('resumes through the CLI argv, only for the agents that have one and only when asked', async () => {
    let t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u', resume: true })
    expect(t.runs()[0]![1].line).toMatch(/exec claude --continue$/)
    t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'codex', cwd: '/home/u', resume: true })
    // Codex: its update check off, and a line that keeps the terminal when an update ends it.
    expect(t.runs()[0]![1].line).toContain(`'codex' '-c' 'check_for_update_on_startup=false' 'resume' '--last'; s=$?;`)
    t = setup(() => ({ address: 't3' }))
    await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u' })
    expect(t.runs()[0]![1].line).toMatch(/exec claude$/)
  })
  it('sends the first message once, after the answer, when the agent is idle', async () => {
    const t = setup(idle())
    const r = await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u', prompt: '  hello  ' })
    expect(r.first_message).toBe('sent')
    expect(t.calls.filter(c => c[0] === 'terminal.send')).toEqual([['terminal.send', { terminal: 't3', text: 'hello' }]])
  })
  it('never types into a blocked program, a dialog or a finished terminal', async () => {
    for (const [reply, out] of [[{ state: 'live', status: { state: 'blocked' } }, 'dialog'], [{ state: 'finished' }, 'skipped']] as const) {
      const t = setup(() => ({}))
      expect(await sendFirstMessage({ ...t.deps, call: async (m) => (m === 'terminal.get' ? reply : { text: '> ' }) as never, pollMs: 1, readyWatchMs: 50 }, 't3', 'x')).toBe(out)
    }
    const t = setup(idle())
    const deps = { ...t.deps, call: (async (m: string, p: object) => { t.calls.push([m, p]); return m === 'terminal.read' ? { text: 'Yes, I trust this folder\nEnter to confirm' } : { state: 'live', status: 'idle' } }) as never, pollMs: 1, readyWatchMs: 50 }
    expect(await sendFirstMessage(deps, 't3', 'x')).toBe('dialog')
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })
  it('reports a first message that was not typed', async () => {
    const t = setup((m: string) => m === 'terminal.run' ? { address: 't3' } : m === 'terminal.get' ? { state: 'live' } : m === 'terminal.read' ? { text: '› 1. Trust and continue\n  2. Back\n  enter continue · esc back' } : {})
    const r = await coreCreate({ ...t.deps, pollMs: 1, readyWatchMs: 50 }, { kind: 'codex', cwd: '/home/u', prompt: 'hi' })
    expect(r.first_message).toBe('queued')
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })
  it('holds the first message of a Codex that installs or updates itself, like any message, never typed', async () => {
    const t = setup((m: string) => m === 'terminal.run' ? { address: 't3' } : m === 'terminal.get' ? { state: 'live', title: 'Installing Codex', status: { state: 'idle' } } : m === 'terminal.read' ? { text: '> ' } : {})
    const held: string[] = []
    const r = await coreCreate({ ...t.deps, pollMs: 1, readyWatchMs: 50, hold: (p, text) => { held.push(`${p.coreAddress} ${text}`); return { id: 'held-1', text, state: 'held' } }, handOver: () => {} }, { kind: 'codex', cwd: '/home/u', prompt: 'Hi' })
    expect(r).toMatchObject({ first_message: 'queued', queued: { id: 'held-1', text: 'Hi', state: 'held' } })
    expect(held).toEqual(['t3 Hi'])
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })
  it('holds a Codex first message behind a dialog, and hands it to the queue when Codex then installs', async () => {
    let installing = false
    const t = setup(m => m === 'terminal.run' ? { address: 't3' } : m === 'terminal.get' ? { state: 'live', title: installing ? 'Installing Codex' : null, status: null } : m === 'terminal.read' ? { text: 'Yes, I trust this folder\nEnter to confirm' } : {})
    const log: string[] = []
    let watch: Promise<unknown> = Promise.resolve()
    const r = await coreCreate({
      ...t.deps, pollMs: 1, readyWatchMs: 50, queueWatchMs: 2000, onQueued: (w) => { watch = w },
      hold: (p, text, byHolder) => { log.push(`hold ${text} ${byHolder}`); return { id: 'held-1', text, state: 'held' } },
      handOver: (a, id, typed) => { log.push(`handOver ${a} ${id} ${typed}`) },
    }, { kind: 'codex', cwd: '/home/u', prompt: 'Hi' })
    expect(r).toMatchObject({ first_message: 'queued', queued: { id: 'held-1' } })
    installing = true
    await watch
    expect(log).toEqual(['hold Hi true', 'handOver t3 held-1 false'])
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })
  it('sends a queued first message once the trust dialog has been answered', async () => {
    let answered = false
    const t = setup((m) => {
      if (m === 'terminal.run') return { address: 't3' }
      if (m === 'terminal.read') return { text: answered ? 'ready' : 'Yes, I trust this folder\nEnter to confirm' }
      if (m === 'terminal.get') return { state: 'live', status: answered ? { state: 'idle' } : null }
      return {}
    })
    const deps = { ...t.deps, pollMs: 1, readyWatchMs: 200, queueWatchMs: 2000 }
    let watch: Promise<unknown> = Promise.resolve()
    const r = await coreCreate({ ...deps, onQueued: (w) => { watch = w } }, { kind: 'claude', cwd: '/home/u', prompt: 'hello' })
    expect(r.first_message).toBe('queued')
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
    answered = true
    expect(await watch).toBe('sent')
    expect(t.calls.filter(c => c[0] === 'terminal.send')).toEqual([['terminal.send', { terminal: 't3', text: 'hello' }]])
  })
  it('gives up on a queued first message that is never answered', async () => {
    const t = setup()
    const deps = { ...t.deps, call: (async (m: string) => (m === 'terminal.read' ? { text: 'Enter to confirm' } : { state: 'live', status: null })) as never, pollMs: 1, readyWatchMs: 20, queueWatchMs: 30 }
    expect(await sendAfterDialog(deps, 't3', 'x')).toBe('skipped')
  })
  it('does not type into a Codex composer shown before its status exists', async () => {
    // Composer first, no status; the trust dialog replaces it a moment later.
    const t = setup()
    let n = 0
    const deps = { ...t.deps, call: (async (m: string, p: object) => { t.calls.push([m, p]); return m === 'terminal.read' ? { text: n++ < 3 ? '› Ask Codex to do anything' : '› 1. Trust and continue\n  enter continue · esc back' } : { state: 'live', status: null } }) as never, pollMs: 1, readyWatchMs: 200 }
    expect(await sendFirstMessage(deps, 't3', 'x')).toBe('dialog')
    expect(t.calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })
  it('waits for a stable screen when the program reports no status, and gives up at the deadline', async () => {
    const t = setup()
    let n = 0
    const deps = { ...t.deps, call: (async (m: string, p: object) => { t.calls.push([m, p]); return m === 'terminal.read' ? { text: n++ < 2 ? `boot ${n}` : 'ready' } : { state: 'live', status: null } }) as never, pollMs: 1, readyWatchMs: 2000 }
    expect(await sendFirstMessage(deps, 't3', 'x')).toBe('sent')
    expect(n).toBeGreaterThanOrEqual(7)
    let k = 0
    const busy = { ...deps, call: (async (m: string) => m === 'terminal.read' ? { text: String(k++) } : { state: 'live', status: null }) as never, readyWatchMs: 30 }
    expect(await sendFirstMessage(busy, 't3', 'x')).toBe('skipped')
  })
})
