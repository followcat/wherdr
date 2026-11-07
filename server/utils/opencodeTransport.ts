// OpenCode transport runs on the agent's own machine: a local child process
// here, machine.exec over the multiplexed connection on a remote core host.
// Adapted from wherdr v2's OpenCode transport, reduced to read-only fixed
// operations. Credentials and the loopback address never leave that machine:
// replies are a fixed error key, an HTTP status, sanitized metadata, or, for
// the fixed chunk helper in opencodeChunk.ts only, a validated bounded piece
// of a snapshot the caller already fingerprinted. Never a password, URL or
// diagnostic.
// PY_COMMON is the shared half of every fixed helper: discovery, the bounded
// debug probe, URL/credential validation and the authenticated /api/info
// handshake that yields the opaque server generation. Each helper composes
// it with a single-purpose main; nothing below is duplicated per op.
// Keep the -c payload ASCII for service/SSH launchers that decode argv before
// applying Python's UTF-8 setting.
import type { ExecResult, ShellExec } from './fsx'

export const PY_COMMON = String.raw`
import base64, hashlib, json, math, os, pathlib, re, select, shutil, signal, subprocess, sys, time
import urllib.request, urllib.error, urllib.parse

home = sys.argv[1]
READ_LIMIT = 24 * 1024 * 1024
REQUEST_LIMIT = 4096

def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

class Fail(Exception):
    def __init__(self, key):
        super().__init__(key)
        self.key = key

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

# One bounded version shape everywhere: an optional single v, a bounded 2.x
# numeric release and an optional suffix, at most 40 characters. Anything
# else is not a version; only the numeric release is ever emitted, so a
# supplied label can never be reflected back.
VERSION = re.compile(r'v?(2\.\d+(?:\.\d+)?)(?:[-+][0-9A-Za-z.-]{1,30})?')
def version(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    m = VERSION.fullmatch(value)
    return m.group(1) if m else None

def kill(probe):
    try:
        os.killpg(probe.pid, signal.SIGKILL) if hasattr(os, 'killpg') else probe.kill()
    except OSError:
        pass
    try:
        probe.wait(timeout=1)
    except Exception:
        pass

def debug_paths(binary, env):
    # One bounded shot: at most 4 KiB is read while the CLI runs, and one
    # four-second deadline covers output, EOF and exit. The owned process
    # group dies on either breach; its output stays on the machine.
    probe = subprocess.Popen([binary, 'debug', 'paths', 'state'], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    deadline = time.monotonic() + 4
    out = b''
    live = True
    try:
        while len(out) <= 4096:
            left = deadline - time.monotonic()
            if left <= 0:
                live = False
                break
            if not select.select([probe.stdout], [], [], left)[0]:
                live = False
                break
            chunk = os.read(probe.stdout.fileno(), 4097 - len(out))
            if not chunk:
                break
            out += chunk
        good = live and len(out) <= 4096
        if good and probe.poll() is None:
            left = deadline - time.monotonic()
            if left > 0:
                try:
                    probe.wait(timeout=left)
                except subprocess.TimeoutExpired:
                    pass
        return out if good and probe.poll() == 0 else None
    finally:
        # The owned group dies with the probe whether or not its leader is
        # already gone: a detached descendant must never outlive discovery.
        kill(probe)

def discover():
    own = os.path.realpath(os.environ.get('HOME', '')) == os.path.realpath(home)
    state = pathlib.Path(os.environ.get('XDG_STATE_HOME', '') if own else '')
    # A relative XDG_STATE_HOME would resolve against our cwd, not the
    # account's; only an absolute one is honored.
    if not str(state) or str(state) == '.' or not state.is_absolute():
        state = pathlib.Path(home) / '.local' / 'state'
    file = state / 'opencode' / 'service.json'
    if not file.is_file():
        # Fallback: ask the CLI where its state lives. Fixed argv, one bounded
        # shot on a deadline; it never starts a service.
        candidates = [str(pathlib.Path(home) / p) for p in ['.opencode/bin/opencode', '.local/bin/opencode']]
        candidates += [shutil.which('opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']
        binary = next((p for p in candidates if p and os.access(p, os.X_OK)), None)
        if binary:
            env = dict(os.environ, HOME=home, LC_ALL='C')
            if not own:
                for k in ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']:
                    env.pop(k, None)
            try:
                found = debug_paths(binary, env)
            except OSError:
                found = None
            if found:
                found = found.decode('utf-8', 'replace').strip()
                if os.path.isabs(found):
                    file = pathlib.Path(found) / 'service.json'
    if not file.is_file():
        raise Fail('not_running')
    # Bounded by the read itself, not a stat followed by an unbounded read.
    try:
        with file.open('rb') as body:
            raw = body.read(65537)
    except OSError:
        raise Fail('state_invalid')
    if len(raw) > 65536:
        raise Fail('state_invalid')
    try:
        service = json.loads(raw)
    except ValueError:
        raise Fail('state_invalid')
    if not isinstance(service, dict):
        raise Fail('state_invalid')
    raw_url = service.get('url')
    # Userinfo is refused even when empty, delimiters even when bare, and any
    # control or space anywhere in the raw text.
    if not isinstance(raw_url, str) or re.search(r'[\x00-\x20\x7f?#]', raw_url):
        raise Fail('url_unsafe')
    try:
        url = urllib.parse.urlsplit(raw_url)
        port = url.port
    except ValueError:
        raise Fail('url_unsafe')
    if url.scheme not in ('http', 'https') or url.hostname not in ('127.0.0.1', 'localhost', '::1') \
            or url.username is not None or url.password is not None \
            or port == 0 or url.path not in ('', '/'):
        raise Fail('url_unsafe')
    # The base is rebuilt from validated parts; nothing the parser kept,
    # rewrote or defaulted can reach the request.
    host = '[' + url.hostname + ']' if ':' in url.hostname else url.hostname
    base = url.scheme + '://' + host + ':' + str(port or (443 if url.scheme == 'https' else 80))
    if version(service.get('version')) is None:
        raise Fail('unsupported')
    registration = service.get('id')
    if not isinstance(registration, str) or not registration or len(registration) > 256:
        raise Fail('state_invalid')
    password = service.get('password')
    if not isinstance(password, str) or not password:
        raise Fail('credentials')
    auth = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
    return base, auth, registration, password

def connect(base, auth, registration, password):
    # Authenticate and check /api/info on every one-shot invocation; the
    # opaque generation binds registration, endpoint, credentials and the
    # running service instance.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(base + '/api/info',
                headers={'Authorization': auth, 'Accept': 'application/json'}), timeout=8) as reply:
            body = reply.read(65537)
    except urllib.error.HTTPError as e:
        raise Fail('auth' if e.code in (401, 403) else 'unreachable')
    except Fail:
        raise
    except Exception:
        raise Fail('unreachable')
    if len(body) > 65536:
        raise Fail('reply_invalid')
    try:
        info = json.loads(body)
    except ValueError:
        raise Fail('reply_invalid')
    if not isinstance(info, dict):
        raise Fail('reply_invalid')
    name = version(info.get('version'))
    if name is None:
        if info.get('version') is None or not isinstance(info.get('version'), str):
            raise Fail('reply_invalid')
        raise Fail('unsupported')
    pid = info.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid <= 4194304:
        raise Fail('reply_invalid')
    server = hashlib.sha256(json.dumps([registration, base, password, pid], sort_keys=True).encode()).hexdigest()[:32]
    return opener, server, name

# Canonical bytes come out of canon() in small pieces: the 24 MiB ceiling
# applies while encoding, never to a finished whole-string allocation.
# Scalars encode in bounded slices too: one JSONEncoder token can be an
# entire escaped string, so its allocation is chunked here the same way the
# aggregate is.
ESCAPE = json.encoder.encode_basestring_ascii
def canon(value):
    if value is None:
        yield 'null'
    elif value is True:
        yield 'true'
    elif value is False:
        yield 'false'
    elif isinstance(value, str):
        yield '"'
        for i in range(0, len(value), 65536):
            yield ESCAPE(value[i:i + 65536])[1:-1]
        yield '"'
    elif isinstance(value, (int, float)):
        # Overflowed exponents (1e999) parse to non-finite floats; those
        # have no standard JSON canonical form either.
        if isinstance(value, float) and not math.isfinite(value):
            raise Fail('reply_invalid')
        yield json.dumps(value)
    elif isinstance(value, list):
        yield '['
        for i, item in enumerate(value):
            if i:
                yield ','
            yield from canon(item)
        yield ']'
    elif isinstance(value, dict):
        yield '{'
        for i, key in enumerate(sorted(value)):
            if i:
                yield ','
            yield from canon(key)
            yield ':'
            yield from canon(value[key])
        yield '}'
    else:
        raise Fail('reply_invalid')
`

export const OPENCODE_DISCOVER = PY_COMMON + String.raw`
try:
    base, auth, registration, password = discover()
    opener, server, name = connect(base, auth, registration, password)
    emit({'ok': True, 'server': server, 'version': name})
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
`

export const OPENCODE_META = PY_COMMON + String.raw`
try:
    # The request is fixed before any machine work: exact fields and types
    # only, inside its own UTF-8 byte cap, before it is ever parsed.
    raw_request = sys.argv[2] if len(sys.argv) > 2 else ''
    if len(raw_request.encode('utf-8', 'surrogateescape')) > REQUEST_LIMIT:
        raise Fail('invalid_request')
    try:
        request = json.loads(raw_request)
    except ValueError:
        raise Fail('invalid_request')
    if not isinstance(request, dict) or set(request) - {'op', 'session', 'cursor', 'expect'}:
        raise Fail('invalid_request')
    op = request.get('op')
    session = request.get('session')
    cursor = request.get('cursor')
    expect = request.get('expect')
    if op not in ('session', 'page') \
            or not isinstance(session, str) or not re.fullmatch(r'[0-9A-Za-z_-]{1,128}', session) \
            or op != 'page' and cursor is not None \
            or cursor is not None and (not isinstance(cursor, str) or not re.fullmatch(r'[\x21-\x7e]{1,256}', cursor)) \
            or expect is not None and (not isinstance(expect, str) or not re.fullmatch(r'[a-f0-9]{64}', expect)):
        raise Fail('invalid_request')
    # Fixed paths only: a validated session id, and for a page the fixed
    # descending page size with either its initial order or the opaque
    # native cursor as an encoded query value. Never a numeric coercion.
    path = '/api/session/' + urllib.parse.quote(session, safe='')
    if op == 'page':
        query = {'limit': '120'}
        if cursor is None:
            query['order'] = 'desc'
        else:
            query['cursor'] = cursor
        path += '/message?' + urllib.parse.urlencode(query)
    base, auth, registration, password = discover()
    opener, server, name = connect(base, auth, registration, password)
    try:
        with opener.open(urllib.request.Request(base + path,
                headers={'Authorization': auth, 'Accept': 'application/json'}), timeout=8) as reply:
            body = reply.read(READ_LIMIT + 1)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Fail('auth')
        emit({'status': e.code, 'server': server})
        sys.exit(0)
    except Fail:
        raise
    except Exception:
        raise Fail('unreachable')
    if len(body) > READ_LIMIT:
        raise Fail('too_large')
    def reject(value):
        raise ValueError(value)
    try:
        # The body must be standard JSON: NaN and Infinity literals are not.
        data = json.loads(body, parse_constant=reject)
    except ValueError:
        raise Fail('reply_invalid')
    digest = hashlib.sha256()
    size = 0
    for piece in canon(data):
        chunk = piece.encode('utf-8')
        size += len(chunk)
        if size > READ_LIMIT:
            raise Fail('too_large')
        digest.update(chunk)
    # The fingerprint binds this server generation, the fixed request fields
    # and the canonical content; it is all the metadata a poll needs.
    fingerprint = hashlib.sha256(json.dumps([server, session, op, cursor or '',
        digest.hexdigest()], sort_keys=True).encode()).hexdigest()
    emit({'status': 200, 'server': server, 'fingerprint': fingerprint, 'size': size,
        'unchanged': expect == fingerprint})
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
`

export type OpencodeDiscovery =
  | { ok: true, server: string, version: string }
  | { ok: false, error: string }

// Every failure a helper may report, and only those. Anything else on its
// stdout is not a reply: it is treated as no reply at all. Home, timeout,
// reply-envelope and transport-failure validation are the shared boundary
// every fixed helper runs through.
export const HELPER_ERRORS = new Set(['not_running', 'state_invalid', 'url_unsafe', 'unsupported',
  'credentials', 'unreachable', 'auth', 'reply_invalid', 'helper_error'])
export const REPLY_LIMIT = 8192
// The largest reply any fixed helper may emit: the chunk envelope carries at
// most one 4 MiB piece as base64 plus its fixed fields.
export const CHUNK_REPLY_LIMIT = 4 * Math.ceil(4 * 1024 * 1024 / 3) + 256
const VERSION_OK = /^2\.\d+(\.\d+)?$/
export const SERVER_OK = /^[a-f0-9]{32}$/
export const SESSION_OK = /^[0-9A-Za-z_-]{1,128}$/
export const CURSOR_OK = /^[\x21-\x7e]{1,256}$/
export const FINGERPRINT_OK = /^[a-f0-9]{64}$/
// Snapshots stay under the helper's fixed 24 MiB raw/canonical ceiling.
export const READ_LIMIT = 24 * 1024 * 1024

// The fixed read target shared by the metadata and chunk requests: a session
// or page op, an ASCII session id and an optional native page cursor only;
// a cursor on a session op, or a null/malformed one, is invalid. Callers keep
// their own allowed fields and extra descriptor checks on top.
export const validReadTarget = (request: Record<string, unknown>) =>
  (request.op === 'session' || request.op === 'page')
  && typeof request.session === 'string' && SESSION_OK.test(request.session)
  && (request.cursor === undefined || (request.op === 'page' && typeof request.cursor === 'string' && CURSOR_OK.test(request.cursor)))

export const validHome = (home: string) => home.startsWith('/') && !home.includes('\0') && Buffer.byteLength(home, 'utf8') <= 1024
export const helperTimeout = (v?: number) => v === undefined ? 15000 : Number.isFinite(v) ? Math.min(Math.max(v, 1), 30000) : 15000

// The bound is on the bytes received, before any decode or parse; a reply
// must be one complete JSON envelope carrying exactly its allowed fields.
// A caller may bound a differently shaped reply (the chunk envelope) with an
// explicit positive integer no wider than the fixed chunk ceiling: anything
// else (a fraction, zero, an unbounded value) is refused outright.
export function replyObject(r: ExecResult, limit: number = REPLY_LIMIT): Record<string, unknown> | null {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > CHUNK_REPLY_LIMIT || r.stdout.length > limit) return null
  let out: unknown
  try { out = JSON.parse(r.stdout.toString('utf8').trim()) } catch { return null }
  return out && typeof out === 'object' && !Array.isArray(out) ? out as Record<string, unknown> : null
}
export const failure = (r: ExecResult): 'unreachable' | 'unavailable' => r.code === 255 || r.code === 124 ? 'unreachable' : 'unavailable'

// Discover and authenticate the machine's running OpenCode 2.x service.
// Missing Python, a missing service and any helper failure read as
// unavailable/unreachable; never a fallback to unsafe behavior.
export async function opencodeDiscover(exec: ShellExec, home: string, opts: { timeoutMs?: number } = {}): Promise<OpencodeDiscovery> {
  // No exec at all for a home that cannot name an account's directory.
  if (!validHome(home)) {
    return { ok: false, error: 'unavailable' }
  }
  let r
  try {
    r = await exec('exec python3 -X utf8 -c "$1" "$2"', [OPENCODE_DISCOVER, home], { timeoutMs: helperTimeout(opts.timeoutMs), maxBytes: REPLY_LIMIT })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  const reply = replyObject(r)
  if (reply) {
    const keys = Object.keys(reply).sort()
    if (r.code === 0 && reply.ok === true && keys.join() === 'ok,server,version'
      && typeof reply.server === 'string' && SERVER_OK.test(reply.server)
      && typeof reply.version === 'string' && reply.version.length <= 40 && VERSION_OK.test(reply.version)) {
      return { ok: true, server: reply.server, version: reply.version }
    }
    if (keys.join() === 'error' && typeof reply.error === 'string' && HELPER_ERRORS.has(reply.error)) {
      return { ok: false, error: reply.error }
    }
  }
  return { ok: false, error: failure(r) }
}
