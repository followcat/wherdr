// One bounded catalog observation of a fixed directory through the same
// discovery/auth/connect/canon seam as the other fixed helpers, with the
// committed reduced-row rules composed unchanged. The request is a single
// exact directory; the walk is fixed page size, descending order and
// opaque cursor.next only -- never an arbitrary URL, method, query or
// decoded cursor. Pages, rows, raw bytes (per page and summed), canonical
// bytes and wall time are all capped; a repeated cursor, duplicated row,
// generation flip or malformed value fails the whole walk with no partial
// result. Exhaustion under a stable generation is a bounded observation,
// NOT a consistency proof -- a row that moves ahead of the cursor is
// silently missed, so nothing here is a complete set. A TypeScript wrapper
// with its own reply/row checks is a later unit.
import { PY_COMMON } from './opencodeTransport'
import { CATALOG_ROW_RULES } from './opencodeCatalogRows'

export const OPENCODE_CATALOG = PY_COMMON + CATALOG_ROW_RULES + String.raw`
PAGE_SIZE = '100'
CATALOG_PAGES = 8
CATALOG_ROWS = 512
CATALOG_LIMIT = 4 * 1024 * 1024
RAW_AGGREGATE = 24 * 1024 * 1024

# One aggregate monotonic bound, armed before any machine work: discovery,
# connect, every blocking read, reply validation, revalidation, hashing and
# emission all share it. A one-shot SIGALRM makes it a real wall clock that
# interrupts a blocking read; post-call gates keep a late reply from ever
# publishing. The finally disarm outlives nothing.
t0 = time.monotonic()
deadline = t0 + 20

def left():
    return deadline - time.monotonic()

def clocked():
    if left() <= 0:
        raise Fail('unreachable')

def _hit(_sig, _frame):
    raise Fail('unreachable')
signal.signal(signal.SIGALRM, _hit)
signal.setitimer(signal.ITIMER_REAL, 20)

try:
    # The request is fixed before any machine work: one exact directory.
    raw_request = sys.argv[2] if len(sys.argv) > 2 else ''
    if len(raw_request.encode('utf-8', 'surrogateescape')) > REQUEST_LIMIT:
        raise Fail('invalid_request')
    try:
        request = json.loads(raw_request)
    except ValueError:
        raise Fail('invalid_request')
    if not isinstance(request, dict) or set(request) - {'directory'}:
        raise Fail('invalid_request')
    directory = request.get('directory')
    if not path_ok(directory):
        raise Fail('invalid_request')
    base, auth, registration, password = discover()
    clocked()
    opener, server, name = connect(base, auth, registration, password)
    clocked()
    cursor = None
    seen = set()
    ids = set()
    rows = []
    ctx = []
    pages = 0
    raw_total = 0
    while True:
        pages += 1
        if pages > CATALOG_PAGES:
            raise Fail('too_large')
        clocked()
        query = {'directory': directory, 'order': 'desc', 'limit': PAGE_SIZE}
        if cursor is not None:
            if cursor in seen:
                raise Fail('reply_invalid')
            seen.add(cursor)
            query['cursor'] = cursor
        try:
            with opener.open(urllib.request.Request(base + '/api/session?' + urllib.parse.urlencode(query),
                    headers={'Authorization': auth, 'Accept': 'application/json'}),
                    timeout=max(0.1, min(8, left()))) as reply:
                # The read is bounded by the remaining aggregate budget.
                body = reply.read(min(READ_LIMIT, RAW_AGGREGATE - raw_total) + 1)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise Fail('auth')
            emit({'status': e.code, 'server': server})
            sys.exit(0)
        except Fail:
            raise
        except Exception:
            raise Fail('unreachable')
        # A continuously fed body can cross the deadline inside one read;
        # the gate after it still refuses publication, never partial rows.
        clocked()
        raw_total += len(body)
        if len(body) > READ_LIMIT or raw_total > RAW_AGGREGATE:
            raise Fail('too_large')
        def reject(value):
            raise ValueError(value)
        try:
            data = json.loads(body, parse_constant=reject)
        except ValueError:
            raise Fail('reply_invalid')
        if not isinstance(data, dict) or not isinstance(data.get('data'), list) \
                or not isinstance(data.get('cursor'), dict):
            raise Fail('reply_invalid')
        items = data['data']
        cur = data['cursor']
        # Absence of the next key is the only proven exhaustion shape; an
        # explicit null or any other non-opaque value is a malformed reply.
        if 'next' not in cur:
            nxt = None
        else:
            nxt = cur['next']
            if not isinstance(nxt, str) or not re.fullmatch(r'[\x21-\x7e]{1,256}', nxt):
                raise Fail('reply_invalid')
        ctx.append({'use': cursor if cursor is not None else '',
            'n': len(items), 'next': nxt if nxt is not None else ''})
        for item in items:
            row = catalog_row(item)
            if row['id'] in ids:
                raise Fail('reply_invalid')
            ids.add(row['id'])
            rows.append(row)
            if len(rows) > CATALOG_ROWS:
                raise Fail('too_large')
        # Absence of next ends the walk; producer semantics give an empty
        # page no cursor, so an empty page WITH a continuation is refused
        # rather than silently labeled exhausted.
        if nxt is None:
            break
        if not items:
            raise Fail('reply_invalid')
        cursor = nxt
    # Revalidate after collecting: a registration, auth or generation change
    # during the walk discards the whole observation.
    clocked()
    base, auth, registration, password = discover()
    clocked()
    opener, live, name = connect(base, auth, registration, password)
    clocked()
    if live != server:
        raise Fail('snapshot_changed')
    digest = hashlib.sha256()
    size = 0
    for piece in canon(rows):
        chunk = piece.encode('utf-8')
        size += len(chunk)
        if size > CATALOG_LIMIT:
            raise Fail('too_large')
        digest.update(chunk)
    # The fingerprint binds this generation, the exact directory, the full
    # opaque traversal path and the canonical observed rows; it is churn
    # evidence, never a snapshot or completeness proof.
    fingerprint = hashlib.sha256(json.dumps([server, 'catalog', directory,
        ctx, digest.hexdigest()], sort_keys=True).encode()).hexdigest()
    clocked()
    emit({'status': 200, 'server': server, 'fingerprint': fingerprint,
        'directory': directory, 'pages': pages, 'size': size, 'rows': rows,
        'exhausted': True, 'consistency': 'unproven'})
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
`
