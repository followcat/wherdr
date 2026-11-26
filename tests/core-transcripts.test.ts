import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentChildren, agentDescendants, coreFailureKind, coreShell, createCoreTranscripts, machineHome, machineOfAddress, processInfo } from '../server/utils/coreTranscripts'
import { createShellFs, READ_CHUNK, type ExecResult, type ShellExec } from '../server/utils/fsx'
import { DEVIN_PROCESS_SCRIPT } from '../server/utils/devinProcesses'
import { CoreError } from '../server/utils/core'
import type { Pane } from '../shared/types'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const pane = (id: string, address: string, agent: string | null, cwd: string, extra: Partial<Pane> = {}) =>
  ({ id, coreAddress: address, agent, cwd, machine: '', agentSession: null, status: 'idle', ...extra }) as Pane
const SESSION = '11111111-2222-4333-8444-555555555555'
const CODEX_ID = '00000000-0000-4000-8000-00000000c0de'

// A "core" whose terminal.get answers from a table, and whose machine.exec really runs the command here.
function fakeCore(details: Record<string, object>) {
  const calls: string[] = []
  const call = async (method: string, params: any): Promise<any> => {
    calls.push(`${method} ${params.terminal || params.on || ''}`.trim())
    if (method === 'terminal.get') {
      if (!details[params.terminal]) throw new CoreError('not_found', 'x')
      return details[params.terminal]
    }
    if (method === 'machine.exec') {
      return await new Promise(resolve => execFile(params.argv[0], params.argv.slice(1), { encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, env: { ...process.env, HOME: process.env.FAKE_REMOTE_HOME } },
        (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: stdout.toString('base64'), stderr: stderr.toString('base64'), timed_out: false, truncated: false })))
    }
    throw new CoreError('rpc', method)
  }
  return { call, calls }
}

function homeWithTranscripts(cwd: string, pid: number) {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-core-home-'))
  mkdirSync(path.join(home, '.claude/sessions'), { recursive: true })
  writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, cwd }))
  const dir = path.join(home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), fx('claude-session.jsonl'))
  const now = new Date()
  const day = path.join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  const meta = JSON.parse(fx('codex-rollout.jsonl').split('\n')[0]!)
  meta.payload.cwd = cwd
  meta.payload.timestamp = new Date(Date.now() - 1000).toISOString()
  const rest = fx('codex-rollout.jsonl').split('\n').slice(1).join('\n')
  writeFileSync(path.join(day, `rollout-x-${CODEX_ID}.jsonl`), JSON.stringify(meta) + '\n' + rest)
  return home
}

describe('core terminal details as process information', () => {
  it('lists the foreground program first, then the terminal process', () => {
    expect(processInfo({ pid: 10, argv: ['bash'], foreground: { pid: 12, name: 'claude', argv: ['claude'] } }).process_info.foreground_processes.map(p => p.pid)).toEqual([12, 10])
    expect(processInfo({ pid: 10, argv: ['claude'], foreground: { pid: 10, name: 'claude', argv: ['claude'] } }).process_info.foreground_processes).toHaveLength(1)
    expect(processInfo({}).process_info.foreground_processes).toEqual([])
  })
  it('reads the machine of an address', () => {
    expect(machineOfAddress('t3')).toBe('')
    expect(machineOfAddress('mac/t3')).toBe('mac')
  })
})

describe('agents under a terminal', () => {
  it('finds an agent started by a shell, not other programs', () => {
    const ps = ' 10 1 -bash\n 11 10 /usr/bin/node /x/claude --resume\n 12 11 sleep 5\n 20 1 claude\n 30 10 vim a.txt\n'
    expect(agentDescendants(ps, 10).map(p => p.pid)).toEqual([11])
  })
})

describe('conversations of core terminals', () => {
  const cwd = '/work/proj'
  const home = homeWithTranscripts(cwd, 4242)
  const core = fakeCore({
    t1: { pid: 4242, argv: ['claude'], created_ms: Date.now(), foreground: { pid: 4242, name: 'claude', argv: ['claude'], cwd } },
    t2: { pid: 99, argv: ['codex'], created_ms: Date.now() - 2000, foreground: { pid: 99, name: 'codex', argv: ['codex'], cwd } },
  })
  const panes = [pane('p1', 't1', 'claude', cwd), pane('p2', 't2', 'codex', cwd), pane('p3', 't3', null, cwd)]
  const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: home })

  it('finds a Claude conversation from the terminal process', async () => {
    const r = await t.chat({ id: 'p1', agent: 'claude', cwd }, {})
    expect(r.available).toBe(true)
    expect(r.file).toBe(`${SESSION}.jsonl`)
    expect(r.items!.length).toBeGreaterThan(5)
    expect(core.calls).toContain('terminal.get t1')
  })

  it('finds a Codex conversation born with the terminal', async () => {
    const r = await t.chat({ id: 'p2', agent: 'codex', cwd }, {})
    expect(r.available).toBe(true)
    expect(r.file).toContain(CODEX_ID)
  })

  it('has no conversation for a Claude whose process left no session', async () => {
    const lone = fakeCore({ t1: { pid: 7, argv: ['claude'], foreground: { pid: 7, name: 'claude', argv: ['claude'], cwd } } })
    const t2 = createCoreTranscripts({ call: lone.call, pane: id => panes.find(p => p.id === id), localHome: home })
    expect(await t2.chat({ id: 'p1', agent: 'claude', cwd }, {})).toEqual({ available: false, reason: 'not_found' })
  })

  it('forgets what it kept for an agent once its terminal is gone (no growth with every run)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let down = false
      const flaky = fakeCore({ t9: { pid: 4242, argv: ['claude'], foreground: { pid: 4242, name: 'claude', argv: ['claude'], cwd } } })
      const call: typeof flaky.call = (m, p) => (down ? Promise.reject(new CoreError('unavailable', 'x')) : flaky.call(m, p))
      const p9 = pane('p9', 't9', 'claude', cwd)
      const t9 = createCoreTranscripts({ call, pane: () => p9, localHome: home })
      expect((await t9.locate(p9))?.session).toBe(SESSION)
      down = true
      vi.setSystemTime(Date.now() + 10_000)
      // A failed lookup keeps the last file while the agent is there…
      expect((await t9.locate(p9))?.session).toBe(SESSION)
      // …and nothing once its terminal left the state.
      await t9.observe([])
      await new Promise(r => setTimeout(r, 0))
      vi.setSystemTime(Date.now() + 10_000)
      expect(await t9.locate(p9)).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('searches a conversation', async () => {
    const r = await t.search({ id: 'p1', agent: 'claude', cwd }, 'pong', Date.now() + 5000)
    expect(r.hits.length).toBeGreaterThan(0)
  })

  it('reads a remote machine through machine.exec', async () => {
    process.env.FAKE_REMOTE_HOME = home
    const remote = fakeCore({ 'box/t1': { pid: 4242, argv: ['claude'], foreground: { pid: 4242, name: 'claude', argv: ['claude'], cwd } } })
    const rp = [pane('r1', 'box/t1', 'claude', cwd, { machine: '626f78' })]
    const tr = createCoreTranscripts({ call: remote.call, pane: id => rp.find(p => p.id === id), localHome: '/nowhere' })
    const r = await tr.chat({ id: 'r1', agent: 'claude', cwd }, {})
    expect(r.available).toBe(true)
    expect(r.items!.length).toBeGreaterThan(5)
    expect(remote.calls.some(c => c === 'machine.exec box')).toBe(true)
  })
})

describe('remote shell', () => {
  it('maps failures to the codes the file layer understands', async () => {
    const down = coreShell(async () => { throw new CoreError('unreachable', 'machine is down') }, 'box')
    expect((await down('true')).code).toBe(255)
    const slow = coreShell(async () => ({ code: null, stdout: '', timed_out: true }), 'box')
    expect((await slow('true')).code).toBe(124)
    const big = coreShell(async () => ({ code: 0, stdout: Buffer.from('abcdef').toString('base64'), truncated: true }), 'box')
    expect((await big('true', [], { maxBytes: 3 })).code).not.toBe(0)
    // Core's reason survives (its message alone is generic): logs say why an online machine failed.
    const refused = createShellFs(coreShell(async () => { throw new CoreError('unavailable', 'herdr-core rejected the request') }, 'box'))
    const e = await refused.readFile('/x').catch((x: unknown) => x)
    expect([(e as { code?: string }).code, coreFailureKind(e)]).toEqual(['unreachable', 'unavailable'])
  })

  it('discards the partial stdout of a timed-out reply', async () => {
    // Core answers a late command with whatever it printed so far: a reader
    // that decoded it would take a truncated path or line for a complete one.
    const slow = coreShell(async () => ({ code: null, stdout: Buffer.from('/home/al').toString('base64'), timed_out: true }), 'box')
    const r = await slow('printf %s "$HOME"', [], { maxBytes: 4096 })
    expect([r.code, r.stdout.length, r.stderr]).toEqual([124, 0, 'timed out'])
  })

  it('refuses an over-long base64 reply before decoding it', async () => {
    // 4096 bytes bound: 5464 base64 characters is exactly the bound, one more
    // already means the machine sent more than was asked for.
    const at = Buffer.alloc(4096, 0x61)
    const fits = coreShell(async () => ({ code: 0, stdout: at.toString('base64') }), 'box')
    const ok = await fits('true', [], { maxBytes: 4096 })
    expect([ok.code, ok.stdout.length]).toEqual([0, 4096])
    const over = coreShell(async () => ({ code: 0, stdout: 'A'.repeat(5465) }), 'box')
    const r = await over('true', [], { maxBytes: 4096 })
    expect([r.code, r.stdout.length, r.stderr]).toEqual([125, 0, 'output too large'])
  })

  it('always names the machine, so an empty name fails instead of running on this core', async () => {
    const sent: Record<string, unknown>[] = []
    const call = vi.fn(async (_method: string, params: Record<string, unknown>): Promise<any> => {
      sent.push(params)
      return { code: 0, stdout: '' }
    })
    await coreShell(call, '')('true')
    expect(sent[0]).toHaveProperty('on', '')
    await coreShell(call, 'box')('true')
    expect(sent[1]).toHaveProperty('on', 'box')
  })
})

describe('the home folder of a machine', () => {
  const answering = (stdout: Buffer, code = 0): ShellExec => async () => ({ code, stdout, stderr: '' })

  it('asks for it with a bounded read, and keeps it exactly as printed', async () => {
    const seen: unknown[] = []
    const shell: ShellExec = async (script, args, opts) => {
      seen.push([script, args, opts])
      return { code: 0, stdout: Buffer.from('/home/alice'), stderr: '' }
    }
    expect(await machineHome(shell)).toBe('/home/alice')
    expect(seen).toEqual([['printf %s "$HOME"', [], { maxBytes: 4096 }]])
    // Never trimmed: a trailing space is part of what the machine printed,
    // and trimming it would point the reader at another directory.
    expect(await machineHome(answering(Buffer.from('/home/al ')))).toBe('/home/al ')
  })

  it('refuses a partial, failed, tainted or undecodable answer', async () => {
    const bad: [string, Buffer, number][] = [
      ['timed out mid-print', Buffer.from('/home/al'), 124],
      ['the shell failed', Buffer.from('/home/alice'), 1],
      ['a carriage return', Buffer.from('/home/alice\r'), 0],
      ['a newline', Buffer.from('/home/alice\n'), 0],
      ['a NUL', Buffer.from('/home/alice\0'), 0],
      ['a relative path', Buffer.from('home/alice'), 0],
      ['nothing', Buffer.alloc(0), 0],
      ['over the bound', Buffer.alloc(4097, 0x2f), 0],
      ['not UTF-8', Buffer.from([0x2f, 0x68, 0x6f, 0x6d, 0x65, 0xff, 0xfe]), 0],
    ]
    for (const [why, stdout, code] of bad) {
      const e = await machineHome(answering(stdout, code)).catch((x: unknown) => x)
      expect(e, why).toBeInstanceOf(CoreError)
      expect([(e as CoreError).kind, (e as Error).message], why).toEqual(['unreachable', 'machine home unknown'])
    }
  })
})

describe('a remote machine whose home lookup fails', () => {
  const cwd = '/work/proj'

  it.each([
    ['Claude', 'claude', 4242, ['claude']],
    ['Codex', 'codex', 99, ['codex']],
  ])('refuses, then recovers, for a remote %s transcript', async (_name, agent, pid, argv) => {
    const home = homeWithTranscripts(cwd, 4242)
    const core = fakeCore({ 'host-a/t1': { pid, argv, created_ms: Date.now() - 2000, foreground: { pid, name: agent, argv, cwd } } })
    const p = pane(`r-${agent}`, 'host-a/t1', agent, cwd, { machine: '686f73742d61' })
    let down = true
    const call = async (method: string, params: any): Promise<any> => {
      if (params.argv?.[2] === 'printf %s "$HOME"') {
        // A late answer printed only the start of the path.
        return down
          ? { code: 124, stdout: Buffer.from('/home/al').toString('base64'), timed_out: true }
          : { code: 0, stdout: Buffer.from(home).toString('base64') }
      }
      return core.call(method, params)
    }
    const t = createCoreTranscripts({ call, pane: id => (id === p.id ? p : undefined), localHome: '/nowhere' })
    const e = await t.chat(p).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CoreError)
    expect([(e as CoreError).kind, (e as Error).message]).toEqual(['unreachable', 'machine home unknown'])
    // The machine answers on the next poll: its transcript is read from the
    // home it printed, never from the partial one.
    down = false
    const r = await t.chat(p)
    expect(r.available).toBe(true)
    expect(r.file).toBeTruthy()
    expect(r.items!.length).toBeGreaterThan(0)
  })
})

describe('omp core transcripts', () => {
  // herdr-core has no integration that reports omp's session: the conversation is
  // found in the folder omp keeps for its working directory.
  // omp 19 writes its title before the session entry.
  const session = (cwd: string, text: string) => [
    { type: 'title', v: 1, title: 'Demo', source: 'auto', updatedAt: '2026-01-01T10:00:00.000Z' },
    { type: 'session', version: 3, id: 'x', timestamp: '2026-01-01T10:00:00.000Z', cwd },
    { type: 'message', id: 'u1', timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' } },
    { type: 'message', id: 'a1', timestamp: '2026-01-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `Reply to ${text}` }], stopReason: 'stop' } },
  ].map(d => JSON.stringify(d)).join('\n') + '\n'
  function homeWithOmp(cwd: string, dirName: string, born: number) {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-core-omp-'))
    const real = cwd.replace('~', home)
    const dir = path.join(home, '.omp/agent/sessions', dirName)
    mkdirSync(dir, { recursive: true })
    const old = path.join(dir, '2026-01-01T09-00-00-000Z_old.jsonl')
    const now = path.join(dir, '2026-01-01T10-00-00-000Z_new.jsonl')
    writeFileSync(old, session(real, 'earlier question'))
    writeFileSync(now, session(real, 'current question'))
    utimesSync(old, new Date(born - 3600_000), new Date(born - 3600_000))
    utimesSync(now, new Date(born + 1000), new Date(born + 1000))
    // Another folder's conversation, written later, is never taken.
    const other = path.join(home, '.omp/agent/sessions', '-elsewhere')
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, '2026-01-01T11-00-00-000Z_other.jsonl'), session(path.join(home, 'elsewhere'), 'other folder'))
    return { home, cwd: real }
  }
  const omp = (cwd: string, born: number, argv = ['omp']) => fakeCore({ t5: { pid: 77, argv, created_ms: born, foreground: { pid: 77, name: 'omp', argv, cwd } } })
  const texts = (items: { role: string, text?: string }[] | undefined) => (items || []).filter(i => i.role === 'user').map(i => i.text)

  it('opens the conversation an omp terminal writes, in a folder under home', async () => {
    const born = Date.now() - 60_000
    const { home, cwd } = homeWithOmp('~/work/omp', '-work-omp', born)
    const p = pane('o1', 't5', 'omp', cwd)
    const t = createCoreTranscripts({ call: omp(cwd, born).call, pane: () => p, localHome: home })
    const r = await t.chat({ id: 'o1', agent: 'omp', cwd }, {})
    expect(r.available).toBe(true)
    expect(r.file).toBe('2026-01-01T10-00-00-000Z_new.jsonl')
    expect(texts(r.items)).toEqual(['current question'])
  })

  it('opens it for a folder outside home', async () => {
    const born = Date.now() - 60_000
    const cwd = `/srv/omp-${process.pid}`
    const { home } = homeWithOmp(cwd, `--srv-omp-${process.pid}--`, born)
    const p = pane('o2', 't5', 'omp', cwd)
    const t = createCoreTranscripts({ call: omp(cwd, born).call, pane: () => p, localHome: home })
    expect(texts((await t.chat({ id: 'o2', agent: 'omp', cwd }, {})).items)).toEqual(['current question'])
  })

  it('shows no earlier conversation for an omp started after it, unless omp continues it', async () => {
    const born = Date.now() + 60_000 // both files were written before this omp started
    const { home, cwd } = homeWithOmp('~/work/omp', '-work-omp', Date.now() - 60_000)
    const p = pane('o3', 't5', 'omp', cwd)
    const fresh = createCoreTranscripts({ call: omp(cwd, born).call, pane: () => p, localHome: home })
    expect(await fresh.chat({ id: 'o3', agent: 'omp', cwd }, {})).toEqual({ available: false, reason: 'not_found' })
    const resumed = createCoreTranscripts({ call: omp(cwd, born, ['omp', '--continue']).call, pane: () => p, localHome: home })
    expect(texts((await resumed.chat({ id: 'o3', agent: 'omp', cwd }, {})).items)).toEqual(['current question'])
  })
})

describe('Devin core transcripts', () => {
  it('resolves a fresh remote PID lock using machine.exec and the remote home', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-remote-devin-'))
    const root = path.join(home, '.local/share/devin/cli')
    mkdirSync(path.join(root, 'session_locks'), { recursive: true })
    mkdirSync(path.join(root, 'transcripts'))
    const doc = JSON.parse(fx('devin-atif-v1.7-real.json'))
    writeFileSync(path.join(root, 'session_locks', `${doc.session_id}.lock`), '42424242\n')
    writeFileSync(path.join(root, 'transcripts', `${doc.session_id}.json`), JSON.stringify(doc))
    const core = fakeCore({ 'host-a/t1': { pid: 10, argv: ['sh'] } })
    const call = vi.fn(async (method: string, params: any): Promise<any> => {
      if (params.argv?.[0] === 'ps') return { stdout: Buffer.from('10 1 sh\n42424242 10 /opt/devin\n').toString('base64') }
      if (params.argv?.[2] === DEVIN_PROCESS_SCRIPT) return { stdout: Buffer.from('42424242 100 100 1767225600 100.00 1767225700.001 ' + Buffer.from('/opt/devin\0').toString('base64') + '\n').toString('base64') }
      if (params.argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
      return core.call(method, params)
    })
    const p = pane('devin', 'host-a/t1', 'devin', '/work/proj')
    const t = createCoreTranscripts({ call, pane: () => p, localHome: '/unrelated' })
    const r = await t.chat(p)
    expect(r.session).toBe(doc.session_id)
    expect(r.items?.at(-1)?.text).toContain('all 12 tests pass')
    expect((await t.chat(p, { since: r.token })).unchanged).toBe(true)
    for (const [method, params] of call.mock.calls) if (method === 'machine.exec') expect(params.on).toBe('host-a')
  })

  it('resolves the lock held by the engine child when the Devin launcher is the foreground', async () => {
    // Devin 3000.12 runs as a launcher (the foreground) with its engine
    // `devin acp` as a child; the session lock names the engine's PID.
    const home = mkdtempSync(path.join(tmpdir(), 'hw-remote-devin-engine-'))
    const root = path.join(home, '.local/share/devin/cli')
    mkdirSync(path.join(root, 'session_locks'), { recursive: true })
    mkdirSync(path.join(root, 'transcripts'))
    const doc = JSON.parse(fx('devin-atif-v1.7-real.json'))
    writeFileSync(path.join(root, 'session_locks', `${doc.session_id}.lock`), '51\n')
    writeFileSync(path.join(root, 'transcripts', `${doc.session_id}.json`), JSON.stringify(doc))
    const core = fakeCore({ 'host-a/t1': { pid: 10, argv: ['sh'], foreground: { pid: 50, name: 'devin', argv: ['devin', '--prompt-file', 'brief.md'] } } })
    const snap = (pid: string, argv: string[]) => `${pid} 100 100 1767225600 100.00 1767225700.001 ${Buffer.from(argv.join('\0') + '\0').toString('base64')}`
    const call = vi.fn(async (method: string, params: any): Promise<any> => {
      if (params.argv?.[0] === 'ps') return { stdout: Buffer.from('10 1 sh\n50 10 devin --prompt-file brief.md\n51 50 /opt/devin acp\n52 51 npm exec server\n').toString('base64') }
      if (params.argv?.[2] === DEVIN_PROCESS_SCRIPT) {
        const lines = params.argv.slice(4).map((pid: string) => snap(pid, pid === '51' ? ['/opt/devin', 'acp'] : ['devin', '--prompt-file', 'brief.md']))
        return { stdout: Buffer.from(lines.join('\n') + '\n').toString('base64') }
      }
      if (params.argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
      return core.call(method, params)
    })
    const p = pane('devin', 'host-a/t1', 'devin', '/work/proj')
    const t = createCoreTranscripts({ call, pane: () => p, localHome: '/unrelated' })
    const r = await t.chat(p)
    expect(r.session).toBe(doc.session_id)
    expect(r.items?.at(-1)?.text).toContain('all 12 tests pass')
  })

  it('matches the engine child only, not a Devin started below it', async () => {
    // A second Devin under the engine (started from its shell) holds its own
    // lock; only the launcher's direct Devin child names this session.
    const home = mkdtempSync(path.join(tmpdir(), 'hw-remote-devin-nested-'))
    const root = path.join(home, '.local/share/devin/cli')
    mkdirSync(path.join(root, 'session_locks'), { recursive: true })
    mkdirSync(path.join(root, 'transcripts'))
    const doc = JSON.parse(fx('devin-atif-v1.7-real.json'))
    writeFileSync(path.join(root, 'session_locks', `${doc.session_id}.lock`), '51\n')
    writeFileSync(path.join(root, 'transcripts', `${doc.session_id}.json`), JSON.stringify(doc))
    writeFileSync(path.join(root, 'session_locks', 'nested-session.lock'), '54\n')
    writeFileSync(path.join(root, 'transcripts', 'nested-session.json'), JSON.stringify({ ...doc, session_id: 'nested-session' }))
    const core = fakeCore({ 'host-a/t1': { pid: 10, argv: ['sh'], foreground: { pid: 50, name: 'devin', argv: ['devin', '--prompt-file', 'brief.md'] } } })
    const snap = (pid: string, argv: string[]) => `${pid} 100 100 1767225600 100.00 1767225700.001 ${Buffer.from(argv.join('\0') + '\0').toString('base64')}`
    const ps = '10 1 sh\n50 10 devin --prompt-file brief.md\n51 50 /opt/devin acp\n53 51 zsh\n54 53 devin -r nested-session\n'
    const call = vi.fn(async (method: string, params: any): Promise<any> => {
      if (params.argv?.[0] === 'ps') return { stdout: Buffer.from(ps).toString('base64') }
      if (params.argv?.[2] === DEVIN_PROCESS_SCRIPT) {
        const lines = params.argv.slice(4).map((pid: string) => snap(pid, ['devin', '--prompt-file', 'brief.md']))
        return { stdout: Buffer.from(lines.join('\n') + '\n').toString('base64') }
      }
      if (params.argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
      return core.call(method, params)
    })
    const p = pane('devin', 'host-a/t1', 'devin', '/work/proj')
    const t = createCoreTranscripts({ call, pane: () => p, localHome: '/unrelated' })
    expect((await t.chat(p)).session).toBe(doc.session_id)
  })

  it('reads a resumed Devin transcript from the foreground process without hooks', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-core-devin-'))
    const dir = path.join(home, '.local/share/devin/cli/transcripts')
    mkdirSync(dir, { recursive: true })
    const doc = JSON.parse(fx('devin-atif-v1.7-real.json'))
    writeFileSync(path.join(dir, `${doc.session_id}.json`), JSON.stringify(doc))
    const core = fakeCore({ t1: { pid: 42424242, argv: ['devin', '-r', doc.session_id] } })
    const p = pane('devin', 't1', 'devin', '/work/proj')
    const t = createCoreTranscripts({ call: core.call, pane: () => p, localHome: home })
    const r = await t.chat(p)
    expect(r.available).toBe(true)
    expect(r.session).toBe(doc.session_id)
    expect(r.items?.at(-1)?.text).toContain('all 12 tests pass')
    expect((await t.search(p, 'cart', Date.now() + 5000)).hits).toHaveLength(3)
    expect((await t.model(p))?.id).toBe('claude-sonnet-4-5')
    expect(await t.preview(p)).toContain('all 12 tests pass')
  })

  it('finds Devin under a shell and ignores unrelated processes', () => {
    expect(agentDescendants('10 1 sh\n12 10 /opt/devin -r example\n20 1 devin\n', 10).map(p => p.pid)).toEqual([12])
  })

  it('lists only the direct agent children of a process', () => {
    const ps = '50 10 devin\n51 50 /opt/devin acp\n52 51 zsh\n53 52 devin -r other\n54 50 sh\n'
    expect(agentChildren(ps, 50).map(p => p.pid)).toEqual([51])
  })
})


it.each([13, 24])('reads a %s MiB remote ATIF document without exceeding a 16 MiB core reply', async (mebibytes) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-core-large-devin-'))
  const dir = path.join(home, '.local/share/devin/cli/transcripts')
  mkdirSync(dir, { recursive: true })
  const doc = { schema_version: 'ATIF-v1.7', session_id: 'large-session',
    steps: [{ step_id: 1, source: 'system', message: '' }, { step_id: 2, source: 'agent', message: 'Large remote reply' }] }
  doc.steps[0]!.message = 'x'.repeat(mebibytes * 1024 * 1024 - Buffer.byteLength(JSON.stringify(doc)))
  writeFileSync(path.join(dir, 'large-session.json'), JSON.stringify(doc))
  const core = fakeCore({ 'host-a/t1': { pid: 42424242, argv: ['devin', '-r', doc.session_id] } })
  let peak = 0
  const call = async (method: string, params: any) => {
    const result = params.argv?.[2] === 'printf %s "$HOME"'
      ? { code: 0, stdout: Buffer.from(home).toString('base64') } : await core.call(method, params)
    peak = Math.max(peak, Buffer.byteLength(JSON.stringify(result)))
    if (peak >= 16 * 1024 * 1024) throw new CoreError('rpc', 'reply too large')
    return result
  }
  const p = pane('devin-large', 'host-a/t1', 'devin', '/work/proj')
  const reader = createCoreTranscripts({ call, pane: () => p, localHome: '/unrelated' })
  expect((await reader.chat(p)).items?.at(-1)?.text).toBe('Large remote reply')
  expect(peak).toBeLessThan(16 * 1024 * 1024)
})

describe('remote ps cache', () => {
  it('runs at most one remote ps per machine per 10 s', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-ps-cache-'))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1000)
      const convDir = path.join(home, '.gemini/antigravity-cli/conversations')
      mkdirSync(convDir, { recursive: true })
      const psExecs = new Map<string, number>()
      const panes = Array.from({ length: 5 }, (_, i) => pane(`a${i + 1}`, `host-a/t${i + 1}`, 'agy', '/work/proj', { agentSession: SESSION }))
      panes.push(pane('b1', 'host-b/t1', 'agy', '/work/proj', { agentSession: SESSION }))

      const call = vi.fn(async (method: string, params: any): Promise<any> => {
        const on = params.on || ''
        if (method === 'terminal.get') {
          const idx = Number(String(params.terminal).split('t')[1] || 1)
          // Shell foreground so coreTranscripts uses psTable to find child agent process.
          return { pid: 100 + idx, argv: ['bash'], foreground: { pid: 100 + idx, name: 'bash', argv: ['bash'], cwd: '/work/proj' } }
        }
        if (method === 'machine.exec') {
          if (params.argv?.[0] === 'ps') {
            psExecs.set(on, (psExecs.get(on) ?? 0) + 1)
            const rows = Array.from({ length: 5 }, (_, i) => `${101 + i} 1 sh\n${201 + i} ${101 + i} agy --conversation ${SESSION}\n`).join('')
            return { code: 0, stdout: Buffer.from(rows).toString('base64') }
          }
          if (params.argv?.[2] === DEVIN_PROCESS_SCRIPT) {
            const lines = params.argv.slice(4).map((pid: string) => `${pid} 100 100 1767225600 100.00 1767225700.001 ${Buffer.from(`agy\0--conversation\0${SESSION}\0`).toString('base64')}`)
            return { code: 0, stdout: Buffer.from(lines.join('\n') + '\n').toString('base64') }
          }
          if (params.argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
          return { code: 1, stdout: '', stderr: '' }
        }
        throw new CoreError('rpc', method)
      })

      const t = createCoreTranscripts({ call, pane: id => panes.find(x => x.id === id), localHome: '/unrelated' })
      // Concurrent locate across 5 panes on host-a at t=1000.
      await Promise.all(panes.slice(0, 5).map(p => t.locate(p)))
      expect(psExecs.get('host-a') ?? 0).toBe(1)

      // At t=9500, locCache (8s) and detail (1.5s) expired, triggering herdr again,
      // while psCache (10s) still serves cached ps output.
      vi.setSystemTime(9500)
      await t.locate(panes[0]!)
      expect(psExecs.get('host-a') ?? 0).toBe(1)

      // Separate machine maintains its own ps cache.
      await t.locate(panes[5]!)
      expect(psExecs.get('host-b') ?? 0).toBe(1)

      // After 10 s (and locCache > 8s past 9500), a fresh lookup issues one new ps for host-a.
      vi.setSystemTime(18_000)
      await t.locate(panes[0]!)
      expect(psExecs.get('host-a') ?? 0).toBe(2)
    } finally { vi.useRealTimers(); rmSync(home, { recursive: true, force: true }) }
  })
})

it('reads a remote Claude line longer than one reply in chunks that share a deadline', async () => {
  const cwd = '/work/proj'
  const home = mkdtempSync(path.join(tmpdir(), 'hw-remote-claude-big-'))
  mkdirSync(path.join(home, '.claude/sessions'), { recursive: true })
  writeFileSync(path.join(home, '.claude/sessions/4242.json'), JSON.stringify({ pid: 4242, sessionId: SESSION, cwd }))
  const dir = path.join(home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const big = 'x'.repeat(5 * 1024 * 1024) + 'END-OF-BIG-LINE'
  const lines = fx('claude-session.jsonl').trimEnd().split('\n')
  lines.push(JSON.stringify({ isSidechain: false, type: 'assistant', timestamp: '2026-09-25T11:30:00.000Z',
    message: { model: 'claude-opus-5-5', type: 'message', role: 'assistant', content: [{ type: 'text', text: big }] } }))
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join('\n') + '\n')
  const core = fakeCore({ 'host-a/t1': { pid: 4242, argv: ['claude'], foreground: { pid: 4242, name: 'claude', argv: ['claude'], cwd } } })
  const asks: number[] = []
  const call = async (method: string, params: any): Promise<any> => {
    if (params.argv?.[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
    // A byte-range read asks for its count last: never more than one chunk.
    if (method === 'machine.exec' && String(params.argv?.[2]).includes('tail -c')) asks.push(Number(params.argv[6]))
    return core.call(method, params)
  }
  const p = pane('big', 'host-a/t1', 'claude', cwd, { machine: '686f73742d61' })
  const t = createCoreTranscripts({ call, pane: () => p, localHome: '/nowhere' })
  const r = await t.chat(p)
  // The whole line was reached (its start is long before the window a
  // single reply could carry) and parsed as one message.
  const last = r.items?.at(-1)
  expect(last?.role).toBe('assistant')
  expect(last?.text?.startsWith('xxxxxxxx')).toBe(true)
  expect(last?.text?.length).toBeGreaterThan(10_000)
  // It came back in several replies, none of them over one chunk.
  expect(asks.length).toBeGreaterThan(1)
  expect(Math.max(...asks)).toBe(READ_CHUNK)
  expect(Math.min(...asks)).toBeGreaterThan(0)
})
