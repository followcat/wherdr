// OpenCode discovery/auth runs on the agent's own machine: a local child
// process here, machine.exec over the multiplexed connection on a remote core
// host. Adapted from wherdr v2's OpenCode transport, reduced to the read-only
// discovery/auth/info subset. Credentials and the loopback address never
// leave that machine: the only replies are a fixed error key or
// {ok, server generation, version}. The helper discovers an already-running
// 2.x service, authenticates to it and checks /api/info. It never starts,
// installs, restarts or writes anything, and it is the only code that ever
// sees the service password.
// Keep the -c payload ASCII for service/SSH launchers that decode argv before
// applying Python's UTF-8 setting.
import type { ShellExec } from './fsx'

export const OPENCODE_DISCOVER = String.raw`
import base64, hashlib, json, os, pathlib, re, select, shutil, signal, subprocess, sys, time
import urllib.request, urllib.error, urllib.parse

home = sys.argv[1]

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

try:
    base, auth, registration, password = discover()
    # No proxies, no redirects: Basic credentials may only ever reach the
    # validated loopback address above, directly.
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
    # Opaque generation: a registration, endpoint, credential or service
    # restart change gives a new value. It exists only when every input is
    # present and validated.
    server = hashlib.sha256(json.dumps([registration, base, password, pid], sort_keys=True).encode()).hexdigest()[:32]
    emit({'ok': True, 'server': server, 'version': name})
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

// Every failure the helper may report, and only those. Anything else on its
// stdout is not a reply: it is treated as no reply at all.
const HELPER_ERRORS = new Set(['not_running', 'state_invalid', 'url_unsafe', 'unsupported',
  'credentials', 'unreachable', 'auth', 'reply_invalid', 'helper_error'])
const REPLY_LIMIT = 8192
const VERSION_OK = /^2\.\d+(\.\d+)?$/

// Discover and authenticate the machine's running OpenCode 2.x service.
// Missing Python, a missing service and any helper failure read as
// unavailable/unreachable; never a fallback to unsafe behavior.
export async function opencodeDiscover(exec: ShellExec, home: string, opts: { timeoutMs?: number } = {}): Promise<OpencodeDiscovery> {
  // No exec at all for a home that cannot name an account's directory.
  if (!home.startsWith('/') || home.includes('\0') || Buffer.byteLength(home, 'utf8') > 1024) {
    return { ok: false, error: 'unavailable' }
  }
  const timeoutMs = opts.timeoutMs === undefined ? 15000
    : Number.isFinite(opts.timeoutMs) ? Math.min(Math.max(opts.timeoutMs, 1), 30000) : 15000
  let r
  try {
    r = await exec('exec python3 -X utf8 -c "$1" "$2"', [OPENCODE_DISCOVER, home], { timeoutMs, maxBytes: REPLY_LIMIT })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  // The bound is on the bytes received, before any decode or parse; a reply
  // must be one complete JSON envelope carrying exactly its allowed fields.
  if (r.stdout.length > REPLY_LIMIT) {
    return r.code === 255 || r.code === 124 ? { ok: false, error: 'unreachable' } : { ok: false, error: 'unavailable' }
  }
  let out: unknown
  try { out = JSON.parse(r.stdout.toString('utf8').trim()) } catch { out = null }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const reply = out as Record<string, unknown>
    const keys = Object.keys(reply).sort()
    if (r.code === 0 && reply.ok === true && keys.join() === 'ok,server,version'
      && typeof reply.server === 'string' && /^[a-f0-9]{32}$/.test(reply.server)
      && typeof reply.version === 'string' && reply.version.length <= 40 && VERSION_OK.test(reply.version)) {
      return { ok: true, server: reply.server, version: reply.version }
    }
    if (keys.join() === 'error' && typeof reply.error === 'string' && HELPER_ERRORS.has(reply.error)) {
      return { ok: false, error: reply.error }
    }
  }
  if (r.code === 255 || r.code === 124) return { ok: false, error: 'unreachable' }
  return { ok: false, error: 'unavailable' }
}
