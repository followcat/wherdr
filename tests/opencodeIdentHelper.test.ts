// 6l2 helper-seam unit: the REAL OPENCODE_IDENT python body runs under
// owned python3 with fully injected fake os/socket/select/time/open seams.
// No real /proc, socket, pidfd or OpenCode — every unmapped path/syscall
// raises inside the fakes (loud), never falls through to the real OS.
// TEST-ONLY: the prelude finally-dumps the fake call trace to stderr so
// tests assert pidfd/socket cleanup on success AND refusal; the shipped
// helper carries no introspection. Neutral fixture values throughout.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_IDENT } from '../server/utils/opencodeReadIdentity'

const run = promisify(execFile)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const PRELUDE = String.raw`
import sys, types, json, struct, stat as ST, builtins, io
SC = json.loads(open(sys.argv[1]).read())
SRC, REQ = sys.argv[2], sys.argv[3]
calls = []
_t = [0.0]
def _tick(phase):                    # PHASE-controlled clock advance:
    st = SC.get('step', {}).get(phase, 0)   # each seam moves the monotonic
    if isinstance(st, list):         # clock by a scripted delta (never a
        if st: _t[0] += st.pop(0)    # call-count guess); lists are consumed
    else: _t[0] += st                # per call, scalars repeat
class FS:
    def __init__(s, mode, uid): s.st_mode, s.st_uid = mode, uid
os = types.ModuleType('os'); os.OSError = OSError
_proc = SC.get('proc', {'uid': 1000})
def _stat(p):
    calls.append('stat:' + p); _tick('fs')
    return FS(ST.S_IFDIR | 0o755, _proc['uid'])
os.stat = _stat
def _lstat(p):
    calls.append('lstat:' + p); _tick('fs')
    e = SC.get('files', {}).get(p)
    if e is None: raise FileNotFoundError(p)
    return FS({'dir': ST.S_IFDIR, 'sock': ST.S_IFSOCK, 'link': ST.S_IFLNK,
               'file': ST.S_IFREG}[e['k']] | e.get('m', 0), e.get('u', 1000))
os.lstat = _lstat
def _readlink(p):
    calls.append('readlink:' + p); _tick('link')
    v = SC.get('links', {}).get(p)
    if v is None: raise OSError(p)
    return v
os.readlink = _readlink
def _pidfd(pid, flags=0):
    calls.append('pidfd:' + str(pid))
    if SC.get('nopidfd'): raise OSError('ENOSYS')
    return 9
os.pidfd_open = _pidfd
os.close = lambda fd: calls.append('close:' + str(fd))
sys.modules['os'] = os
sel = types.ModuleType('select')
def _select(r, w, x, t):
    calls.append('poll'); _tick('poll')
    if SC.get('pollerr'): raise OSError('poll')
    at = SC.get('dead_at')
    if at is not None and calls.count('poll') >= at:
        return ([9], [], [])
    return ([], [], [])
sel.select = _select
sys.modules['select'] = sel
tm = types.ModuleType('time')
tm.monotonic = lambda: _t[0]
tm.time = lambda: SC.get('wall', 5.0)
sys.modules['time'] = tm
class Sock:
    def __init__(s):
        s.buf = [bytearray(c) for c in SC.get('chunks', [])]
        s.closed = False
    def settimeout(s, t): calls.append('timeout:%.4f' % t)
    def connect(s, p):
        calls.append('connect:' + p); _tick('conn')
        if SC.get('connfail'): raise OSError('refused')
    def getsockopt(s, *a):
        _tick('cred')
        c = SC.get('peercred', {'pid': 4242, 'uid': 1000})
        return struct.pack('3i', c['pid'], c['uid'], 1000)
    def recv(s, n):                     # stream semantics: <=n bytes of the
        calls.append('recv:' + str(n)); _tick('recv')
        if SC.get('recvfail'): raise OSError('reset')
        if not s.buf:
            calls.append('eof'); return b''
        out = bytes(s.buf[0][:n])
        s.buf[0] = s.buf[0][n:]
        if not s.buf[0]: s.buf.pop(0)
        return out
    def close(s): s.closed = True; calls.append('sockclose')
sm = types.ModuleType('socket')
sm.AF_UNIX, sm.SOCK_STREAM, sm.SOL_SOCKET, sm.SO_PEERCRED = 1, 1, 1, 17
sm.socket = lambda *a: Sock()
sys.modules['socket'] = sm
_real_open = builtins.open
_n = {}
def _open(p, mode='r', *a, **k):
    calls.append('open:' + p)
    _tick('stat' if p.endswith('/stat') else
          'env' if p.endswith('/environ') else 'open')
    c = SC.get('readfiles', {}).get(p)
    if c is None: raise FileNotFoundError(p)
    if isinstance(c, list):            # per-call content: proves pre/post
        i = _n.get(p, 0); _n[p] = i + 1   # checks actually re-read the file
        c = c[min(i, len(c) - 1)]
    if isinstance(c, str): c = c.encode()
    return io.BytesIO(c) if 'b' in mode else io.StringIO(c.decode())
builtins.open = _open
sys.argv = ['ident', REQ]
try:
    exec(compile(_real_open(SRC).read(), 'ident', 'exec'))
finally:
    sys.stderr.write('CALLS ' + json.dumps(calls) + '\n')
`

const STAT_OK = '4242 (opencode) S ' + Array(18).fill('0').join(' ') + ' 999 0 0'
const FRAME = { seq: 7, nonce: 'a'.repeat(32), pid: 4242, gen: '999',
  t_ms: 4500, pv: 1, ver: '2.2.5', kind: 'route',
  route: { type: 'session', sessionID: 'ses_a' } }
const SOCK_P = '/st/wherdr/opencode-ident/v1/4242-999/current.sock'
const CHAIN = {
  '/st/wherdr': { k: 'dir', m: 0o700, u: 1000 },
  '/st/wherdr/opencode-ident': { k: 'dir', m: 0o700, u: 1000 },
  '/st/wherdr/opencode-ident/v1': { k: 'dir', m: 0o700, u: 1000 },
  '/st/wherdr/opencode-ident/v1/4242-999': { k: 'dir', m: 0o700, u: 1000 },
  [SOCK_P]: { k: 'sock', m: 0o600, u: 1000 },
}
const base = (over: Record<string, unknown> = {}) => ({
  proc: { uid: 1000 },
  readfiles: { '/proc/4242/stat': STAT_OK, '/proc/4242/environ': 'XDG_STATE_HOME=/st\0' },
  links: { '/proc/4242/ns/pid': 'pid:[123]', '/proc/self/ns/pid': 'pid:[123]' },
  files: CHAIN,
  chunks: frameChunks(FRAME),
  peercred: { pid: 4242, uid: 1000 },
  req: { pid: 4242, uid: 1000, gen: '999', ns: 'pid:[123]' },
  ...over,
})
const chunkBytes = (b: Buffer) => [...b.values()]
// encode a frame as well-formed UTF-16LE/UTF-32LE with BOM — Python's
// json.loads(bytes) auto-detects these; the wire contract is UTF-8 ONLY
const encChunks = (f: unknown, enc: 'utf16le' | 'utf32le') => {
  const s = JSON.stringify(f)
  if (enc === 'utf16le')
    return [chunkBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]))]
  const b = Buffer.alloc(4 + s.length * 4)
  b.writeUInt32LE(0xfeff, 0)
  for (let i = 0; i < s.length; i++) b.writeUInt32LE(s.charCodeAt(i), 4 + i * 4)
  return [chunkBytes(b)]
}
const frameChunks = (f: unknown, n = 2) => {
  const b = Buffer.from(JSON.stringify(f))
  const mid = Math.ceil(b.length / n)
  const out: number[][] = []
  for (let i = 0; i < b.length; i += mid) out.push(chunkBytes(b.subarray(i, i + mid)))
  return out
}

// run the REAL helper body under owned python3 with the fake prelude
async function helper(sc: Record<string, unknown>) {
  const d = mkdtempSync(path.join(tmpdir(), 'oc-ident-'))
  dirs.push(d)
  const cfg = path.join(d, 'sc.json'), py = path.join(d, 'h.py'),
    wrap = path.join(d, 'w.py')
  writeFileSync(cfg, JSON.stringify(sc))
  writeFileSync(py, OPENCODE_IDENT)
  writeFileSync(wrap, PRELUDE)
  const r = await run('python3', [wrap, cfg, py, JSON.stringify(sc.req)],
    { timeout: 8000 }).catch(e => e)
  const stdout = String(r.stdout ?? ''), stderr = String(r.stderr ?? '')
  const lines = stdout.trim().split('\n').filter(Boolean)
  const out = lines.length ? JSON.parse(lines[lines.length - 1]) : null
  const cm = stderr.match(/CALLS (\[.*\])/)
  return { out, calls: cm ? JSON.parse(cm[1]) as string[] : [], stderr }
}

it('healthy: split read to EOF, exact frame + target-clock age, fds closed', async () => {
  const r = await helper(base())
  expect(r.out.ok).toBe(true)
  expect(r.out.req).toEqual(base().req)              // exact request echo
  expect(r.out.frame).toMatchObject({ seq: 7, nonce: 'a'.repeat(32),
    pid: 4242, gen: '999', pv: 1, ver: '2.2.5', kind: 'route',
    route: { type: 'session', sessionID: 'ses_a' } })
  expect(r.out.digest).toMatch(/^[0-9a-f]{64}$/)    // wire-byte identity
  expect(r.out.age_ms).toBe(500)                    // target clock 5000-4500
  // split stream actually exercised: >=2 reads BEFORE the EOF read
  const recvs = r.calls.filter(c => c.startsWith('recv:'))
  expect(recvs.length).toBeGreaterThanOrEqual(2)
  expect(r.calls.indexOf('eof')).toBeGreaterThan(r.calls.lastIndexOf(recvs[0]))
  expect(r.calls).toContain('close:9')              // pidfd released
  expect(r.calls).toContain('sockclose')            // socket released
})

it('HOME fallback requires actual ok + exact derived path; no env -> missing', async () => {
  const filesH = Object.fromEntries(Object.entries(CHAIN)
    .map(([k, v]) => [k.replace('/st', '/h/.local/state'), v]))
  const r = await helper(base({
    readfiles: { '/proc/4242/stat': STAT_OK, '/proc/4242/environ': 'HOME=/h\0' },
    files: filesH }))
  expect(r.out.ok).toBe(true)                       // not 'any truthy' — real ok
  expect(r.calls).toContain(
    'connect:/h/.local/state/wherdr/opencode-ident/v1/4242-999/current.sock')
  const r2 = await helper(base({
    readfiles: { '/proc/4242/stat': STAT_OK, '/proc/4242/environ': '' } }))
  expect(r2.out.error).toBe('env_missing')
})

it('binding: birth/uid/ns/zombie/pidfd/selfns mismatches refuse, peer must match', async () => {
  const statOf = (gen: string) => STAT_OK.replace('999', gen)
  const cases: [string, Record<string, unknown>, string][] = [
    ['birth', base({ readfiles: { '/proc/4242/stat': statOf('888'), '/proc/4242/environ': 'XDG_STATE_HOME=/st\0' } }), 'proc_mismatch'],
    ['post birth', base({ readfiles: { '/proc/4242/stat': [STAT_OK, statOf('888')], '/proc/4242/environ': 'XDG_STATE_HOME=/st\0' } }), 'proc_mismatch'],
    ['uid', base({ proc: { uid: 2000 } }), 'proc_mismatch'],
    ['ns', base({ links: { '/proc/4242/ns/pid': 'pid:[9]', '/proc/self/ns/pid': 'pid:[123]' } }), 'proc_mismatch'],
    // selected process in a DIFFERENT pid namespace than this helper: the
    // caller's ns string matching the request is not proof — refuse
    ['self ns', base({ links: { '/proc/4242/ns/pid': 'pid:[9]', '/proc/self/ns/pid': 'pid:[9]' } }), 'proc_mismatch'],
    ['zombie', base({ readfiles: { '/proc/4242/stat': STAT_OK.replace(') S', ') Z'), '/proc/4242/environ': 'XDG_STATE_HOME=/st\0' } }), 'proc_dead'],
    ['nopidfd', base({ nopidfd: true }), 'pidfd_unavailable'],
    ['poll err', base({ pollerr: true }), 'poll_failed'],
    // healthy JSON frame from the WRONG kernel peer: peercred decides
    ['peer pid', base({ peercred: { pid: 777, uid: 1000 } }), 'peer_mismatch'],
    ['peer uid', base({ peercred: { pid: 4242, uid: 33 } }), 'peer_mismatch'],
    ['dead post', base({ dead_at: 2 }), 'proc_dead'],
  ]
  for (const [label, sc, err] of cases) {
    const r = await helper(sc)
    expect(r.out.error, label).toBe(err)
    // pidfd released whenever it was opened — nopidfd and the early self-ns
    // refusal happen before pidfd_open, so no fd exists to close there
    if (label !== 'nopidfd' && label !== 'self ns')
      expect(r.calls, label).toContain('close:9')
  }
  // wrong-peer still carried a healthy-looking frame: kernel creds decided
  const wrong = await helper(base({ peercred: { pid: 777, uid: 1000 } }))
  expect(wrong.out.error).toBe('peer_mismatch')
  expect(wrong.calls).toContain('sockclose')
})

it('env/path: exact own root; unsafe/foreign/missing objects refused', async () => {
  for (const [label, sc, err] of [
    ['relative xdg', base({ readfiles: { '/proc/4242/stat': STAT_OK, '/proc/4242/environ': 'XDG_STATE_HOME=rel\0HOME=/h\0' } }), 'env_unsafe'],
    ['foreign dir', base({ files: { ...CHAIN, '/st/wherdr/opencode-ident/v1': { k: 'dir', m: 0o700, u: 2000 } } }), 'path_unsafe'],
    ['writable dir', base({ files: { ...CHAIN, '/st/wherdr': { k: 'dir', m: 0o777 } } }), 'path_unsafe'],
    ['link dir', base({ files: { ...CHAIN, '/st/wherdr/opencode-ident': { k: 'link' } } }), 'path_unsafe'],
    // private modes promised by the producer: leaf dir must be 0700,
    // socket must be 0600 — a laxer object is never adopted
    ['leaf 0755', base({ files: { ...CHAIN, '/st/wherdr/opencode-ident/v1/4242-999': { k: 'dir', m: 0o755, u: 1000 } } }), 'path_unsafe'],
    ['sock 0644', base({ files: { ...CHAIN, [SOCK_P]: { k: 'sock', m: 0o644, u: 1000 } } }), 'path_unsafe'],
    ['no socket', base({ files: Object.fromEntries(Object.entries(CHAIN).filter(([k]) => !k.endsWith('.sock'))) }), 'path_missing'],
    ['foreign sock', base({ files: { ...CHAIN, [SOCK_P]: { k: 'sock', m: 0o600, u: 9 } } }), 'path_unsafe'],
  ] as const) {
    const r = await helper(sc as Record<string, unknown>)
    expect(r.out.error, label).toBe(err)
  }
})

it('wire: overcap/connect/read/schema fail closed; echo must match request', async () => {
  for (const [label, sc, err] of [
    ['overcap cap+1', base({ chunks: [chunkBytes(Buffer.alloc(5000, 65))] }), 'frame_too_large'],
    ['connect fail', base({ connfail: true }), 'connect_failed'],
    ['recv fail', base({ recvfail: true }), 'read_failed'],
    ['bad ver', base({ chunks: frameChunks({ ...FRAME, ver: '2.2.4' }) }), 'frame_invalid'],
    ['bad kind', base({ chunks: frameChunks({ ...FRAME, kind: 'exec' }) }), 'frame_invalid'],
    ['pid echo', base({ chunks: frameChunks({ ...FRAME, pid: 5 }) }), 'frame_mismatch'],
    ['gen echo', base({ chunks: frameChunks({ ...FRAME, gen: '8' }) }), 'frame_mismatch'],
    ['bad nonce', base({ chunks: frameChunks({ ...FRAME, nonce: 'x' }) }), 'frame_invalid'],
    ['bad json', base({ chunks: [chunkBytes(Buffer.from('{oops'))] }), 'frame_invalid'],
    ['bad utf8', base({ chunks: [chunkBytes(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))] }), 'frame_invalid'],
    ['session no sid', base({ chunks: frameChunks({ ...FRAME, route: { type: 'session' } }) }), 'frame_invalid'],
    ['home with sid', base({ chunks: frameChunks({ ...FRAME, route: { type: 'home', sessionID: 'ses_a' } }) }), 'frame_invalid'],
    ['route_err+route', base({ chunks: frameChunks({ ...FRAME, kind: 'route_err', err: 'getter_failed' }) }), 'frame_invalid'],
    ['foreign err', base({ chunks: frameChunks({ ...FRAME, kind: 'route_err', err: 'raw_secret', route: undefined }) }), 'frame_invalid'],
    ['bad sid', base({ chunks: frameChunks({ ...FRAME, route: { type: 'session', sessionID: 'evil' } }) }), 'frame_invalid'],
    ['pv bool', base({ chunks: frameChunks({ ...FRAME, pv: true }) }), 'frame_invalid'],
    ['pid bool', base({ chunks: frameChunks({ ...FRAME, pid: true }) }), 'frame_invalid'],
    ['seq unsafe', base({ chunks: frameChunks({ ...FRAME, seq: 9007199254740993 }) }), 'frame_invalid'],
    ['t_ms unsafe', base({ chunks: frameChunks({ ...FRAME, t_ms: 9007199254740993 }) }), 'frame_invalid'],
    // WELL-FORMED UTF-16/32 encodings of the valid frame: Python autodetect
    // must never accept another encoding — strict UTF-8 only, fixed refusal
    ['utf16 frame', base({ chunks: encChunks(FRAME, 'utf16le') }), 'frame_invalid'],
    ['utf32 frame', base({ chunks: encChunks(FRAME, 'utf32le') }), 'frame_invalid'],
    ['err code ok', base({ chunks: frameChunks({ ...FRAME, kind: 'route_err', err: 'getter_failed', route: undefined }) }), undefined],
  ] as const) {
    const r = await helper(sc as Record<string, unknown>)
    if (err) expect(r.out.error, label).toBe(err)
    else expect(r.out.ok, label).toBe(true)
    if (label !== 'connect fail') expect(r.calls, label).toContain('close:9')
  }
  // non-session tags reduce to the fixed tag — private marker never leaves
  const marker = 'fixture_private_marker'
  const m = await helper(base({
    chunks: frameChunks({ ...FRAME, route: { type: marker } }) }))
  expect(m.out.ok).toBe(true)
  expect(m.out.frame.route).toEqual({ type: 'non-session' })
  expect(JSON.stringify(m.out)).not.toContain(marker)
})

it('deadline: ONE aggregate budget; late at ANY phase refuses closed', async () => {
  // step: phase->[per-call clock deltas] — connect/proc/recv/post/final
  const seqs: [string, Record<string, number[]>, Record<string, unknown>, string][] = [
    ['post-connect', { conn: [2] }, {}, 'deadline'],
    ['mid-read drip', { recv: [0.4, 0.4, 0.4] }, { chunks: frameChunks(FRAME, 4) }, 'deadline'],
    ['post-read', { recv: [0.1, 0.1, 0.9] }, {}, 'deadline'],
    // late AFTER post-checks but otherwise fully healthy: the final
    // aggregate check must still refuse, never emit a stale success
    ['late final', { stat: [0, 1.2] }, {}, 'deadline'],
    // budget already gone before connect: no clamped 0.001 connect attempt
    ['pre-expired', { conn: [2], fs: [3] }, {}, 'deadline'],
  ]
  for (const [label, step, over, err] of seqs) {
    const r = await helper(base({ step, ...over }))
    expect(r.out.error, label).toBe(err)
    expect(r.calls, label).toContain('close:9')
  }
  // late connect attempt must never happen once the budget is gone
  const late = await helper(base({ step: { fs: [1.5] } }))
  expect(late.out.error).toBe('deadline')
  expect(late.calls.filter(c => c.startsWith('connect:'))).toHaveLength(0)
  // healthy neighbor: slack in every phase
  const ok = await helper(base({ step: { conn: [0.05], recv: [0.05, 0.05, 0.05] } }))
  expect(ok.out.ok).toBe(true)
})
