// 6l2 read-side helper + typed wrapper: ONE fixed bounded operation that
// asks the selected ordinary process's own OpenCode-identity producer for
// the current projected route. Read-only end to end: readonly pidfd (no
// raw-PID signal/kill0 fallback, no waitpid/child assumption), bounded
// /proc/environ for the target's own XDG/HOME, pinned versioned path,
// kernel SO_PEERCRED, incremental bounded read to EOF under ONE aggregate
// <=1s monotonic deadline. The reply across the machine boundary is a
// bounded identity-only envelope — validated schema or a fixed error key,
// never a raw frame fragment, stderr, traceback or environment.
// No PY_COMMON/discovery/CLI/HTTP — this helper stands alone.
import type { ExecResult, ShellExec } from './fsx'
import { frameSchemaOk, normalizeFrame, FRESH_MS, FUTURE_MS, RECEIPT_MS,
  type IdentFrame } from './opencodeIdentity'
import { HELPER_ERRORS, helperTimeout, replyObject,
  validHome, failure } from './opencodeTransport'

export const OPENCODE_IDENT = String.raw`
import hashlib, json, os, re, select, socket, stat as ST, struct, sys, time

FRAME_CAP = 4096
ENV_CAP = 65536
STAT_CAP = 8192
REQ_CAP = 1024
GEN_OK = re.compile(r'\d{1,20}$')
NS_OK = re.compile(r'[a-z_]+:\[\d+\]$')
NONCE_OK = re.compile(r'[0-9a-f]{32}$')
SES_OK = re.compile(r'ses_[0-9A-Za-z_-]{1,124}$')
SAFE_MAX = 2 ** 53 - 1               # JSON safe-integer bound, as Node schema
# err is a FIXED producer code, never reflected arbitrary text
PRODUCER_ERRS = ('getter_failed', 'frame_over_cap')
KINDS = ('route', 'route_err')

class Fail(Exception):
    def __init__(s, key):
        super().__init__(key)
        s.key = key

def emit(v):
    sys.stdout.write(json.dumps(v) + '\n')
    sys.stdout.flush()

def rd(p, cap):
    with open(p, 'rb') as f:
        d = f.read(cap + 1)
    return d

# own-process evidence: uid via /proc dir owner, birth via stat field 19,
# pid-namespace compatibility with THIS helper's kernel ns, non-zombie
# liveness. Every check raises Fail.
def proc_state(pid, uid, gen, self_ns):
    try:
        st = os.stat('/proc/' + str(pid))
    except OSError:
        raise Fail('proc_missing')
    if st.st_uid != uid:
        raise Fail('proc_mismatch')
    try:
        raw = rd('/proc/' + str(pid) + '/stat', STAT_CAP)
    except OSError:
        raise Fail('proc_missing')
    if len(raw) > STAT_CAP:
        raise Fail('proc_invalid')
    i = raw.rfind(b')')
    if i < 0:
        raise Fail('proc_invalid')
    f = raw[i + 2:].split()
    if len(f) < 20:
        raise Fail('proc_invalid')
    if f[0] == b'Z':
        raise Fail('proc_dead')
    if f[19].decode('ascii', 'strict') != gen:
        raise Fail('proc_mismatch')
    try:
        if os.readlink('/proc/' + str(pid) + '/ns/pid') != self_ns:
            raise Fail('proc_mismatch')
    except Fail:
        raise
    except OSError:
        raise Fail('proc_mismatch')

# a pidfd poll that ERRORS is not proof of life — refuse closed, never
# report alive on a failed check
def dead(pidfd):
    try:
        return bool(select.select([pidfd], [], [], 0)[0])
    except Exception:
        raise Fail('poll_failed')

# ONLY the selected process's own environ, read-bounded before decode; the
# coordinator's own environment/home is never consulted. Invalid nonempty
# XDG fails closed; HOME is the fallback only when XDG is absent.
def env_root(pid):
    try:
        raw = rd('/proc/' + str(pid) + '/environ', ENV_CAP)
    except OSError:
        raise Fail('env_missing')
    if len(raw) > ENV_CAP:
        raise Fail('env_oversize')
    xdg = home = None
    for kv in raw.split(b'\0'):
        if kv.startswith(b'XDG_STATE_HOME='):
            xdg = kv[15:].decode('utf-8', 'surrogateescape')
        elif kv.startswith(b'HOME='):
            home = kv[5:].decode('utf-8', 'surrogateescape')
    def ok(p):
        return isinstance(p, str) and len(p) > 1 and p[0] == '/' and '\0' not in p
    if xdg:
        if not ok(xdg):
            raise Fail('env_unsafe')
        return xdg
    if ok(home):
        return home + '/.local/state'
    raise Fail('env_missing')

def frame_out(f, pid, gen):
    if not isinstance(f, dict):
        raise Fail('frame_invalid')
    need = {'seq', 'nonce', 'pid', 'gen', 't_ms', 'pv', 'ver', 'kind'}
    if not need <= set(f) or set(f) - need - {'route', 'err'}:
        raise Fail('frame_invalid')
    # strict int types BEFORE value checks: JSON true equals 1 in Python —
    # a malformed protocol field must never normalize into a valid frame
    pv = f['pv']
    if not isinstance(pv, int) or isinstance(pv, bool) or pv != 1 \
            or f['ver'] != '2.2.5':
        raise Fail('frame_invalid')
    if not isinstance(f['nonce'], str) or not NONCE_OK.fullmatch(f['nonce']):
        raise Fail('frame_invalid')
    if not isinstance(f['pid'], int) or isinstance(f['pid'], bool) \
            or not isinstance(f['gen'], str):
        raise Fail('frame_invalid')
    if f['pid'] != pid or f['gen'] != gen:
        raise Fail('frame_mismatch')
    if not isinstance(f['seq'], int) or isinstance(f['seq'], bool) \
            or not 1 <= f['seq'] <= SAFE_MAX:
        raise Fail('frame_invalid')
    tm = f['t_ms']
    if not isinstance(tm, int) or isinstance(tm, bool) \
            or not 0 <= tm <= SAFE_MAX:
        raise Fail('frame_invalid')
    if f['kind'] not in KINDS:
        raise Fail('frame_invalid')
    out = {'seq': f['seq'], 'nonce': f['nonce'], 'pid': pid, 'gen': gen,
        't_ms': tm, 'pv': 1, 'ver': '2.2.5', 'kind': f['kind']}
    # tagged sets: 'route' carries a route and NO err; a session route
    # REQUIRES the exact id while every other type carries NO identity;
    # 'route_err' carries a fixed producer code and NO route
    if f['kind'] == 'route':
        if 'err' in f:
            raise Fail('frame_invalid')
        rt = f.get('route')
        if not isinstance(rt, dict) or not isinstance(rt.get('type'), str):
            raise Fail('frame_invalid')
        t = rt['type']
        if not 0 < len(t) <= 32 or '\0' in t:
            raise Fail('frame_invalid')
        if set(rt) == {'type', 'sessionID'}:
            sid = rt['sessionID']
            if t != 'session' or not isinstance(sid, str) \
                    or not SES_OK.fullmatch(sid):
                raise Fail('frame_invalid')
            out['route'] = {'type': 'session', 'sessionID': sid}
        elif set(rt) == {'type'} and t != 'session':
            # any non-session tag reduces to the FIXED tag — a private or
            # foreign route-type marker is never forwarded
            out['route'] = {'type': 'non-session'}
        else:
            raise Fail('frame_invalid')
    else:
        if 'route' in f or f.get('err') not in PRODUCER_ERRS:
            raise Fail('frame_invalid')
        out['err'] = f['err']
    return out

def main():
    deadline = time.monotonic() + 1.0            # ONE aggregate budget
    def left():
        return deadline - time.monotonic()
    raw = sys.argv[1] if len(sys.argv) > 1 else ''
    if not raw or len(raw.encode('utf-8', 'surrogateescape')) > REQ_CAP:
        raise Fail('invalid_request')
    try:
        req = json.loads(raw)
    except ValueError:
        raise Fail('invalid_request')
    if not isinstance(req, dict) or set(req) != {'pid', 'uid', 'gen', 'ns'}:
        raise Fail('invalid_request')
    pid, uid, gen, ns = req['pid'], req['uid'], req['gen'], req['ns']
    if not isinstance(pid, int) or isinstance(pid, bool) \
            or not 0 < pid <= 4194304 \
            or not isinstance(uid, int) or isinstance(uid, bool) \
            or not 0 <= uid <= 4294967295 \
            or not isinstance(gen, str) or not GEN_OK.fullmatch(gen) \
            or not isinstance(ns, str) or not NS_OK.fullmatch(ns):
        raise Fail('invalid_request')
    # this helper's OWN kernel pid namespace is the compatibility anchor —
    # the caller's ns string alone never proves a shared namespace
    try:
        self_ns = os.readlink('/proc/self/ns/pid')
    except OSError:
        raise Fail('proc_missing')
    if ns != self_ns:
        raise Fail('proc_mismatch')
    try:
        pidfd = os.pidfd_open(pid, 0)            # REQUIRED; no PID fallback
    except (AttributeError, OSError):
        raise Fail('pidfd_unavailable')
    try:
        if left() <= 0:
            raise Fail('deadline')
        proc_state(pid, uid, gen, self_ns)       # pre-check
        if dead(pidfd):
            raise Fail('proc_dead')
        base = env_root(pid)
        leaf = base + '/wherdr/opencode-ident/v1/%d-%s' % (pid, gen)
        path = leaf + '/current.sock'
        if len(path.encode('utf-8', 'surrogateescape')) > 107 or '\0' in path:
            raise Fail('path_unsafe')
        for comp in (base + '/wherdr', base + '/wherdr/opencode-ident',
                base + '/wherdr/opencode-ident/v1', leaf):
            try:
                st = os.lstat(comp)
            except OSError:
                raise Fail('path_missing')
            if not ST.S_ISDIR(st.st_mode) or ST.S_ISLNK(st.st_mode) \
                    or st.st_uid != uid or st.st_mode & 0o22:
                raise Fail('path_unsafe')
            if comp == leaf and ST.S_IMODE(st.st_mode) != 0o700:
                raise Fail('path_unsafe')       # producer private dir mode
        try:
            st = os.lstat(path)
        except OSError:
            raise Fail('path_missing')
        if not ST.S_ISSOCK(st.st_mode) or st.st_uid != uid \
                or ST.S_IMODE(st.st_mode) != 0o600:
            raise Fail('path_unsafe')           # producer private sock mode
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            l = left()                          # the ONE aggregate budget
            if l <= 0:                          # gates the connect too — an
                raise Fail('deadline')          # expired window never clamps
            s.settimeout(l)
            try:
                s.connect(path)
            except OSError:
                raise Fail('connect_failed')
            if left() <= 0:
                raise Fail('deadline')
            try:
                cred = s.getsockopt(socket.SOL_SOCKET,
                    socket.SO_PEERCRED, struct.calcsize('3i'))
                cpid, cuid, _ = struct.unpack('3i', cred)
            except OSError:
                raise Fail('peer_unavailable')
            if cpid != pid or cuid != uid:      # kernel peer decides
                raise Fail('peer_mismatch')
            data = b''
            while len(data) <= FRAME_CAP:       # incremental to EOF/overcap
                l = left()
                if l <= 0:
                    raise Fail('deadline')
                s.settimeout(min(l, 0.25))
                try:
                    chunk = s.recv(min(FRAME_CAP + 1 - len(data), 65536))
                except OSError:
                    raise Fail('read_failed')
                if not chunk:
                    break                       # real EOF only
                data += chunk
            if left() <= 0:
                raise Fail('deadline')          # post-blocking check
            if len(data) > FRAME_CAP:
                raise Fail('frame_too_large')
        finally:
            s.close()                           # read-only close, no signal
        proc_state(pid, uid, gen, self_ns)       # post-check
        if dead(pidfd):
            raise Fail('proc_dead')
        # STRICT utf-8 BEFORE JSON: json.loads(bytes) would auto-detect and
        # accept UTF-16/32 — the wire contract is UTF-8 only, fixed refusal
        try:
            text = data.decode('utf-8', 'strict')
        except UnicodeDecodeError:
            raise Fail('frame_invalid')
        try:
            f = json.loads(text)
        except ValueError:
            raise Fail('frame_invalid')
        out = frame_out(f, pid, gen)
        if left() <= 0:                         # FINAL aggregate check — a
            raise Fail('deadline')              # late result never emits
        # frame t_ms is the producer's wallclock; age is computed HERE on
        # the target machine — the coordinator never compares clocks.
        # digest is the ONLY byte-identity witness of the exact wire bytes.
        emit({'ok': True, 'req': req, 'frame': out,
            'digest': hashlib.sha256(data).hexdigest(),
            'age_ms': int(time.time() * 1000 - out['t_ms'])})
        sys.exit(0)
    finally:
        os.close(pidfd)

try:
    main()
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
`

export const IDENT_ERRORS = new Set([
  'invalid_request', 'pidfd_unavailable', 'proc_missing', 'proc_dead',
  'proc_invalid', 'proc_mismatch', 'poll_failed', 'env_missing',
  'env_oversize', 'env_unsafe', 'path_missing', 'path_unsafe',
  'peer_unavailable', 'peer_mismatch', 'connect_failed', 'read_failed',
  'frame_too_large', 'frame_invalid', 'frame_mismatch', 'deadline',
  'helper_error',
])
const REPLY_LIMIT = 8192
const REQUEST_LIMIT = 1024
const GEN_OK = /^\d{1,20}$/
const NS_OK = /^[a-z_]+:\[\d+\]$/

export interface IdentRequest { pid: number, uid: number, gen: string, ns: string }

export type OpencodeReadIdentity =
  | { ok: true, frame: IdentFrame, digest: string, ageMs: number }
  | { ok: false, error: string }

const requestOk = (v: unknown): v is IdentRequest => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return Object.keys(r).sort().join() === 'gen,ns,pid,uid'
    && typeof r.pid === 'number' && Number.isSafeInteger(r.pid)
    && r.pid > 0 && r.pid <= 4194304
    && typeof r.uid === 'number' && Number.isSafeInteger(r.uid)
    && r.uid >= 0 && r.uid <= 4294967295
    && typeof r.gen === 'string' && GEN_OK.test(r.gen)
    && typeof r.ns === 'string' && NS_OK.test(r.ns)
}

// Explicit per-call opt-in: the only way anything runs is a caller passing
// opts.enabled === true AND a fully valid pinned request. Disabled or
// invalid input => zero exec/proc/socket work, no defaults.
export async function opencodeReadIdentity(exec: ShellExec, home: string,
    req: unknown, opts: { enabled?: boolean }): Promise<OpencodeReadIdentity> {
  if (opts?.enabled !== true) return { ok: false, error: 'unavailable' }
  if (!validHome(home) || !requestOk(req)) return { ok: false, error: 'unavailable' }
  // pin the submitted context before any machine work: a caller mutating its
  // object afterwards can never change what was sent or what is echoed back
  const { pid, uid, gen, ns } = req
  const body = JSON.stringify({ pid, uid, gen, ns })
  if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT) return { ok: false, error: 'unavailable' }
  let r: ExecResult
  const t0 = performance.now()               // coordinator monotonic budget:
  try {                                     // ShellExec's timeout option is
    r = await exec('exec python3 -X utf8 -c "$1" "$2"', [OPENCODE_IDENT, body],
      { timeoutMs: helperTimeout(5000), maxBytes: REPLY_LIMIT })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  const elapsed = performance.now() - t0     // total dispatch duration is a
  if (elapsed > RECEIPT_MS)                  // safe upper bound on delivery —
    return { ok: false, error: 'unavailable' } // a late exit-0 is refused too
  const reply = replyObject(r, REPLY_LIMIT)
  if (reply) {
    const keys = Object.keys(reply).sort()
    // the returned age carries a conservative integer transport charge so
    // a near-fresh frame that spent time on the wire cannot be retained —
    // the ORIGINAL future-skew bound still applies to the raw observation
    const ageMs = Number.isSafeInteger(reply.age_ms)
      ? (reply.age_ms as number) + Math.ceil(elapsed) : NaN
    if (r.code === 0 && keys.join() === 'age_ms,digest,frame,ok,req'
        && reply.ok === true
        && ageMs <= FRESH_MS                 // charged target-side freshness
        && Number.isSafeInteger(reply.age_ms)
        && (reply.age_ms as number) >= -FUTURE_MS   // raw future bound
        && typeof reply.digest === 'string' && DIGEST_RE.test(reply.digest)
        && reqEchoOk(reply.req, pid, uid, gen, ns)
        && frameSchemaOk(reply.frame)
        && reply.frame.pid === pid && reply.frame.gen === gen) {
      return { ok: true, frame: normalizeFrame(reply.frame),
        digest: reply.digest, ageMs }
    }
    if (keys.join() === 'error' && typeof reply.error === 'string'
        && (IDENT_ERRORS.has(reply.error) || HELPER_ERRORS.has(reply.error))) {
      return { ok: false, error: reply.error }
    }
  }
  return { ok: false, error: failure(r) }
}

const DIGEST_RE = /^[0-9a-f]{64}$/
// the helper must echo the PINNED request back — a foreign or stale reply
// with a healthy-looking frame is never adopted
const reqEchoOk = (v: unknown, pid: number, uid: number,
    gen: string, ns: string): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === 'gen,ns,pid,uid'
  && (v as Record<string, unknown>).pid === pid
  && (v as Record<string, unknown>).uid === uid
  && (v as Record<string, unknown>).gen === gen
  && (v as Record<string, unknown>).ns === ns
