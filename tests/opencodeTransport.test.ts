import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_READ } from '../server/utils/opencodeTransport'

const run = promisify(execFile)
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-opencode-transport-')); homes.push(home)
  const dir = path.join(home, '.local/state/opencode'); mkdirSync(dir, { recursive: true })
  const state = { id: 'fixture', version: '2.0.27', url: 'http://127.0.0.1:12345', pid: 10, password: 'fixture-password' }
  const save = () => writeFileSync(path.join(dir, 'service.json'), JSON.stringify(state), { mode: 0o600 })
  save()
  return { home, dir, state, save }
}
// A virtual HTTP peer exercises the real Python discovery/authentication code
// without sockets. End-to-end tests use the same protocol over actual HTTP/SSE.
const VIRTUAL_HTTP = String.raw`
import io, json, sys, urllib.request, urllib.error, base64, urllib.parse
fixture = json.loads(sys.argv[3])
class Response(io.BytesIO):
    status = 200
class Peer:
    patched = None
    replied = None
    formed = None
    shelled = None
    def open(self, req, timeout=None):
        expected = 'Basic ' + base64.b64encode(('opencode:' + fixture.get('password', 'fixture-password')).encode()).decode()
        assert req.get_header('Authorization') == expected
        url = urllib.parse.urlsplit(req.full_url)
        if url.path == '/api/info':
            return Response(json.dumps({'version': fixture.get('version', '2.0.27'), 'pid': fixture.get('pid', 10)}).encode())
        if url.path == '/api/event':
            return Response(('event: message' + chr(10) + 'data: ' + json.dumps(json.dumps({'type': 'session.revert.committed'})) + chr(10) * 2).encode())
        if url.path == '/api/model':
            assert req.get_method() == 'GET'
            return Response(json.dumps(fixture.get('models', {'data': []})).encode())
        assert url.path.startswith('/api/session/ses_example')
        if '/permission/' in url.path and url.path.endswith('/reply'):
            body = json.loads((req.data or b'{}').decode())
            assert req.get_method() == 'POST' and body.get('decision') in ['once', 'always', 'reject'] and set(body) <= {'decision', 'message'}
            Peer.replied = (urllib.parse.unquote(url.path.rsplit('/', 2)[-2]), body)
            return Response(b'')
        if url.path.endswith('/permission'):
            assert req.get_method() == 'GET'
            data = [p for p in fixture.get('permissions', []) if not (Peer.replied and p.get('id') == Peer.replied[0])]
            return Response(json.dumps({'data': data}).encode())
        if '/form/' in url.path and url.path.endswith('/reply'):
            body = json.loads((req.data or b'{}').decode())
            assert req.get_method() == 'POST' and set(body) == {'answer'} and len(body['answer']) == 1
            Peer.formed = (urllib.parse.unquote(url.path.rsplit('/', 2)[-2]), body)
            return Response(b'')
        if url.path.endswith('/form'):
            assert req.get_method() == 'GET'
            data = [f for f in fixture.get('forms', []) if not (Peer.formed and f.get('id') == Peer.formed[0])]
            return Response(json.dumps({'data': data}).encode())
        if url.path.endswith('/shell'):
            body = json.loads((req.data or b'{}').decode())
            assert req.get_method() == 'POST' and set(body) == {'command'} and body['command']
            Peer.shelled = body['command']
            return Response(b'')
        if '/inbox/' in url.path:
            assert req.get_method() == 'DELETE'
            iid = urllib.parse.unquote(url.path.rsplit('/', 1)[-1])
            items = fixture.get('inbox', [])
            if not any(i.get('id') == iid for i in items): raise urllib.error.HTTPError(req.full_url, 404, 'fixture', {}, None)
            fixture['inbox'] = [i for i in items if i.get('id') != iid]
            return Response(b'')
        if url.path.endswith('/inbox'):
            assert req.get_method() == 'GET'
            return Response(json.dumps({'data': fixture.get('inbox', [])}).encode())
        if req.get_method() == 'PATCH':
            # Only {"model": {...}} may leave the helper; echo it on the verify GET.
            Peer.patched = json.loads((req.data or b'{}').decode())
            if set(Peer.patched) != {'model'}: raise urllib.error.HTTPError(req.full_url, 400, 'fixture', {}, None)
            return Response(b'')
        assert req.get_method() == 'GET'
        if fixture.get('status'):
            raise urllib.error.HTTPError(req.full_url, fixture['status'], 'fixture', {}, None)
        resp = fixture.get('response', {'data': {'id': 'ses_example'}})
        if Peer.patched and 'model' in Peer.patched:
            resp = {'data': dict(resp.get('data', {}), model=Peer.patched['model'])}
        return Response(json.dumps(resp).encode())
def build(*handlers):
    assert any(isinstance(h, urllib.request.ProxyHandler) and h.proxies == {} for h in handlers)
    assert any(type(h).__name__ == 'NoRedirect' and h.redirect_request(None) is None for h in handlers)
    return Peer()
urllib.request.build_opener = build
`
async function read(home: string, request: Record<string, unknown> = { session: 'ses_example', op: 'session' }, peer: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  try {
    const r = await run('python3', ['-X', 'utf8', '-c', VIRTUAL_HTTP + '\n' + OPENCODE_READ, home, JSON.stringify(request), JSON.stringify(peer)], { env: { ...process.env, HOME: home, XDG_STATE_HOME: '', XDG_DATA_HOME: path.join(home, 'data'), ...env }, timeout: 5000 })
    return r.stdout.trim().split('\n').map(line => JSON.parse(line))
  } catch (error) {
    const e = error as { stdout: string }
    return e.stdout.trim().split('\n').map(line => JSON.parse(line))
  }
}

it('reads a session when launched from a C-locale service or SSH shell', async () => {
  const { home } = fixture()
  const [r] = await read(home, undefined, {}, { LC_ALL: 'C', LANG: 'C', PYTHONCOERCECLOCALE: '0', PYTHONUTF8: '0' })
  expect(r).toMatchObject({ status: 200, data: { data: { id: 'ses_example' } } })
})

it('discovers and authenticates an existing 2.x service, keeping credentials out of its replies', async () => {
  const { home } = fixture()
  const [r] = await read(home)
  expect(r).toMatchObject({ status: 200, server: expect.stringMatching(/^[a-f0-9]{24}$/), data: { data: { id: 'ses_example' } } })
  expect(JSON.stringify(r)).not.toMatch(/fixture-password|127\.0\.0\.1/)
})

it('rejects old versions, external endpoints and missing credentials before reading history', async () => {
  const { home, state, save } = fixture()
  state.version = '1.2.3'; save()
  expect(await read(home)).toEqual([{ error: 'OpenCode 2.x is required for conversation reading' }])
  state.version = '2.0.27'; state.url = 'https://example.invalid'; save()
  expect(await read(home)).toEqual([{ error: 'OpenCode service must use a loopback address' }])
  state.url = 'http://user:secret@127.0.0.1:12345'; save()
  expect(await read(home)).toEqual([{ error: 'OpenCode service must use a loopback address' }])
  state.url = 'http://127.0.0.1:12345'; state.password = ''; save()
  expect(await read(home)).toEqual([{ error: 'OpenCode service credentials are unavailable' }])
})

it('checks the server version and reads newly rotated credentials on every request', async () => {
  const { home, state, save } = fixture()
  expect(await read(home, undefined, { version: '1.9.0' })).toEqual([{ error: 'OpenCode 2.x is required for conversation reading' }])
  const first = (await read(home))[0]
  state.password = 'rotated-fixture-password'; save()
  const next = (await read(home, undefined, { password: state.password }))[0]
  expect(next).toEqual(first)
  expect((await read(home, undefined, { password: state.password, pid: 11 }))[0].server).not.toBe(first.server)
})

it('decodes v2 SSE events without forwarding their payload or credentials', async () => {
  const { home } = fixture()
  expect(await read(home, { stream: true })).toEqual([
    { server: expect.any(String), ready: true }, { changed: true, reset: true },
  ])
})

it('keeps missing sessions, invalid cursors and transport failures distinct', async () => {
  const { home } = fixture()
  expect((await read(home, undefined, { status: 404 }))[0]).toMatchObject({ status: 404 })
  expect((await read(home, undefined, { status: 400 }))[0]).toMatchObject({ status: 400 })
  expect((await read(home, undefined, { status: 503 }))[0]).toMatchObject({ status: 503 })
  expect(await read(home, undefined, { password: 'wrong' })).toEqual([{ error: 'Unable to reach the OpenCode 2.x service' }])
})

it('reads only image bytes referenced by that message and refuses arbitrary remote image URLs', async () => {
  const { home } = fixture()
  const request = { session: 'ses_example', op: 'image', message: 'msg_example', slot: 'tcall-1', index: 0 }
  const message = { type: 'assistant', content: [{ type: 'tool', id: 'call-1', state: { content: [{ type: 'file', mime: 'image/png', uri: 'https://example.invalid/private.png' }] } }] }
  expect((await read(home, request, { response: { data: message } }))[0]).toMatchObject({ data: { image: null } })
  message.content[0]!.state.content[0]!.uri = 'data:image/png;base64,aW1hZ2U='
  expect((await read(home, request, { response: { data: message } }))[0]).toMatchObject({ data: { image: { mime: 'image/png', data: 'aW1hZ2U=' } } })
})

it('uses debug paths only when discovery needs it, without starting a service', async () => {
  const { home, state } = fixture()
  const custom = path.join(home, 'custom-state'); mkdirSync(path.join(custom, 'opencode'), { recursive: true })
  writeFileSync(path.join(custom, 'opencode/service.json'), JSON.stringify(state))
  rmSync(path.join(home, '.local/state/opencode/service.json'))
  const bin = path.join(home, '.opencode/bin'); mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\n[ "$1 $2 $3" = 'debug paths state' ] || exit 99\nprintf '%s\\n' '${custom}/opencode'\n`, { mode: 0o755 })
  expect((await read(home))[0]).toMatchObject({ status: 200 })
})

it('PATCHes only a whitelisted model body, then returns the verified session', async () => {
  const { home } = fixture()
  const model = { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'max' }
  const [r] = await read(home, { session: 'ses_example', op: 'model', model })
  expect(r).toMatchObject({ status: 200, data: { data: { model } } })
  // Extra or missing fields are refused before any request goes out.
  expect(await read(home, { session: 'ses_example', op: 'model', model: { id: 'x', providerID: 'y', hack: true } })).toEqual([{ error: 'Invalid OpenCode model' }])
  expect(await read(home, { session: 'ses_example', op: 'model', model: { id: 'x' } })).toEqual([{ error: 'Invalid OpenCode model' }])
  expect(await read(home, { session: 'ses_example', op: 'model', model: 'str' })).toEqual([{ error: 'Invalid OpenCode model' }])
})

it('reads the model catalog without a session', async () => {
  const { home } = fixture()
  const models = { data: [{ id: 'iceman-free', providerID: 'opencode-go', name: 'Iceman Free' }] }
  const [r] = await read(home, { session: 'ses_example', op: 'models' }, { models })
  expect(r).toMatchObject({ status: 200, data: models })
})

it('lists pending permission requests and forms in one run', async () => {
  const { home } = fixture()
  const permissions = [{ id: 'per_1', sessionID: 'ses_example', action: 'bash', resources: ['rm -rf /tmp/x'] }]
  const forms = [{ id: 'frm_1', sessionID: 'ses_example', title: 'Pick', fields: [{ key: 'k', type: 'boolean' }] }]
  const [r] = await read(home, { session: 'ses_example', op: 'pending' }, { permissions, forms })
  expect(r).toMatchObject({ status: 200, data: { permissions, forms } })
})

it('replies only a whitelisted decision, then re-lists the pending requests', async () => {
  const { home } = fixture()
  const permissions = [{ id: 'per_1', sessionID: 'ses_example', action: 'bash', resources: ['ls'] }]
  const [r] = await read(home, { session: 'ses_example', op: 'reply', request: 'per_1', decision: 'once' }, { permissions })
  // The peer answered the POST and its permission list no longer holds it.
  expect(r).toMatchObject({ status: 200, data: { pending: [] } })
  expect(await read(home, { session: 'ses_example', op: 'reply', request: 'per_1', decision: 'yes' })).toEqual([{ error: 'Invalid OpenCode reply' }])
  expect(await read(home, { session: 'ses_example', op: 'reply', request: '../escape', decision: 'once' })).toEqual([{ error: 'Invalid OpenCode reply' }])
  expect(await read(home, { session: 'ses_example', op: 'reply', request: 'per_1', decision: 'once', message: 42 })).toEqual([{ error: 'Invalid OpenCode reply' }])
})

it('answers a form field with only whitelisted answer shapes', async () => {
  const { home } = fixture()
  const forms = [{ id: 'frm_1', sessionID: 'ses_example', title: 'Go?', fields: [{ key: 'ok', type: 'boolean' }] }]
  const [r] = await read(home, { session: 'ses_example', op: 'form_reply', form: 'frm_1', key: 'ok', value: true }, { forms })
  expect(r).toMatchObject({ status: 200, data: { pending: [] } })
  expect(await read(home, { session: 'ses_example', op: 'form_reply', form: 'frm_1', key: 'ok', value: { hack: 1 } })).toEqual([{ error: 'Invalid OpenCode reply' }])
  expect(await read(home, { session: 'ses_example', op: 'form_reply', form: 'frm_1', key: 'a b', value: 'x' })).toEqual([{ error: 'Invalid OpenCode reply' }])
})

it('deletes only an inbox item a fresh listing still shows', async () => {
  const { home } = fixture()
  const inbox = [{ id: 'msg_1', type: 'user', payload: { text: 'hi' } }]
  expect((await read(home, { session: 'ses_example', op: 'inbox_delete', item: 'msg_gone' }, { inbox }))[0]).toMatchObject({ status: 404 })
  const [r] = await read(home, { session: 'ses_example', op: 'inbox_delete', item: 'msg_1' }, { inbox })
  expect(r).toMatchObject({ status: 200, data: { items: [] } })
  expect(await read(home, { session: 'ses_example', op: 'inbox_delete', item: 'a/b' })).toEqual([{ error: 'Invalid OpenCode reply' }])
})

it('runs a shell command and refuses empty or oversized ones', async () => {
  const { home } = fixture()
  expect((await read(home, { session: 'ses_example', op: 'shell', command: 'ls -la' }))[0]).toMatchObject({ status: 200 })
  expect(await read(home, { session: 'ses_example', op: 'shell', command: '  ' })).toEqual([{ error: 'Invalid OpenCode shell command' }])
  expect(await read(home, { session: 'ses_example', op: 'shell', command: 7 })).toEqual([{ error: 'Invalid OpenCode shell command' }])
})

it('attaches the inbox to every session read', async () => {
  const { home } = fixture()
  const inbox = [{ id: 'msg_1', type: 'user', payload: { text: 'later' } }]
  const [r] = await read(home, { session: 'ses_example', op: 'session' }, { inbox })
  expect(r).toMatchObject({ status: 200, data: { data: { id: 'ses_example' }, inbox } })
})
