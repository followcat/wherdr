// One bounded canonical piece of a fixed session/page snapshot, read on the
// agent's machine through the same discovery/auth/connect/canon seam as the
// other fixed helpers; nothing is duplicated per op. The piece is bound to
// the caller's complete expected snapshot descriptor: server generation,
// fingerprint, total canonical size and offset are all validated before any
// machine work, the whole body is re-read and re-canonicalized, the full
// fingerprint is re-proven, and the live service is revalidated after
// collecting so a change while reading cannot authorize a stale piece.
// The only new reply shape is a base64 piece inside the fixed envelope.
// A TypeScript wrapper with its own reply-bound/base64/retry checks is a
// later unit; this file exposes the helper program only.
import { PY_COMMON } from './opencodeTransport'

export const OPENCODE_CHUNK = PY_COMMON + String.raw`
PIECE_LIMIT = 4 * 1024 * 1024

try:
    # The descriptor is fixed before any machine work: exact fields and
    # types only, inside its own UTF-8 byte cap, before it is ever parsed.
    raw_request = sys.argv[2] if len(sys.argv) > 2 else ''
    if len(raw_request.encode('utf-8', 'surrogateescape')) > REQUEST_LIMIT:
        raise Fail('invalid_request')
    try:
        request = json.loads(raw_request)
    except ValueError:
        raise Fail('invalid_request')
    if not isinstance(request, dict) or set(request) - {'op', 'session', 'cursor', 'server', 'fingerprint', 'size', 'offset'}:
        raise Fail('invalid_request')
    op = request.get('op')
    session = request.get('session')
    cursor = request.get('cursor')
    expected_server = request.get('server')
    expected_fp = request.get('fingerprint')
    total = request.get('size')
    offset = request.get('offset')
    if op not in ('session', 'page') \
            or not isinstance(session, str) or not re.fullmatch(r'[0-9A-Za-z_-]{1,128}', session) \
            or 'cursor' in request and (op != 'page' or not isinstance(cursor, str) or not re.fullmatch(r'[\x21-\x7e]{1,256}', cursor)) \
            or not isinstance(expected_server, str) or not re.fullmatch(r'[a-f0-9]{32}', expected_server) \
            or not isinstance(expected_fp, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_fp) \
            or not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= READ_LIMIT \
            or not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= total:
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
    # A generation other than the requested one cannot serve its snapshot.
    if server != expected_server:
        raise Fail('snapshot_changed')
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
    # One canonical pass: every byte is hashed while only the requested
    # <=4 MiB window is collected.
    digest = hashlib.sha256()
    size = 0
    piece = bytearray()
    for part in canon(data):
        chunk = part.encode('utf-8')
        end = size + len(chunk)
        if end > READ_LIMIT:
            raise Fail('too_large')
        if end > offset and size < offset + PIECE_LIMIT:
            piece += chunk[max(0, offset - size):offset + PIECE_LIMIT - size]
        size = end
        digest.update(chunk)
    fingerprint = hashlib.sha256(json.dumps([server, session, op, cursor or '',
        digest.hexdigest()], sort_keys=True).encode()).hexdigest()
    # The expected snapshot must be fully proven before any piece is emitted.
    if fingerprint != expected_fp or size != total:
        raise Fail('snapshot_changed')
    # Revalidate the live service after collecting: a registration, auth or
    # generation change during the read cannot authorize a stale piece.
    base, auth, registration, password = discover()
    opener, live, name = connect(base, auth, registration, password)
    if live != server:
        raise Fail('snapshot_changed')
    emit({'status': 200, 'server': server, 'fingerprint': fingerprint, 'size': size,
        'offset': offset, 'piece': base64.b64encode(bytes(piece)).decode('ascii')})
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
`
