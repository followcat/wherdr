import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const opencodeMessage = (id, type, text) => ({ id: `msg_${String(id).padStart(5, '0')}`, type,
  time: { created: 1700000000000 + id * 1000 }, ...(type === 'user' ? { text } : {
    agent: 'build', model: { id: 'sample-model', providerID: 'example' }, content: [{ type: 'text', text }],
  }) })

export const opencodeState = () => ({ messages: [], session: 'ses_example', password: 'fixture-password', version: '2.0.27',
  pid: 123, revert: undefined, fail: 0, requests: [], streams: new Set(), connections: 0,
  inbox: undefined, inboxFail: false, permissions: [], forms: [], tokens: undefined, cost: undefined })
export function opencodeReply(state, session, op, options = {}) {
  const base = { server: `fixture-server-${state.pid}`, status: 200 }
  if (state.fail) return { ...base, status: state.fail }
  if (session !== state.session) return { ...base, status: 404 }
  if (op === 'session') return { ...base, data: { data: { id: session, model: { id: 'sample-model', providerID: 'example' }, revert: state.revert,
    ...(state.tokens ? { tokens: state.tokens } : {}), ...(state.cost !== undefined ? { cost: state.cost } : {}) },
    // The real shim attaches the inbox read beside the session payload;
    // null means that read failed — unknown, not empty.
    inbox: state.inboxFail ? null : (state.inbox || []) } }
  if (op === 'pending') return { ...base, data: { permissions: state.permissions, forms: state.forms } }
  if (op === 'inbox') return { ...base, data: { data: state.inbox || [] } }
  if (op === 'inbox_delete') {
    const before = state.inbox || []
    state.inbox = before.filter(i => i.id !== options.item)
    return { ...base, status: before.length === (state.inbox || []).length ? 404 : 200, data: { items: state.inbox || [] } }
  }
  if (op === 'reply') {
    const still = state.permissions.filter(r => r.id !== options.request)
    const removed = still.length !== state.permissions.length
    state.permissions = still
    return { ...base, data: { pending: state.permissions }, ...(removed ? {} : { status: 404 }) }
  }
  if (op === 'form_reply') {
    const still = state.forms.filter(r => r.id !== options.form)
    const removed = still.length !== state.forms.length
    state.forms = still
    return { ...base, data: { pending: state.forms }, ...(removed ? {} : { status: 404 }) }
  }
  if (op === 'shell') return { ...base, status: options.command?.trim() ? 200 : 400, data: null }
  if (op === 'page') {
    let end = state.messages.length
    if (options.cursor) {
      end = state.messages.findIndex(m => m.id === Buffer.from(options.cursor, 'base64url').toString())
      if (end < 0) return { ...base, status: 400 }
    }
    const start = Math.max(0, end - 120)
    return { ...base, data: { data: state.messages.slice(start, end).reverse(), cursor: {
      previous: null, next: start ? Buffer.from(state.messages[start].id).toString('base64url') : null,
    } } }
  }
  const item = state.messages.find(m => m.id === options.message)
  if (!item) return { ...base, status: 404 }
  if (op === 'image') return { ...base, data: { image: item.files?.[options.index] || null } }
  return { ...base, data: { data: item } }
}

// Invented OpenCode 2.x HTTP/SSE service. Never starts or contacts a real agent.
export async function opencodeFixture(home) {
  const state = opencodeState()
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url })
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${state.password}`).toString('base64')}`) return json(res, 401, {})
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/info') return json(res, 200, { version: state.version, pid: state.pid, capabilities: {} })
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n')
      state.connections++; state.streams.add(res); res.on('close', () => state.streams.delete(res)); return
    }
    if (state.fail) return json(res, state.fail, {})
    const root = `/api/session/${state.session}`
    if (url.pathname === root) return json(res, 200, { data: { id: state.session, model: { id: 'sample-model', providerID: 'example' }, revert: state.revert } })
    if (url.pathname === root + '/message') {
      let end = state.messages.length
      const cursor = url.searchParams.get('cursor')
      if (cursor) {
        if (url.searchParams.has('order')) return json(res, 400, {})
        const id = Buffer.from(cursor, 'base64url').toString()
        end = state.messages.findIndex(m => m.id === id)
        if (end < 0) return json(res, 400, { _tag: 'InvalidCursorError' })
      }
      const start = Math.max(0, end - Number(url.searchParams.get('limit') || 50))
      return json(res, 200, { data: state.messages.slice(start, end).reverse(), cursor: {
        previous: null, next: start ? Buffer.from(state.messages[start].id).toString('base64url') : null,
      } })
    }
    if (url.pathname.startsWith(root + '/message/')) {
      const item = state.messages.find(m => m.id === decodeURIComponent(url.pathname.slice((root + '/message/').length)))
      return json(res, item ? 200 : 404, item ? { data: item } : {})
    }
    json(res, 404, { _tag: 'SessionNotFoundError' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  function save() {
    const dir = path.join(home, '.local/state/opencode'); mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ id: 'fixture-server', version: state.version, url, pid: state.pid, password: state.password }), { mode: 0o600 })
  }
  save()
  return { state, save, url,
    event: type => { for (const res of state.streams) if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(JSON.stringify({ type, sessionID: state.session }))}\n\n`) },
    disconnect: () => { for (const res of state.streams) res.end(); state.streams.clear() },
    async close() { for (const res of state.streams) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
