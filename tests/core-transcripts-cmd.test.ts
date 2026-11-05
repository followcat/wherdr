import { describe, expect, it } from 'vitest'
import { createCoreTranscripts } from '../server/utils/coreTranscripts'
import { createTranscripts } from '../server/utils/transcripts'
import type { MachineFs } from '../server/utils/fsx'
import { CoreError } from '../server/utils/core'
import type { Pane } from '../shared/types'
import {
  AGENT_CENSUS_SCRIPT, CMD_FILES_SCRIPT, CMD_HEADERS_SCRIPT, clock,
  F, filesWire, H, hdrs, HOME, OTHER, POST, POST2, retitled, S, sess, st, T, U1, U2, WORK
} from './cmdCoreFixture'

const pane = (id: string, address: string, agent: string | null, cwd = WORK) =>
  ({ id, coreAddress: address, agent, cwd, machine: '', agentSession: null, status: 'idle' }) as Pane
// terminal.get carries a REQUIRED state: a cmd detail always spells it out,
// never defaulted.
const liveD = (o: object) => ({ state: 'live', ...o })

interface Wires { census?: string, files?: string, headers?: (a: string[]) => string }

// A "core" answering terminal.get from a table and machine.exec purely from
// wire fixtures. The census/files/header scripts are stubbed EXPLICITLY and
// this helper never execFile's — a wire script can never reach host /proc.
function cmdCore(details: Record<string, object>, wires: Wires | ((on: string) => Wires | undefined), opts: { home?: string } = {}) {
  const calls = { get: [] as string[], exec: [] as { on?: string, hasOn: boolean }[], census: 0, files: 0, headers: 0 }
  const call = async (method: string, params: any): Promise<any> => {
    if (method === 'terminal.get') {
      calls.get.push(params.terminal)
      if (!details[params.terminal]) throw new CoreError('not_found', 'x')
      return details[params.terminal]
    }
    if (method === 'machine.exec') {
      calls.exec.push({ on: params.on, hasOn: 'on' in params })
      // argv is ['sh', '-c', script, 'sh', ...args]: the script is [2],
      // real arguments start after the $0 placeholder at [4].
      const script = params.argv?.[2] as string | undefined
      const args = (params.argv ?? []).slice(4) as string[]
      const w = typeof wires === 'function' ? wires(params.on || '') : wires
      const out = (s: string) => ({ code: 0, stdout: Buffer.from(s).toString('base64') })
      if (script === 'printf %s "$HOME"') return out(opts.home ?? HOME)
      if (script === AGENT_CENSUS_SCRIPT) { calls.census++; return out(w?.census ?? `${H}T 0 0 0 0\n`) }
      if (script === CMD_FILES_SCRIPT) { calls.files++; return out(w?.files ?? 'H\nT 0 0 0 0\n') }
      if (script === CMD_HEADERS_SCRIPT) { calls.headers++; return out(w?.headers?.(args) ?? 'H\nT 0 0 0\n') }
      throw new CoreError('rpc', `unexpected machine.exec: ${String(script).slice(0, 60)}`)
    }
    throw new CoreError('rpc', method)
  }
  return { call, calls }
}

describe('Command Code panes resolve via core detail and per-machine wires', () => {
  const okWire = (extra: Partial<Wires> = {}): Wires => ({
    census: H + S(4242) + T(1, 1),
    files: filesWire([[F('a', U1), st(POST)]]),
    headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } }),
    ...extra
  })
  const P = (id: string) => ({ id, agent: 'cmd', cwd: WORK })

  it('resolves a local pane through machine.exec with NO on field', async () => {
    const core = cmdCore({ t1: liveD({ pid: 9000, argv: ['bash', '-l'], foreground: { pid: 4242 } }) }, okWire())
    const panes = [pane('p1', 't1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate(P('p1'))).toEqual({ file: F('a', U1), session: U1, guessed: true })
    expect(core.calls.get).toEqual(['t1'])
    for (const e of core.calls.exec) expect(e.hasOn).toBe(false) // never an empty machine name
    expect([core.calls.census, core.calls.files, core.calls.headers]).toEqual([1, 1, 1])
  })

  it('scopes remote evidence to the pane machine and the exact address', async () => {
    const core = cmdCore({ 'box/t1': liveD({ pid: 9000, argv: ['bash', '-l'], foreground: { pid: 4242 } }) }, okWire())
    const panes = [pane('r1', 'box/t1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: '/unrelated' })
    expect(await t.locate(P('r1'))).toEqual({ file: F('a', U1), session: U1, guessed: true })
    expect(core.calls.get).toEqual(['box/t1']) // the full address, not a suffix
    for (const e of core.calls.exec) expect(e.on).toBe('box')
  })

  it('keeps identical pids and address suffixes on different machines apart', async () => {
    const wireOf = (dir: string, cwd: string, id: string): Wires => ({
      census: H + S(4242, { cwd }) + T(1, 1),
      files: filesWire([[F(dir, id), st(POST)]]),
      headers: hdrs({ [F(dir, id)]: { st: st(POST), body: sess(id, cwd) } })
    })
    const byMachine: Record<string, Wires> = { box: wireOf('pa', '/w/a', U1), 'host-a': wireOf('pb', '/w/b', U2) }
    const core = cmdCore({
      'box/t1': liveD({ pid: 4242, argv: ['cmd'], foreground: { pid: 4242 } }),
      'host-a/t1': liveD({ pid: 4242, argv: ['cmd'], foreground: { pid: 4242 } })
    }, on => byMachine[on])
    const panes = [pane('pa', 'box/t1', 'cmd', '/w/a'), pane('pb', 'host-a/t1', 'cmd', '/w/b')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: '/unrelated' })
    expect(await t.locate({ id: 'pa', agent: 'cmd', cwd: '/w/a' })).toEqual({ file: F('pa', U1), session: U1, guessed: true })
    expect(await t.locate({ id: 'pb', agent: 'cmd', cwd: '/w/b' })).toEqual({ file: F('pb', U2), session: U2, guessed: true })
  })

  it('binds the single direct cmd child of a shell root', async () => {
    const core = cmdCore(
      { t1: liveD({ pid: 9000, argv: ['bash', '-l', '--session', U2] }) },
      okWire({ census: H + S(4242, { ppid: 9000 }) + T(1, 1) })
    )
    const panes = [pane('p1', 't1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    // The child's own generation is the target: the shell's recorded argv is never consulted.
    expect(await t.locate(P('p1'))).toEqual({ file: F('a', U1), session: U1, guessed: true })
  })

  it('uses only the recorded root argv, never reconstructed census argv', async () => {
    // The root IS the cmd row but its recorded launch was a shell: unproven birth.
    const core = cmdCore({ t1: liveD({ pid: 4242, argv: ['bash', '-l'] }) }, okWire())
    const panes = [pane('p1', 't1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate(P('p1'))).toBeNull()
    // Same for a retitled census row: the sampled argv is not launch-exact, so
    // a foreign-session seed inside it can never leak into the selection.
    const rt = cmdCore({ t1: liveD({ pid: 9000, argv: ['bash'], foreground: { pid: 4242 } }) }, {
      census: H + retitled(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('r', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('r', U2)]: { st: st(POST2), body: sess(U2, OTHER) } })
    })
    const t2 = createCoreTranscripts({ call: rt.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t2.locate(P('p1'))).toEqual({ file: F('a', U1), session: U1, guessed: true }) // cwd file, never the resumed one
  })

  it('refuses two same-cwd cmd peers before any file IO', async () => {
    const core = cmdCore({ t1: liveD({ pid: 9000, foreground: { pid: 4242 } }) }, okWire({ census: H + S(4242) + S(5555) + T(2, 2) }))
    const panes = [pane('p1', 't1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate(P('p1'))).toBeNull()
    expect([core.calls.census, core.calls.files, core.calls.headers]).toEqual([1, 0, 0])
  })

  it('passes process cwd evidence, never pane.cwd', async () => {
    const core = cmdCore({ t1: liveD({ pid: 9000, foreground: { pid: 4242 } }) }, okWire())
    const panes = [pane('p1', 't1', 'cmd', '/unrelated/pane-cwd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate({ id: 'p1', agent: 'cmd', cwd: '/unrelated/pane-cwd' })).toEqual({ file: F('a', U1), session: U1, guessed: true })
  })

  it('never resolves a finished or stateless terminal detail', async () => {
    const core = cmdCore({
      t1: liveD({ pid: 9000, foreground: { pid: 4242 } }),
      t2: { state: 'finished', pid: 9000, argv: ['cmd'], foreground: { pid: 4242 } },
      t3: { pid: 9000, argv: ['cmd'], foreground: { pid: 4242 } } // no state at all
    }, okWire())
    const panes = [pane('p1', 't1', 'cmd'), pane('p2', 't2', 'cmd'), pane('p3', 't3', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate(P('p1'))).not.toBeNull()
    const before = core.calls.census
    expect(await t.locate(P('p2'))).toBeNull()
    expect(await t.locate(P('p3'))).toBeNull()
    expect(core.calls.census).toBe(before) // state rejection precedes any evidence work
  })

  it('returns null on a failed or out-of-generation lookup — never the prior file', async () => {
    const cl = clock()
    const wires = okWire()
    const core = cmdCore({ t1: liveD({ pid: 9000, foreground: { pid: 4242 } }) }, wires)
    const panes = [pane('p1', 't1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: HOME, now: cl.now })
    expect(await t.locate(P('p1'))).toEqual({ file: F('a', U1), session: U1, guessed: true })
    cl.advance(2000) // evidence TTL expired: a fresh census decides again
    wires.census = 'H 100 1767225600 0\nT 0 0 0 0\n' // machine evidence unavailable
    expect(await t.locate(P('p1'))).toBeNull()
    expect(core.calls.census).toBe(2)
    cl.advance(2000)
    // The pid was reused by a generation born at 450 s of 500.12 s uptime:
    // the only candidate, written at 400.5 s, is pre-birth for it.
    wires.census = H + S(4242, { ticks: '45000' }) + T(1, 1)
    expect(await t.locate(P('p1'))).toBeNull()
    expect(core.calls.census).toBe(3)
  })

  it('drops any earlier legacy location so a later agent change cannot resurrect it', async () => {
    const core = cmdCore({ t1: liveD({ pid: 9000, foreground: { pid: 4242 } }) }, okWire())
    const p = pane('p1', 't1', 'cmd')
    const t = createCoreTranscripts({ call: core.call, pane: id => [p].find(q => q.id === id), localHome: HOME })
    expect(await t.locate(P('p1'))).not.toBeNull()
    ;(p as Pane).agent = 'claude' // the pane is relabeled: the cmd file must not leak back
    expect(await t.locate({ id: 'p1', agent: 'claude', cwd: WORK })).toBeNull()
  })

  it('keeps a failed machine at typed unavailable values and recovers on retry', async () => {
    let down = true
    const core = cmdCore({
      'box/t1': liveD({ pid: 9000, foreground: { pid: 4242 } }),
      'down/t1': liveD({ pid: 9000, foreground: { pid: 4242 } }),
      'down/t2': liveD({ pid: 9000, argv: ['claude'], foreground: { pid: 4242, name: 'claude', argv: ['claude'] } })
    }, okWire())
    const panes = [pane('r1', 'box/t1', 'cmd'), pane('r2', 'down/t1', 'cmd'), pane('r3', 'down/t2', 'claude')]
    const call = async (method: string, params: any): Promise<any> => {
      if (method === 'machine.exec' && params.on === 'down' && down) throw new CoreError('unreachable', 'machine is down')
      return core.call(method, params)
    }
    const t = createCoreTranscripts({ call, pane: id => panes.find(q => q.id === id), localHome: '/x' })
    const p2 = { id: 'r2', agent: 'cmd', cwd: WORK }
    // The home lookup fails inside the machine entry: every public read
    // resolves its own typed unavailable for cmd panes — no rejects.
    expect(await t.locate(p2)).toBeNull()
    expect(await t.preview(p2)).toBeNull()
    expect(await t.latestReply(p2)).toBeNull()
    expect(await t.model(p2)).toBeNull()
    expect(await t.pendingTool(p2)).toBeNull()
    expect(await t.pendingAsk(p2)).toEqual([])
    expect(await t.pendingClaudeQuestions(p2)).toEqual([])
    expect(await t.chat(p2)).toEqual({ available: false, reason: 'not_found' })
    expect(await t.search(p2, 'x', Date.now() + 1000)).toEqual({ hits: [], limited: false, kind: null })
    expect(await t.image(p2, 'f.jsonl', '0:1', 0)).toBeNull()
    // Legacy agents keep the throwing behavior on machine failure.
    await expect(t.locate({ id: 'r3', agent: 'claude', cwd: WORK })).rejects.toThrow()
    // A healthy machine stays isolated.
    expect(await t.locate(P('r1'))).toEqual({ file: F('a', U1), session: U1, guessed: true })
    // The failed entry is not pinned: once the machine answers, the same pane resolves.
    down = false
    expect(await t.locate(p2)).toEqual({ file: F('a', U1), session: U1, guessed: true })
  })

  it('without the callback a cmd pane resolves nothing and drops a seeded legacy location', async () => {
    const files: Record<string, string> = {
      '/h/.claude/sessions/7.json': JSON.stringify({ pid: 7, sessionId: 'sess-1', cwd: '/w' }),
      '/h/.claude/projects/-w/sess-1.jsonl': '{"type":"x"}\n'
    }
    const err = (code: string) => Object.assign(new Error(code), { code })
    let broken = false
    const fs: MachineFs = {
      stat: async p => { if (broken) throw err('EIO'); if (p in files) return { size: files[p]!.length, mtimeMs: 1, isFile: true, isDir: false }; throw err('ENOENT') },
      statMany: async ps => Promise.all(ps.map(p => fs.stat(p).catch(() => null))),
      readdir: async () => { throw err('ENOENT') },
      readFile: async p => { if (broken) throw err('EIO'); if (p in files) return files[p]!; throw err('ENOENT') },
      read: async (p, s, l) => { if (broken) throw err('EIO'); return Buffer.from(files[p] ?? '').subarray(s, s + l) }
    }
    const herdr = async (method: string) => {
      if (method === 'pane.process_info') return { process_info: { foreground_processes: [{ pid: 7, name: 'claude', argv: ['claude'] }] } }
      throw new Error('unsupported ' + method)
    }
    // No locateCommandCode: the pane's cmd branch must still clear — never serve legacy.
    const t = createTranscripts({ home: '/h', herdr: herdr as never, fs })
    expect(await t.locate({ id: 'p1', agent: 'claude', cwd: '/w' })).toEqual({ file: '/h/.claude/projects/-w/sess-1.jsonl', session: 'sess-1' })
    // The same pane id reports as cmd with no callback: null, and the seeded
    // legacy caches are dropped, not served (the session id even matched).
    expect(await t.locate({ id: 'p1', agent: 'cmd', cwd: '/w' })).toBeNull()
    // Back as claude with the filesystem now failing: nothing stale can answer.
    broken = true
    expect(await t.locate({ id: 'p1', agent: 'claude', cwd: '/w' })).toBeNull()
  })

  it('coalesces one machine snapshot across simultaneous pane lookups', async () => {
    const core = cmdCore({
      'box/t1': liveD({ pid: 9000, foreground: { pid: 4242 } }),
      'box/t2': liveD({ pid: 9001, foreground: { pid: 5555 } }),
      'box/t3': liveD({ pid: 9999, argv: ['bash'] })
    }, {
      census: H + S(4242) + S(5555, { cwd: '/w/two' }) + T(2, 2),
      files: filesWire([[F('a', U1), st(POST)], [F('b', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('b', U2)]: { st: st(POST2), body: sess(U2, '/w/two') } })
    })
    const panes = [pane('p1', 'box/t1', 'cmd'), pane('p2', 'box/t2', 'cmd'), pane('p3', 'box/t3', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: '/unrelated' })
    const [r1, r2, r3, pv, md] = await Promise.all([
      t.locate(P('p1')),
      t.locate({ id: 'p2', agent: 'cmd', cwd: '/w/two' }),
      t.locate(P('p3')),
      t.preview(P('p1')),
      t.model(P('p1'))
    ])
    expect(r1).toEqual({ file: F('a', U1), session: U1, guessed: true })
    expect(r2).toEqual({ file: F('b', U2), session: U2, guessed: true })
    expect(r3).toBeNull() // unproven root: no location, no storm
    expect(pv).toBeNull() // cmd parsing arrives with parser enablement, a later task
    expect(md).toBeNull()
    expect([core.calls.census, core.calls.files, core.calls.headers]).toEqual([1, 1, 1])
  })

  it('refuses a failed home reply and never reaches census or file select', async () => {
    // A nonzero code or a timeout can carry a plausible absolute partial —
    // it is never a trusted home, so nothing after it may run.
    for (const bad of [
      { code: 1, stdout: Buffer.from('/h/.commandcode').toString('base64') },
      { timed_out: true, stdout: Buffer.from('/h/.com').toString('base64') },
    ]) {
      const execs: string[] = []
      const call = async (method: string, params: { argv?: string[] }): Promise<any> => {
        if (method === 'terminal.get') return liveD({ pid: 9000, argv: ['bash'], foreground: { pid: 4242 } })
        if (method === 'machine.exec') { execs.push(String(params.argv?.[2] || '')); return bad }
        throw new CoreError('rpc', method)
      }
      const panes = [pane('r1', 'box/t1', 'cmd')]
      const t = createCoreTranscripts({ call, pane: id => panes.find(p => p.id === id), localHome: HOME })
      expect(await t.locate(P('r1'))).toBeNull()
      expect(execs).toEqual(['printf %s "$HOME"'])
    }
  })

  it('uses a valid trailing-space home literally, never trimmed away', async () => {
    const LITERAL = '/h '
    const file = `${LITERAL}/.commandcode/projects/a/${U1}.jsonl`
    const core = cmdCore(
      { 'box/t1': liveD({ pid: 9000, argv: ['bash'], foreground: { pid: 4242 } }) },
      {
        census: H + S(4242) + T(1, 1),
        files: filesWire([[file, st(POST)]]),
        headers: hdrs({ [file]: { st: st(POST), body: sess(U1) } }),
      },
      { home: LITERAL }
    )
    const panes = [pane('r1', 'box/t1', 'cmd')]
    const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: '/unrelated' })
    expect(await t.locate(P('r1'))).toEqual({ file, session: U1, guessed: true })
  })

  it('rejects home bytes that cannot decode back to themselves', async () => {
    // Invalid UTF-8 would be replaced into ANOTHER path, never an option.
    const execs: string[] = []
    const call = async (method: string, params: { argv?: string[] }): Promise<any> => {
      if (method === 'terminal.get') return liveD({ pid: 9000, argv: ['bash'], foreground: { pid: 4242 } })
      if (method === 'machine.exec') {
        execs.push(String(params.argv?.[2] || ''))
        return { code: 0, stdout: Buffer.from([0x2f, 0x68, 0xff]).toString('base64') } // '/h\xff'
      }
      throw new CoreError('rpc', method)
    }
    const panes = [pane('r1', 'box/t1', 'cmd')]
    const t = createCoreTranscripts({ call, pane: id => panes.find(p => p.id === id), localHome: HOME })
    expect(await t.locate(P('r1'))).toBeNull()
    expect(execs).toEqual(['printf %s "$HOME"'])
  })

  it('rejects a non-absolute or NUL-bearing local home for a local pane', async () => {
    for (const bad of ['rel/home', '/h\0idden']) {
      const core = cmdCore({ t1: liveD({ pid: 9000, argv: ['bash'], foreground: { pid: 4242 } }) }, okWire())
      const panes = [pane('p1', 't1', 'cmd')]
      const t = createCoreTranscripts({ call: core.call, pane: id => panes.find(p => p.id === id), localHome: bad })
      expect(await t.locate(P('p1'))).toBeNull()
      expect(core.calls.exec.length).toBe(0) // nothing ran on a guessed home
      expect(core.calls.get.length).toBe(0)
    }
  })
})
