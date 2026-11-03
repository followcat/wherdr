// Devin CLI writes every message of a session to its own SQLite store, in
// real time — the ATIF transcript only lands when a turn ends. This reader
// walks the session's main chain of message nodes plus the chains compaction
// abandoned (stitched back through their summarized_from marks), read on the
// machine owning the store by a small python3 script — the same python3
// Herdr's own Devin hook already needs.
//
// The store is private, so every query is bounded, per-session and read-only
// (?mode=ro + query_only), and guarded by refinery_schema_history's version:
// an unknown schema leaves interpretation to the ATIF fallback in
// devinTranscripts.ts.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import type { TranscriptImage, TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { ompModelLabel } from './models'
import { type MachineFs, type ShellExec, boundedOutput, localFs } from './fsx'
import { HerdrError } from './herdr'

const PAGE_ITEMS = 120 // one screenful, keep paging cheap
const PROBE_RETRY_MS = 60 * 1000
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024
const IMAGE_MAX_BYTES = 84 * 1024 * 1024
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/
const CLIP = 32 * 1024

export interface DevinStoreOptions {
  home: string
  fs?: MachineFs
  exec?: ShellExec
  now?: () => number
  failQuietMs?: number
  spawnProcess?: typeof spawn
}
interface StoreOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }

interface Json { [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any

// Run on the machine owning the session. Python's SQLite reader understands
// WAL snapshots; copying sessions.db alone would lose committed messages.
// Read-only (?mode=ro), query_only and bounded: per-session index scans only —
// the store can hold gigabytes, so whole-table scans are out. It never walks
// under an env-override data directory on a remote machine (no HOME there).
export const DEVIN_QUERY = String.raw`
import hashlib, json, os, pathlib, sqlite3, sys, time

MAX_ROW = 84 * 1024 * 1024
MAX_BYTES = 24 * 1024 * 1024
MAX_NODES = 200000
MAX_CHAINS = 24
SCHEMA_VERSIONS = {20}
VISIBLE_PAGE = 120
CONTEXT_AHEAD = 256

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
    # Image payloads stay out of pages: their hash still lets the view
    # collapse a picture repeated in a later message.
    if isinstance(value, dict):
        out = {k: ('' if k == 'data' and value.get('type') == 'image' and isinstance(v, str) else trim(v)) for k, v in value.items()}
        if value.get('type') == 'image' and isinstance(value.get('data'), str):
            out['hash'] = digest(value['data'])
        return out
    if isinstance(value, list):
        return [trim(v) for v in value]
    if isinstance(value, str):
        return value[:20000] + ('…' if len(value) > 20000 else '')
    return value

def main():
    if not file.is_file():
        return {'available': False}
    con = sqlite3.connect(file.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)
    try:
        con.execute('PRAGMA query_only=ON')
        con.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        version = con.execute('SELECT max(version) FROM refinery_schema_history').fetchone()[0]
        if version not in SCHEMA_VERSIONS:
            return {'available': False, 'db': str(file), 'version': version, 'unsupported': True}
        if request['op'] == 'probe':
            return {'available': True, 'db': str(file), 'version': version}
        for table, required in [('sessions', {'id', 'main_chain_id', 'model'}), ('message_nodes', {'session_id', 'node_id', 'parent_node_id', 'chat_message'})]:
            columns = {r[1] for r in con.execute('PRAGMA table_info(' + table + ')')}
            if not required.issubset(columns):
                raise ValueError('Unsupported Devin session database format')
        sid = request['session']
        session = con.execute('SELECT main_chain_id,model FROM sessions WHERE id=?', (sid,)).fetchone()
        if not session:
            return {'available': False, 'db': str(file)}
        identity = digest(str(file.resolve()) + ':' + str(file.stat().st_ino) + ':' + sid)
        # The per-session signature a quiet poll compares: the chain head and
        # the newest written node. WAL checkpoints move the files without it.
        count, max_row = con.execute('SELECT count(*),max(row_id) FROM message_nodes WHERE session_id=?', (sid,)).fetchone()
        sig = str(session[0]) + '-' + str(max_row or 0) + '-' + str(count)
        base = {'available': True, 'db': str(file), 'file': 'devin-' + identity, 'model': session[1], 'sig': sig}
        if request['op'] == 'page' and request.get('before') is None and request.get('sig') == sig:
            return {**base, 'signature': True}
        parents, summarized = {}, {}
        for nid, par, sf in con.execute("SELECT node_id,parent_node_id,json_extract(metadata,'$.summarized_from') FROM message_nodes WHERE session_id=? LIMIT ?", (sid, MAX_NODES + 1)):
            parents[nid] = par
            if sf is not None:
                summarized[nid] = sf
        if len(parents) > MAX_NODES:
            raise ValueError('Devin conversation exceeds the supported node limit')
        if any(not isinstance(n, int) or n < 0 or n >= 9007199254740991 or not isinstance(parents[n], int) and parents[n] is not None and (parents[n] < 0 or parents[n] >= 9007199254740991) for n in parents):
            raise ValueError('Unsupported Devin node identifier')

        # The live chain plus the chains compaction abandoned, oldest first:
        # a node whose metadata carries summarized_from is where the summary
        # was grafted, and the chain it names is spliced in just before it.
        # Nodes shared with an earlier chain (the system prefix) are emitted
        # once, at their position on the newest chain.
        stitched, emitted, seam_nodes = [], set(), set()
        def emit(head, depth):
            if depth > MAX_CHAINS:
                raise ValueError('Devin conversation exceeds the supported compaction depth')
            ids, seen, node = [], set(), head
            while node is not None:
                if node in seen or node not in parents:
                    raise ValueError('Invalid Devin conversation chain')
                seen.add(node)
                ids.append(node)
                parent = parents[node]
                if parent is not None and parent >= node:
                    raise ValueError('Unsupported Devin node ordering')
                node = parent
            for n in reversed(ids):
                if n in emitted:
                    continue
                emitted.add(n)
                sf = summarized.get(n)
                if sf is not None and sf != n and sf in parents:
                    emit(sf, depth + 1)
                    seam_nodes.add(n)
                stitched.append(n)
        emit(session[0], 0)
        positions = {node + 1: i for i, node in enumerate(stitched)}

        def prefix(index):
            return digest(identity + ':' + json.dumps([(n, parents[n]) for n in stitched[:index + 1]]))

        def row(node, full=False):
            size, = con.execute('SELECT length(CAST(chat_message AS BLOB)) FROM message_nodes WHERE session_id=? AND node_id=?', (sid, node)).fetchone()
            if size > MAX_ROW:
                raise ValueError('Devin message exceeds the supported size limit')
            raw, = con.execute('SELECT chat_message FROM message_nodes WHERE session_id=? AND node_id=?', (sid, node)).fetchone()
            value = json.loads(raw)
            r = {'id': node, 'message': value if full else trim(value)}
            if node in seam_nodes:
                r['seam'] = True
            return r, size

        if request['op'] == 'image':
            node = request['node']
            if node not in emitted:
                return {'available': False}
            r, _ = row(node, True)
            return {**base, 'rows': [r]}
        if request['op'] == 'model':
            found, generation = {}, None
            tail = stitched[-64:]
            if tail:
                for nid, raw in con.execute('SELECT node_id,chat_message FROM message_nodes WHERE session_id=? AND node_id IN (' + ','.join('?' * len(tail)) + ')', (sid, *tail)):
                    found[nid] = raw
            for nid in reversed(tail):
                raw = found.get(nid)
                if raw is not None and json.loads(raw).get('role') == 'assistant':
                    generation = (json.loads(raw).get('metadata') or {}).get('generation_model')
                    break
            return {**base, 'generation_model': generation}
        if request['op'] == 'search':
            rows, used, limited = [], 0, False
            for node in reversed(stitched):
                if time.monotonic() > deadline or used >= 8 * 1024 * 1024:
                    limited = True
                    break
                r, size = row(node)
                used += size
                if r['message'].get('role') in ('user', 'assistant'):
                    rows.append(r)
            return {**base, 'rows': rows, 'limited': limited}

        def visible_of(r, node):
            m = r['message']
            role = m.get('role')
            count = int(node in seam_nodes)
            if role == 'user':
                count += int((m.get('metadata') or {}).get('is_user_input') is True)
            elif role == 'assistant':
                count += int(bool(m.get('content'))) + int(bool(m.get('thinking'))) + len(m.get('tool_calls') or [])
            return count

        def take(candidates):
            # Walk candidates until the page holds VISIBLE_PAGE chat items
            # (or the byte budget runs out).
            rows, used, visible = [], 0, 0
            for node in candidates:
                if time.monotonic() > deadline:
                    raise TimeoutError('Devin conversation read timed out')
                r, _ = row(node)
                used += len(json.dumps(r).encode())
                if used > MAX_BYTES:
                    return rows, visible, True
                rows.append(r)
                visible += visible_of(r, node)
                if visible >= VISIBLE_PAGE:
                    break
            return rows, visible, False

        anchor = request.get('anchor')
        invalid = bool(anchor and (anchor['file'] != base['file'] or (anchor['start'] not in positions and anchor['start'] != 0)))
        if anchor and not invalid:
            at = positions.get(anchor['start'], 0)
            invalid = anchor['prefix'] != prefix(at)
        before, start = request.get('before'), request.get('from')
        if before is not None and before not in positions and before != 0:
            invalid = True
        if start is not None and start not in positions and start != 0:
            invalid = True
        if invalid and before is not None:
            return {**base, 'rewritten': True, 'rows': [], 'context': [], 'start': 0, 'prefix': '', 'seams': sorted(seam_nodes)}
        end = positions.get(before, 0) if before is not None else len(stitched)
        lo = positions.get(start, 0) if start is not None and not invalid and before is None else None
        if lo is None:
            selected, _, _ = take(reversed(stitched[:end]))
            selected.reverse()
            lo = positions[selected[0]['id'] + 1] if selected else 0
        else:
            selected, _, over = take(iter(stitched[lo:end]))
            if over:
                # A from-cursor page that does not fit: the view restarts
                # from a fresh bottom page.
                invalid = True
                selected, _, _ = take(reversed(stitched))
                selected.reverse()
                lo = positions[selected[0]['id'] + 1] if selected else 0
        calls = {call.get('id') for r in selected for call in (r['message'].get('tool_calls') or []) if isinstance(call.get('id'), str)}
        calls -= {r['message'].get('tool_call_id') for r in selected if r['message'].get('role') == 'tool'}
        context = []
        for node in stitched[end:end + CONTEXT_AHEAD]:
            if not calls:
                break
            if time.monotonic() > deadline:
                raise TimeoutError('Devin conversation read timed out')
            r, _ = row(node)
            m = r['message']
            if m.get('role') == 'tool' and m.get('tool_call_id') in calls:
                calls.remove(m['tool_call_id'])
                context.append(r)
        return {**base, 'rows': selected, 'context': context, 'start': stitched[lo] + 1 if lo else 0, 'prefix': prefix(lo), 'rewritten': invalid, 'seams': sorted(seam_nodes)}
    finally:
        con.close()

try:
    print(json.dumps(main()))
except Exception as error:
    print(json.dumps({'error': str(error) if isinstance(error, (ValueError, TimeoutError)) else 'Unable to read Devin conversation (' + type(error).__name__ + ')'}))
    sys.exit(1)
`

const clip = (s: string) => s.length > CLIP ? s.slice(0, CLIP) + '…' : s
const asList = (v: unknown): Json[] => Array.isArray(v) ? v : []
const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const isMissing = (e: unknown) => /ENOENT|not found|does not exist|no such file/i.test(String((e as Error)?.message || e))

// The token tells which source produced it (the ATIF reader's starts "devin:")
// so a source switch is always a rewritten reset, never a mix.
const STORE_TOKEN = /^devins:(devin-[a-f0-9]{24}):([0-9a-f]{12}|x):([^/~#]+)\/(\d+)\.([0-9a-f]{24})(?=[~#]|$)/
interface StoreToken { file: string, dbsig: string, sessig: string, start: number, prefix: string }
function storeToken(token: unknown): StoreToken | null {
  const m = STORE_TOKEN.exec(String(token || ''))
  return m ? { file: m[1]!, dbsig: m[2]!, sessig: m[3]!, start: Number(m[4]), prefix: m[5]! } : null
}

// Content blocks that hold images live alongside the text content.
function blocks(message: Json): Json[] {
  const parts = message.metadata?.extensions?.['chisel/acp-content-blocks']
  if (Array.isArray(parts)) return parts
  return Array.isArray(message.content) ? message.content : []
}
function images(value: unknown): Json[] {
  return asList(value).filter(v => v && typeof v === 'object' && v.type === 'image' && (v.data || v.hash))
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  return asList(value).filter(v => v && typeof v === 'object' && v.type === 'text' && typeof v.text === 'string').map(v => v.text).join('\n\n')
}
// Same failure rule as the ATIF reader's toolError.
function toolError(result: Json | undefined): boolean {
  const meta = result?.metadata?.extensions?.['chisel/tool_result_meta']
  if (meta && typeof meta === 'object' && (meta.success === false || (typeof meta.exit_code === 'number' && meta.exit_code !== 0))) return true
  const text = result && contentText(result.content)
  return Boolean(text && /(^|\n)\s*(error|exception|traceback|failed)\b/i.test(text))
}

export function createDevinStore({ home, fs = localFs, exec, now = () => Date.now(), failQuietMs = 2 * 60 * 1000, spawnProcess = spawn }: DevinStoreOptions) {
  const honorEnv = fs === localFs // on the local machine only
  const dbPath = new Map<string, string>()
  const inflight = new Map<string, Promise<Json>>()
  const lastGood = new Map<string, ChatResponse>()
  const lastModel = new Map<string, ModelInfo | null>()
  const modelCache = new Map<string, { dbsig: string, info: ModelInfo | null }>()
  const verified = new Map<string, string>()
  const failAt = new Map<string, number>()
  const failAtEvict = new Map<string, number>()
  const quiet = (k: string) => now() - (failAt.get(k) || 0) < failQuietMs
  let probed: { ok: boolean, at: number } | null = null

  function sessionsDb(): string {
    if (honorEnv && process.env.DEVIN_SESSIONS_DIR) return path.join(process.env.DEVIN_SESSIONS_DIR, 'sessions.db')
    if (honorEnv && process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'devin/cli/sessions.db')
    return path.join(home, '.local/share/devin/cli/sessions.db')
  }

  function jsonArgument(value: unknown): string {
    // Keep the argument ASCII-safe for the remote shell's UTF-8 boundaries.
    return JSON.stringify(value).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  }

  function localQuery(request: Json, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawnProcess('python3', ['-X', 'utf8', '-c', DEVIN_QUERY, home, jsonArgument(request)], { stdio: ['ignore', 'pipe', 'pipe'] })
      const out = boundedOutput(maxBytes)
      const err = boundedOutput(4096)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
      child.stdout.on('data', (b: Buffer) => { if (!out.push(b)) child.kill() })
      child.stderr.on('data', (b: Buffer) => { if (!err.push(b)) child.kill() })
      child.on('error', () => { clearTimeout(timer); reject(new Error('Python 3 is required to read Devin conversations')) })
      child.on('close', code => {
        clearTimeout(timer)
        if (timedOut || out.over) return reject(new Error('Devin conversation read exceeded its limit'))
        const body = out.take()
        if (code !== 0) {
          let message = 'Unable to read Devin conversation'
          try { message = JSON.parse(body.toString()).error || message } catch { /* python failed before producing JSON */ }
          reject(new Error(message))
        } else resolve(body)
      })
    })
  }

  async function run(session: string | null, op: string, options: Json = {}, maxBytes = MAX_SNAPSHOT_BYTES): Promise<Json> {
    const request = { session, op, ...options }
    const key = JSON.stringify(request)
    const known = inflight.get(key)
    if (known) return known
    const work = (async () => {
      let body: Buffer
      if (exec) {
        const r = await exec('python3 -X utf8 -c "$1" "$2" "$3"', [DEVIN_QUERY, home, jsonArgument(request)], { timeoutMs: 15000, maxBytes })
        if (r.code !== 0) {
          let error = r.code === 127 ? 'Python 3 is required to read Devin conversations' : 'Unable to read Devin conversation on the remote machine'
          try { error = JSON.parse(r.stdout.toString()).error || error } catch { /* SSH or the runtime is unavailable */ }
          throw new Error(error)
        }
        body = r.stdout
      } else {
        body = await localQuery(request, maxBytes)
      }
      return JSON.parse(body.toString('utf8')) as Json
    })()
    inflight.set(key, work)
    try { return await work } finally { inflight.delete(key) }
  }

  // Level 1 of a quiet poll: db and WAL size/mtime through MachineFs. A WAL
  // checkpoint moves them without the session changing, which level 2 (the
  // per-session signature) then confirms.
  async function statSig(session: string): Promise<string | null> {
    const db = dbPath.get(session) || sessionsDb()
    const [d, w] = await fs.statMany([db, `${db}-wal`])
    if (!d?.isFile) return null
    return hash12(`${d.size}:${Math.round(d.mtimeMs)}:${w ? `${w.size}:${Math.round(w.mtimeMs)}` : 'x'}`)
  }

  async function probe(): Promise<boolean> {
    if (probed && (probed.ok || now() - probed.at < PROBE_RETRY_MS)) return probed.ok
    try {
      const r = await run(null, 'probe', {}, 64 * 1024)
      probed = { ok: r.available === true && r.unsupported !== true, at: now() }
    } catch { probed = { ok: false, at: now() } }
    return probed.ok
  }

  function parseStore(snap: Json): ChatItem[] {
    const results = new Map<string, Json>()
    for (const r of [...(snap.rows || []), ...(snap.context || [])]) {
      const m = r?.message
      if (m?.role === 'tool' && typeof m.tool_call_id === 'string' && !results.has(m.tool_call_id)) results.set(m.tool_call_id, r)
    }
    const items: ChatItem[] = []
    for (const row of snap.rows || []) {
      const m = row?.message
      if (!m || typeof m !== 'object') continue
      const ts = typeof m.metadata?.created_at === 'string' ? m.metadata.created_at : null
      const ref = (slot: string) => `${row.id}:${slot}`
      if (row.seam) items.push({ role: 'notice', name: 'compaction', text: clip(contentText(m.content)), ts, ref: ref('s') })
      if (m.role === 'user') {
        if (m.metadata?.is_user_input !== true) continue
        const parts = blocks(m)
        const text = clip(m.content) || clip(contentText(parts))
        const imgs = images(parts)
        if (text || imgs.length) {
          const it: ChatItem = { role: 'user', text, ts, ref: ref('u') }
          if (imgs.length) { it.images = imgs.length; it.hashes = imgs.map(i => i.hash || hash12(`${i.data || ''}:${ref('u')}`)) }
          items.push(it)
        }
        continue
      }
      if (m.role !== 'assistant') continue
      const thinking = typeof m.thinking === 'string' ? m.thinking : m.thinking?.thinking
      if (thinking) items.push({ role: 'thinking', text: clip(String(thinking)), ts, ref: ref('h') })
      const text = clip(contentText(m.content))
      const imgs = images(blocks(m))
      if (text || imgs.length) {
        const it: ChatItem = { role: 'assistant', text, ts, ref: ref('a') }
        if (imgs.length) { it.images = imgs.length; it.hashes = imgs.map(i => i.hash || hash12(`${i.data || ''}:${ref('a')}`)) }
        items.push(it)
      }
      for (const [index, call] of asList(m.tool_calls).entries()) {
        if (!call || typeof call !== 'object' || typeof call.id !== 'string') continue
        const hit = results.get(call.id)
        const input = call.arguments && typeof call.arguments === 'object' ? call.arguments : {}
        const title = typeof call.name === 'string' ? call.name : 'Tool'
        const summary = input.command || input.file_path || input.path || input.query || input.pattern || title
        const out = hit ? clip(contentText(hit.message.content)) : ''
        const rich = hit ? (hit.message.metadata?.extensions?.['chisel/tool_call_content'] || []) : []
        const imgs = images(rich)
        const it: ChatItem = {
          role: 'tool',
          name: title,
          text: clip(String(summary || title)),
          ts,
          ref: hit && imgs.length ? `${hit.id}:r` : ref(`t${index}`),
        }
        if (out) it.out = out
        if (toolError(hit?.message)) it.error = true
        if (imgs.length) { it.images = imgs.length; it.hashes = imgs.map(i => i.hash || hash12(`${i.data || ''}:${ref(`t${index}`)}`)) }
        items.push(it)
      }
    }
    return items
  }

  function failOpen(session: string, e: unknown, opts: StoreOptions, base: { available: true, session: string }): never | ChatResponse {
    if (isMissing(e)) {
      dbPath.delete(session); lastGood.delete(session); lastModel.delete(session); verified.delete(session); failAt.delete(session); modelCache.delete(session)
      return { available: false, reason: 'not_found' }
    }
    const good = lastGood.get(session)
    const first = !failAt.has(session)
    failAt.set(session, now()); failAtEvict.set(session, now() + 10 * failQuietMs)
    if (failAt.size > 64) {
      for (const [k, at] of failAtEvict) if (at < now()) { failAt.delete(k); failAtEvict.delete(k); verified.delete(k) }
      if (failAt.size > 64) { failAt.clear(); failAtEvict.clear() }
    }
    if (good) return { ...base, file: good.file, token: opts.since || good.token, unchanged: true }
    if (first) throw e
    throw new HerdrError('internal', 'Unable to read Devin conversation')
  }

  async function chat(pane: TranscriptPane, opts: StoreOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session) return { available: false, reason: 'not_found' }
    const base = { available: true as const, session }
    if (quiet(session)) {
      const good = lastGood.get(session)
      if (good) return { ...base, file: good.file, token: opts.since || good.token, unchanged: true }
      throw new HerdrError('internal', 'Unable to read Devin conversation')
    }
    try {
      const sent = opts.anchor ?? opts.since
      const tok = storeToken(opts.since)
      const foreign = Boolean(sent) && !storeToken(sent)
      const before = opts.before === undefined ? null : opts.before
      const from = opts.from === undefined ? null : opts.from
      if (foreign && before != null) {
        // An older page from another source's list: reset rather than mix.
        return { ...base, older: true as const, items: [], start: 0, rewritten: true as const }
      }
      const dbsig = before == null ? await statSig(session).catch(e => { if (isMissing(e)) return null; throw e }) : null
      if (before == null && tok && dbsig && (dbsig === tok.dbsig || verified.get(session) === `${tok.sessig}@${dbsig}`)) {
        const r: ChatResponse = { ...base, file: tok.file, token: opts.since, unchanged: true }
        lastGood.set(session, r)
        return r
      }
      const anchorTok = sent ? storeToken(sent) : null
      const reply = await run(session, 'page', {
        from, before,
        // A foreign token cannot be decomposed; its empty parts fail the
        // anchor check below, which is what a source switch needs.
        anchor: sent ? { file: anchorTok?.file || '', start: anchorTok?.start ?? 0, prefix: anchorTok?.prefix || '' } : null,
        sig: before == null ? tok?.sessig ?? null : null,
      })
      if (!reply.available) {
        dbPath.delete(session); lastGood.delete(session); lastModel.delete(session); verified.delete(session); modelCache.delete(session); failAt.delete(session)
        return { available: false, reason: 'not_found' }
      }
      failAt.delete(session)
      if (reply.db) dbPath.set(session, reply.db)
      if (reply.signature) {
        if (dbsig) verified.set(session, `${reply.sig}@${dbsig}`)
        const r: ChatResponse = { ...base, file: reply.file, token: opts.since, unchanged: true }
        lastGood.set(session, r)
        return r
      }
      const items = parseStore(reply)
      const token = `devins:${reply.file}:${dbsig || 'x'}:${reply.sig}/${reply.start}.${reply.prefix}`
      if (dbsig) verified.set(session, `${reply.sig}@${dbsig}`)
      const r: ChatResponse = before != null
        ? { ...base, file: reply.file, older: true, items, start: reply.start || 0, ...(reply.rewritten || foreign ? { rewritten: true as const } : {}) }
        : { ...base, file: reply.file, token, items, start: reply.start || 0, queue: [], ...(reply.rewritten || foreign ? { rewritten: true as const } : {}) }
      lastGood.set(session, r)
      const model = reply.generation_model || reply.model
      lastModel.set(session, typeof model === 'string' && model ? { id: model, label: ompModelLabel(model) } : null)
      return r
    } catch (e) { return failOpen(session, e, opts, base) }
  }

  async function image(pane: TranscriptPane, fileId: string | null, ref: string | null, index: number): Promise<TranscriptImage | null> {
    const m = /^(\d+):(u|a|r|t\d+)$/.exec(ref || '')
    if (!pane.agentSession || !m || !Number.isSafeInteger(index) || index < 0) return null
    const r = await run(pane.agentSession, 'image', { node: Number(m[1]) }, IMAGE_MAX_BYTES).catch(e => { if (isMissing(e)) return null; throw e })
    if (!r || !r.available || r.file !== fileId || !r.rows?.[0]) return null
    const message = r.rows[0].message
    const slot = m[2]!
    let rich: unknown = blocks(message)
    if (slot === 'r') rich = message.metadata?.extensions?.['chisel/tool_call_content']
    if (slot.startsWith('t')) return null
    const img = images(rich)[index]
    if (!img || typeof img.data !== 'string' || img.data.length > 80 * 1024 * 1024) return null
    const body = Buffer.from(img.data, 'base64')
    if (body.length > 60 * 1024 * 1024) return null
    const mime = String(img.mimeType || 'image/png').toLowerCase()
    return { type: IMAGE_TYPES.test(mime) ? mime : 'application/octet-stream', body }
  }

  async function search(pane: TranscriptPane, text: string, deadline: number) {
    if (!pane.agentSession) return null
    if (Date.now() >= deadline) return { hits: [], limited: true, kind: 'devin' }
    const r = await run(pane.agentSession, 'search', { seconds: Math.max(.1, (deadline - Date.now()) / 1000) }).catch(e => { if (isMissing(e)) return null; throw e })
    if (!r || !r.available) return null
    failAt.delete(pane.agentSession)
    const hits = parseStore(r).filter(i => i.role === 'user' || i.role === 'assistant').flatMap(i => {
      const at = matchAt(i.text, text)
      return at < 0 ? [] : [{ role: i.role, ts: i.ts, excerpt: excerpt(i.text, at, 120, text), offset: Number(i.ref!.split(':')[0]) + 1 }]
    })
    return { hits, limited: Boolean(r.limited), kind: 'devin' }
  }

  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    const session = pane.agentSession
    if (!session) return null
    try {
      if (quiet(session)) return lastModel.get(session) ?? null
      const dbsig = await statSig(session).catch(e => { if (isMissing(e)) return null; throw e })
      const hit = dbsig && modelCache.get(session)
      if (hit && hit.dbsig === dbsig) { lastModel.set(session, hit.info); return hit.info }
      const r = await run(session, 'model')
      if (!r.available) { lastModel.delete(session); modelCache.delete(session); return null }
      failAt.delete(session)
      const name = r.generation_model || r.model
      const info = typeof name === 'string' && name ? { id: name, label: ompModelLabel(name) } : null
      if (dbsig) modelCache.set(session, { dbsig, info })
      lastModel.set(session, info)
      return info
    } catch (e) {
      if (isMissing(e)) { lastModel.delete(session); modelCache.delete(session); return null }
      failAt.set(session, now()); failAtEvict.set(session, now() + 10 * failQuietMs)
      if (lastModel.has(session)) return lastModel.get(session)!
      throw e
    }
  }

  return { chat, image, search, model, probe }
}
