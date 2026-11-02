// Runs on the agent's machine, locally or over SSH. Credentials and loopback
// addresses stay there. Reads are GETs against an already running v2 service
// (the CLI's `api` command would auto-start one); writes are the fixed,
// whitelisted operations below — model PATCH, permission/form replies, an
// inbox delete verified against a fresh listing, and a shell run.
export const OPENCODE_READ = String.raw`
import base64, hashlib, json, os, pathlib, re, shutil, subprocess, sys, urllib.request, urllib.error, urllib.parse

home = sys.argv[1]
request = json.loads(sys.argv[2])
limit = 24 * 1024 * 1024

def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def discover():
    own = os.path.realpath(os.environ.get('HOME', '')) == os.path.realpath(home)
    state = pathlib.Path(os.environ.get('XDG_STATE_HOME', '') if own else '')
    # A relative XDG_STATE_HOME would resolve against our cwd, not the
    # user's — only an absolute one is honored.
    if not str(state) or str(state) == '.' or not state.is_absolute():
        state = pathlib.Path(home) / '.local' / 'state'
    file = state / 'opencode' / 'service.json'
    if not file.is_file():
        candidates = [str(pathlib.Path(home) / p) for p in ['.opencode/bin/opencode', '.local/bin/opencode']]
        candidates += [shutil.which('opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']
        binary = next((p for p in candidates if p and os.access(p, os.X_OK)), None)
        if binary:
            env = dict(os.environ, HOME=home)
            if not own:
                for k in ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']:
                    env.pop(k, None)
            result = subprocess.run([binary, 'debug', 'paths', 'state'], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=4)
            if result.returncode == 0:
                file = pathlib.Path(result.stdout.decode('utf-8').strip()) / 'service.json'
    if not file.is_file():
        raise ValueError('OpenCode 2.x background service is not running')
    if file.stat().st_size > 65536:
        raise ValueError('Invalid OpenCode service state')
    service = json.loads(file.read_text())
    url = urllib.parse.urlsplit(service.get('url', ''))
    if url.scheme not in ['http', 'https'] or url.hostname not in ['127.0.0.1', 'localhost', '::1'] or url.username or url.password or url.query or url.fragment or url.path not in ['', '/']:
        raise ValueError('OpenCode service must use a loopback address')
    if not str(service.get('version', '')).lstrip('v').startswith('2.'):
        raise ValueError('OpenCode 2.x is required for conversation reading')
    password = service.get('password')
    if not isinstance(password, str) or not password:
        raise ValueError('OpenCode service credentials are unavailable')
    auth = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
    return service, service['url'].rstrip('/'), auth

try:
    service, base, auth = discover()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    timeout = max(.1, min(10, request.get('seconds', 10)))
    def get(path):
        return opener.open(urllib.request.Request(base + path, headers={'Authorization': auth, 'Accept': 'text/event-stream' if path == '/api/event' else 'application/json'}), timeout=timeout)
    with get('/api/info') as response:
        info = json.loads(response.read(65537))
    if not str(info.get('version', '')).lstrip('v').startswith('2.'):
        raise ValueError('OpenCode 2.x is required for conversation reading')
    server = hashlib.sha256(json.dumps([home, service.get('id'), base, info.get('pid')], sort_keys=True).encode()).hexdigest()[:24]
    if request.get('stream'):
        timeout = 300
        with get('/api/event') as response:
            emit({'server': server, 'ready': True})
            while True:
                line = response.readline(65537)
                if not line or len(line) > 65536:
                    break
                if line.startswith(b'data:'):
                    # v2 encodes an event as a JSON string within SSE data.
                    raw = line[5:].strip()
                    try:
                        event = json.loads(raw)
                        if isinstance(event, str): event = json.loads(event)
                        def resets(value):
                            if not isinstance(value, dict): return False
                            kind = value.get('type', '')
                            return kind in ['session.revert.staged', 'session.revert.cleared', 'session.revert.committed', 'session.compaction.ended'] or any(resets(value.get(k)) for k in ['event', 'payload', 'properties'])
                        emit({'changed': True, 'reset': resets(event)})
                    except (ValueError, TypeError):
                        emit({'changed': True})
    else:
        session = urllib.parse.quote(str(request.get('session', '')), safe='')
        root = '/api/session/' + session
        path = root
        op = request.get('op')
        if op == 'page':
            query = {'limit': '120'}
            if request.get('cursor'): query['cursor'] = request['cursor']
            else: query['order'] = 'desc'
            path += '/message?' + urllib.parse.urlencode(query)
        elif op in ['message', 'image']:
            path += '/message/' + urllib.parse.quote(request['message'], safe='')
        elif op == 'models':
            path = '/api/model'
        elif op == 'inbox':
            path += '/inbox'
        elif op == 'pending':
            # Pending permission requests and unanswered forms, in one run.
            out = {}
            for name, sub in [('permissions', '/permission'), ('forms', '/form')]:
                try:
                    with get(root + sub) as response:
                        data = json.loads(response.read(limit + 1))
                    out[name] = data.get('data') if isinstance(data.get('data'), list) else []
                except urllib.error.HTTPError as e:
                    emit({'server': server, 'status': e.code})
                    sys.exit(0)
            emit({'server': server, 'status': 200, 'data': out})
            sys.exit(0)
        elif op == 'reply':
            # Answer a pending permission request. The decision enum and the
            # request id shape are fixed; then re-list so the caller sees the
            # request really leave the pending set.
            rid = str(request.get('request', ''))
            decision = request.get('decision')
            message = request.get('message')
            if not re.fullmatch(r'[\w-]{1,128}', rid) or decision not in ['once', 'always', 'reject'] \
                    or (message is not None and (not isinstance(message, str) or len(message) > 4000)):
                raise ValueError('Invalid OpenCode reply')
            body = {'decision': decision}
            if message: body['message'] = message
            req = urllib.request.Request(base + root + '/permission/' + urllib.parse.quote(rid, safe='') + '/reply',
                data=json.dumps(body, ensure_ascii=True).encode(), method='POST',
                headers={'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json'})
            try:
                with opener.open(req, timeout=timeout) as response:
                    response.read(limit)
            except urllib.error.HTTPError as e:
                emit({'server': server, 'status': e.code})
                sys.exit(0)
            with get(root + '/permission') as response:
                data = json.loads(response.read(limit + 1))
            emit({'server': server, 'status': 200, 'data': {'pending': data.get('data') if isinstance(data.get('data'), list) else []}})
            sys.exit(0)
        elif op == 'form_reply':
            # Answer one field of a pending form: {answer: {<key>: <value>}}.
            fid = str(request.get('form', ''))
            key = str(request.get('key', ''))
            value = request.get('value')
            scalar = isinstance(value, str) and len(value) <= 8000 or isinstance(value, bool) \
                or isinstance(value, (int, float)) and not isinstance(value, bool)
            items = isinstance(value, list) and len(value) <= 32 and all(isinstance(v, str) and len(v) <= 2000 for v in value)
            if not re.fullmatch(r'[\w-]{1,128}', fid) or not re.fullmatch(r'[\w.-]{1,128}', key) or not (scalar or items):
                raise ValueError('Invalid OpenCode reply')
            req = urllib.request.Request(base + root + '/form/' + urllib.parse.quote(fid, safe='') + '/reply',
                data=json.dumps({'answer': {key: value}}, ensure_ascii=True).encode(), method='POST',
                headers={'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json'})
            try:
                with opener.open(req, timeout=timeout) as response:
                    response.read(limit)
            except urllib.error.HTTPError as e:
                emit({'server': server, 'status': e.code})
                sys.exit(0)
            with get(root + '/form') as response:
                data = json.loads(response.read(limit + 1))
            emit({'server': server, 'status': 200, 'data': {'pending': data.get('data') if isinstance(data.get('data'), list) else []}})
            sys.exit(0)
        elif op == 'inbox_delete':
            # Cancel a queued message: DELETE /inbox/<id>, but only an id a
            # fresh listing still shows — never a blind delete.
            iid = str(request.get('item', ''))
            if not re.fullmatch(r'[\w-]{1,128}', iid):
                raise ValueError('Invalid OpenCode reply')
            with get(root + '/inbox') as response:
                data = json.loads(response.read(limit + 1))
            items = data.get('data') if isinstance(data.get('data'), list) else []
            if not any(isinstance(i, dict) and i.get('id') == iid for i in items):
                emit({'server': server, 'status': 404})
                sys.exit(0)
            req = urllib.request.Request(base + root + '/inbox/' + urllib.parse.quote(iid, safe=''), method='DELETE',
                headers={'Authorization': auth, 'Accept': 'application/json'})
            try:
                with opener.open(req, timeout=timeout) as response:
                    response.read(limit)
            except urllib.error.HTTPError as e:
                emit({'server': server, 'status': e.code})
                sys.exit(0)
            with get(root + '/inbox') as response:
                data = json.loads(response.read(limit + 1))
            emit({'server': server, 'status': 200, 'data': {'items': data.get('data') if isinstance(data.get('data'), list) else []}})
            sys.exit(0)
        elif op == 'shell':
            # Run a shell command in the session (the "!" of its composer).
            cmd = request.get('command')
            if not isinstance(cmd, str) or not cmd.strip() or len(cmd) > 8000:
                raise ValueError('Invalid OpenCode shell command')
            req = urllib.request.Request(base + root + '/shell',
                data=json.dumps({'command': cmd}, ensure_ascii=True).encode(), method='POST',
                headers={'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json'})
            try:
                # The service answers when the command ends; that can be
                # minutes, not the read budget's ten seconds. Still bounded:
                # a longer run keeps going server-side while we report it
                # unconfirmed (the transcript shows it land later).
                with opener.open(req, timeout=max(1, min(290, request.get('seconds', 290)))) as response:
                    response.read(limit)
                emit({'server': server, 'status': 200, 'data': None})
            except urllib.error.HTTPError as e:
                emit({'server': server, 'status': e.code})
            sys.exit(0)
        elif op == 'model':
            # PATCH the session's model with an id/providerID/variant body,
            # then re-GET the session so the caller verifies the result.
            # Any other field is refused.
            model = request.get('model')
            keys = set(model) if isinstance(model, dict) else None
            valid = keys is not None and keys <= {'id', 'providerID', 'variant'} \
                and all(isinstance(v, str) for v in model.values()) \
                and bool(model.get('id')) and bool(model.get('providerID'))
            if not valid:
                raise ValueError('Invalid OpenCode model')
            body = json.dumps({'model': model}, ensure_ascii=True).encode()
            try:
                req = urllib.request.Request(base + path, data=body, method='PATCH', headers={'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json'})
                with opener.open(req, timeout=timeout) as response:
                    response.read(limit)
                with get(path) as response:
                    data = json.loads(response.read(limit + 1))
                emit({'server': server, 'status': 200, 'data': data})
            except urllib.error.HTTPError as e:
                emit({'server': server, 'status': e.code})
            sys.exit(0)
        elif op != 'session':
            raise ValueError('Invalid OpenCode read operation')
        try:
            with get(path) as response:
                body = response.read(limit + 1)
                if len(body) > limit: raise ValueError('OpenCode conversation exceeded its read limit')
                data = json.loads(body)
                # Every session read also carries the queued-message inbox:
                # one shim run, coalesced, never a second process for it.
                if op == 'session':
                    try:
                        with get(root + '/inbox') as box:
                            items = json.loads(box.read(limit + 1))
                        data['inbox'] = items.get('data') if isinstance(items.get('data'), list) else []
                    except urllib.error.HTTPError:
                        data['inbox'] = []
                if op == 'image':
                    message = data.get('data', {})
                    slot = request.get('slot')
                    mime_pattern = r'image/(png|jpeg|gif|webp|avif)'
                    if slot == 'u' and message.get('type') == 'user':
                        # User attachments arrive inline or as a file:/data: URI
                        # on the agent machine — resolved below like tool files.
                        files = [f for f in message.get('files', []) if re.fullmatch(mime_pattern, f.get('mime', '')) and (isinstance(f.get('data'), str) or isinstance(f.get('uri'), str))]
                    else:
                        part = next((p for p in message.get('content', []) if p.get('type') == 'tool' and 't' + p.get('id', '') == slot), {})
                        files = [f for f in part.get('state', {}).get('content', []) if f.get('type') == 'file' and re.fullmatch(mime_pattern, f.get('mime', '')) and isinstance(f.get('uri'), str)]
                    index = request.get('index', -1)
                    image = files[index] if isinstance(index, int) and 0 <= index < len(files) else None
                    if image and 'data' not in image:
                        source_uri = image.get('uri', '')
                        uri = urllib.parse.urlsplit(source_uri)
                        if uri.scheme == 'file' and uri.netloc in ['', 'localhost'] and not uri.query and not uri.fragment:
                            file = pathlib.Path(urllib.parse.unquote(uri.path))
                            if file.is_file() and file.stat().st_size <= 16 * 1024 * 1024:
                                with file.open('rb') as source:
                                    blob = source.read(16 * 1024 * 1024 + 1)
                                image = dict(image, data=base64.b64encode(blob).decode()) if len(blob) <= 16 * 1024 * 1024 else None
                            else: image = None
                        elif source_uri.startswith('data:' + image['mime'] + ';base64,'):
                            image = dict(image, data=source_uri.split(',', 1)[1])
                        else: image = None
                    data = {'image': {'mime': image['mime'], 'data': image['data']} if image else None}
                emit({'server': server, 'status': response.status, 'data': data})
        except urllib.error.HTTPError as e:
            emit({'server': server, 'status': e.code})
except ValueError as e:
    # Only our fixed messages may leave this helper; JSON/URL errors may contain secrets.
    allowed = ['OpenCode 2.x background service is not running', 'Invalid OpenCode service state', 'OpenCode service must use a loopback address', 'OpenCode 2.x is required for conversation reading', 'OpenCode service credentials are unavailable', 'OpenCode conversation exceeded its read limit', 'Invalid OpenCode read operation', 'Invalid OpenCode model', 'Invalid OpenCode reply', 'Invalid OpenCode shell command']
    emit({'error': str(e) if str(e) in allowed else 'Unable to read OpenCode conversation'})
    sys.exit(1)
except Exception:
    emit({'error': 'Unable to reach the OpenCode 2.x service'})
    sys.exit(1)
`
