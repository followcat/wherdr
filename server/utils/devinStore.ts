// Run on the machine owning the session. Python's SQLite reader understands
// WAL snapshots; copying sessions.db alone would lose committed messages.
export const DEVIN_QUERY = String.raw`
import base64, hashlib, json, os, pathlib, sqlite3, sys, time

MAX_ROW = 84 * 1024 * 1024
MAX_BYTES = 24 * 1024 * 1024
request = json.loads(sys.argv[2])
home = pathlib.Path(sys.argv[1])
native_home = str(home) == str(pathlib.Path.home())
root = os.environ.get('DEVIN_SESSIONS_DIR') if native_home else None
if not root:
    data = os.environ.get('XDG_DATA_HOME') if native_home else None
    root = str(pathlib.Path(data) / 'devin/cli') if data else str(home / '.local/share/devin/cli')
file = pathlib.Path(root) / 'sessions.db'
deadline = time.monotonic() + min(10, max(.1, request.get('seconds', 4)))

def digest(value):
    return hashlib.sha256(value.encode('utf-8', errors='surrogateescape')).hexdigest()[:24]

def trim(value):
    if isinstance(value, dict):
        return {k: ('' if k == 'data' and value.get('type') == 'image' and isinstance(v, str) else trim(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [trim(v) for v in value]
    if isinstance(value, str):
        return value[:20000] + ('\u2026' if len(value) > 20000 else '')
    return value

def main():
    if not file.is_file(): return {'available': False}
    con = sqlite3.connect(file.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)
    try:
        con.execute('PRAGMA query_only=ON')
        con.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        con.execute('BEGIN')
        for table, required in [('sessions', {'id','main_chain_id','model'}), ('message_nodes', {'session_id','node_id','parent_node_id','chat_message'})]:
            columns = {r[1] for r in con.execute('PRAGMA table_info(' + table + ')')}
            if not required.issubset(columns): raise ValueError('Unsupported Devin session database format')
        sid = request['session']
        session = con.execute('SELECT main_chain_id,model FROM sessions WHERE id=?', (sid,)).fetchone()
        if not session: return {'available': False}
        identity = digest(str(file.resolve()) + ':' + str(file.stat().st_ino) + ':' + sid)
        base = {'available': True, 'file': 'devin-' + identity, 'model': session[1]}
        if request['op'] == 'model': return base
        parents = dict(con.execute('SELECT node_id,parent_node_id FROM message_nodes WHERE session_id=? LIMIT 200001', (sid,)))
        if len(parents) > 200000: raise ValueError('Devin conversation exceeds the supported node limit')
        if any(not isinstance(n, int) or n < 0 or n >= 9007199254740991 for n in parents): raise ValueError('Unsupported Devin node identifier')
        ids, seen, node = [], set(), session[0]
        while node is not None:
            if node in seen or node not in parents: raise ValueError('Invalid Devin conversation chain')
            seen.add(node)
            ids.append(node)
            parent = parents[node]
            if parent is not None and parent >= node: raise ValueError('Unsupported Devin node ordering')
            node = parent
        ids.reverse()
        positions = {node + 1: i for i, node in enumerate(ids)}

        def prefix(index):
            return digest(identity + ':' + json.dumps([(n, parents[n]) for n in ids[:index + 1]]))

        def row(node, full=False):
            size, = con.execute('SELECT length(CAST(chat_message AS BLOB)) FROM message_nodes WHERE session_id=? AND node_id=?', (sid,node)).fetchone()
            if size > MAX_ROW: raise ValueError('Devin message exceeds the supported size limit')
            raw, = con.execute('SELECT chat_message FROM message_nodes WHERE session_id=? AND node_id=?', (sid,node)).fetchone()
            value = json.loads(raw)
            return {'id': node, 'message': value if full else trim(value), 'digest': digest(raw)}, size

        if request['op'] == 'image':
            node = request['node']
            if node not in seen: return {'available': False}
            r, _ = row(node, True)
            return {**base, 'rows': [r]}

        if request['op'] == 'search':
            rows, used, limited = [], 0, False
            for node in reversed(ids):
                if time.monotonic() > deadline or used >= 8 * 1024 * 1024:
                    limited = True
                    break
                r, size = row(node)
                used += size
                m = r['message']
                if m.get('role') in ('user','assistant'):
                    rows.append(r)
            return {**base, 'rows': rows, 'limited': limited}

        anchor = request.get('anchor')
        invalid = bool(anchor and (anchor['file'] != base['file'] or anchor['start'] not in positions and anchor['start'] != 0))
        if anchor and not invalid:
            at = positions.get(anchor['start'], 0)
            invalid = anchor['prefix'] != prefix(at)
        before = request.get('before')
        start = request.get('from')
        if before is not None and before not in positions and before != 0: invalid = True
        if start is not None and start not in positions and start != 0: invalid = True
        if invalid and before is not None:
            return {**base, 'rewritten': True, 'rows': [], 'start': 0, 'prefix': ''}
        end = positions.get(before, 0) if before is not None else len(ids)
        selected, used, visible = [], 0, 0
        lo = positions.get(start, 0) if start is not None and not invalid and before is None else None
        candidates = ids[lo:end] if lo is not None else reversed(ids[:end])
        for node in candidates:
            if time.monotonic() > deadline: raise TimeoutError('Devin conversation read timed out')
            r, _ = row(node)
            used += len(json.dumps(r).encode())
            if used > MAX_BYTES: raise ValueError('Devin conversation page exceeds the supported size limit')
            selected.append(r)
            m = r['message']
            role = m.get('role')
            visible += int(role == 'user' and m.get('metadata', {}).get('is_user_input') is True)
            if role == 'assistant': visible += int(bool(m.get('content'))) + int(bool(m.get('thinking'))) + len(m.get('tool_calls') or [])
            if lo is None and visible >= 120: break
        if lo is None:
            selected.reverse()
            lo = positions[selected[0]['id'] + 1] if selected else 0
        # Cached tool_call_state has no branch provenance in this CLI version.
        # Only a result node on the current chain can complete a tool card.
        calls = {call.get('id') for r in selected for call in (r['message'].get('tool_calls') or []) if isinstance(call.get('id'), str)}
        calls -= {r['message'].get('tool_call_id') for r in selected if r['message'].get('role') == 'tool'}
        context = []
        for node in ids[end:end + 256]:
            if not calls: break
            if time.monotonic() > deadline: raise TimeoutError('Devin conversation read timed out')
            r, _ = row(node)
            m = r['message']
            if m.get('role') == 'tool' and m.get('tool_call_id') in calls:
                used += len(json.dumps(r).encode())
                if used > MAX_BYTES: raise ValueError('Devin tool results exceed the supported page limit')
                calls.remove(m['tool_call_id'])
                context.append(r)
        return {**base, 'rows': selected, 'context': context, 'start': ids[lo] + 1 if lo else 0, 'prefix': prefix(lo), 'rewritten': invalid}
    finally:
        con.close()

try:
    print(json.dumps(main()))
except Exception as error:
    # No row contents, SQL or credentials in errors sent to the client.
    print(json.dumps({'error': str(error) if isinstance(error, (ValueError, TimeoutError)) else 'Unable to read Devin conversation (' + type(error).__name__ + ')'}))
    sys.exit(1)
`
