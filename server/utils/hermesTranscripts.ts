// Hermes Agent conversations, read from the profile's `state.db` (SQLite, WAL;
// schema of NousResearch/hermes-agent v0.23.2, hermes_state_common.py). The
// database is shared by every session of the profile and written only by the
// profile's gateway: it is never written, checkpointed or given sidecars here.
// While the gateway holds it (`-wal` and `-shm` beside it) it is opened
// read-only in place; otherwise the main file alone is the whole database and
// opens `immutable=1`, which creates nothing. Locally through node:sqlite,
// remotely by Hermes' own Python (sqlite3, same rules) over the machine's shell.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import { excerpt, matchAt } from '../../shared/searchText'
import { type MachineFs, localFs } from './fsx'
import { HerdrError } from './herdr'
import { HERMES_POLICY_PREFIX, type HermesMessage, type HermesSession, hermesLineage, hermesVisible, parseHermes } from './hermesParse'
import { HERMES_ENVIRON_SH, type HermesEnv, hermesHome, hermesNodeEnviron, hermesToolbarSession, hermesTuiSession, parseEnviron } from './hermesSessions'
import { ompModelLabel } from './models'
import { type DatabaseSyncCtor, SQLITE_UNSUPPORTED, databaseSyncCtor, decodeSqliteText, isSqliteUnsupported, sqliteTextAsBlob } from './sqliteDb'
import { type PageOptions, type PageStep, hash12, pageSteps } from './stepPages'
import { isMissing } from './transcripts'

// A pane's conversation: its profile's database and the session id it shows;
// `python` is the interpreter running that Hermes (remote reads), else python3.
export interface HermesLoc { db: string, session: string, python?: string }

interface HermesDoc { steps: PageStep[], size: number, gen: string, model: string | null }
type Query = [sql: string, params: unknown[]]

const CACHE_ENTRIES = 8
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// Sessions of the conversation (the session id, twice) plus the lineage of its
// state_meta receipt (the receipt key): compression ancestors, compression
// continuations, and the receipt's own lineage.
const FAMILY = `WITH RECURSIVE up(id) AS (
  SELECT id FROM sessions WHERE id = ?
  UNION SELECT p.id FROM up JOIN sessions s ON s.id = up.id JOIN sessions p ON p.id = s.parent_session_id WHERE p.end_reason = 'compression'
), down(id) AS (
  SELECT id FROM sessions WHERE id = ?
  UNION SELECT s.id FROM down JOIN sessions p ON p.id = down.id JOIN sessions s ON s.parent_session_id = p.id WHERE p.end_reason = 'compression'
), family(id) AS (
  SELECT id FROM up UNION SELECT id FROM down
  UNION SELECT value FROM json_each(COALESCE((SELECT json_extract(value, '$.lineage') FROM state_meta WHERE key = ?), '[]'))
)`

function queries(session: string, uid: boolean, blobContent: boolean): Query[] {
  const policy = HERMES_POLICY_PREFIX + session
  // One `?` per occurrence: numbered parameters (?1) are not bound by
  // node:sqlite before Node 24.11 ("column index out of range").
  const params = [session, session, policy]
  const content = blobContent ? sqliteTextAsBlob('content') : 'content'
  return [
    [`${FAMILY} SELECT id, parent_session_id, end_reason, started_at, model FROM sessions WHERE id IN (SELECT id FROM family)`, params],
    ['SELECT value FROM state_meta WHERE key = ?', [policy]],
    [`${FAMILY} SELECT id, session_id, role, ${content}, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content, active, compacted, display_metadata${uid ? ', message_uid' : ''} FROM messages WHERE session_id IN (SELECT id FROM family) ORDER BY id`, params],
  ]
}

// stdin: {"db": path, "queries": [[sql, params]…]}; stdout: {"results"} | {"missing"} | {"error"}.
const PYTHON = `import json, os, sqlite3, sys
from pathlib import Path
q = json.load(sys.stdin)
db = q["db"]
live = lambda: os.path.exists(db + "-wal") and os.path.exists(db + "-shm")
def done(v):
    print(json.dumps(v))
    sys.exit(0)
for _ in range(2):
    if not os.path.isfile(db):
        done({"missing": True})
    held = live()
    try:
        c = sqlite3.connect(Path(db).resolve().as_uri() + ("?mode=ro" if held else "?mode=ro&immutable=1"), uri=True)
        try:
            c.row_factory = sqlite3.Row
            c.execute("BEGIN")
            out = [[{k: (None if isinstance(r[k], bytes) else r[k]) for k in r.keys()} for r in c.execute(s, p)] for s, p in q["queries"]]
        finally:
            c.close()
    except sqlite3.Error as e:
        done({"error": str(e)})
    if held or not live():
        done({"results": out})
done({"error": "moved"})
`
const PYTHON_SH = 'py=$1; command -v "$py" >/dev/null 2>&1 || py=python3; exec "$py" -I -c "$2"'

const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' })
const isOldSchema = (e: unknown) => /no such column: message_uid/.test(String((e as Error | null)?.message))

// Chat items grouped by the row they come from; a line without a row (a
// cleared conversation) goes with the next row.
function stepsOf(items: ChatItem[]): PageStep[] {
  const steps: PageStep[] = []
  let pending: ChatItem[] = []
  for (const item of items) {
    pending.push(item)
    const idx = item.ref ? Number(item.ref.split(':')[0]) : NaN
    if (!Number.isSafeInteger(idx)) continue
    const last = steps.at(-1)
    if (last?.idx === idx) last.items.push(...pending)
    else steps.push({ idx, fp: '', items: pending })
    pending = []
  }
  for (const s of steps) s.fp = hash12(JSON.stringify(s.items))
  return steps
}

export function createHermesTranscripts({ fs = localFs, sqlite }: {
  fs?: MachineFs
  // The DatabaseSync class (tests); `null` simulates a Node without node:sqlite.
  sqlite?: DatabaseSyncCtor | null
} = {}) {
  const docs = new Map<string, { stamp: string, doc: HermesDoc }>()
  const lastGood = new Map<string, string>()
  const oldSchema = new Set<string>()

  function remember<T>(cache: Map<string, T>, key: string, value: T) {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
  }

  async function local(db: string, list: Query[]): Promise<unknown[][]> {
    if (sqlite === null) throw Object.assign(new Error('node:sqlite is not available'), { code: SQLITE_UNSUPPORTED })
    const Db = sqlite ?? await databaseSyncCtor()
    // Not atomic with the open below: sidecars removed in between are
    // recreated, empty, beside Hermes's database and left there (deleting them
    // could remove a live writer's WAL; SQLite reuses them on the next open).
    const live = () => existsSync(`${db}-wal`) && existsSync(`${db}-shm`)
    // `content` is selected as a BLOB (see sqliteTextAsBlob): decode its bytes.
    const decode = (row: unknown) => {
      const r = row as { content?: unknown }
      return r.content instanceof Uint8Array ? { ...r, content: decodeSqliteText(r.content) } : row
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!existsSync(db)) throw missing()
      const held = live()
      const conn = new Db(held ? db : `${pathToFileURL(db).href}?mode=ro&immutable=1`, { readOnly: true })
      let out: unknown[][]
      try {
        conn.exec('BEGIN')
        out = list.map(([sql, params]) => (conn.prepare(sql).all(...params) as unknown[]).map(decode))
      } finally { conn.close() }
      // A gateway that opened the database during an immutable read may have
      // changed pages under it: read again, in place.
      if (held || !live()) return out
    }
    throw new Error('Hermes database moved during the read')
  }

  async function remote(loc: HermesLoc, list: Query[]): Promise<unknown[][]> {
    const input = Buffer.from(JSON.stringify({ db: loc.db, queries: list }))
    const out = await fs.run!(PYTHON_SH, [loc.python || 'python3', PYTHON], { input, timeoutMs: 20000, maxBytes: MAX_OUTPUT_BYTES })
    const r = JSON.parse(out.toString('utf8')) as { results?: unknown[][], missing?: boolean, error?: string }
    if (r.missing) throw missing()
    if (!r.results) throw new Error(r.error || 'Unable to read Hermes database')
    return r.results
  }

  async function read(loc: HermesLoc): Promise<HermesDoc | null> {
    // Local node:sqlite reads `content` as a BLOB to keep NUL bytes intact;
    // remote reads keep the TEXT value (Python never truncated it).
    const blobContent = fs === localFs
    const run = (list: Query[]) => (blobContent ? local(loc.db, list) : remote(loc, list))
    let res: unknown[][]
    try { res = await run(queries(loc.session, !oldSchema.has(loc.db), blobContent)) } catch (e) {
      if (!isOldSchema(e)) throw e
      oldSchema.add(loc.db)
      res = await run(queries(loc.session, false, blobContent))
    }
    const sessions = res[0] as HermesSession[]
    if (!sessions.some(s => s.id === loc.session)) return null
    const receipt = (res[1]?.[0] as { value?: string } | undefined)?.value
    // The live segment: compression continuations, earliest first.
    let tip = loc.session
    for (const seen = new Set([tip]); ;) {
      const cur = sessions.find(s => s.id === tip)
      const next = cur?.end_reason === 'compression'
        ? sessions.filter(s => s.parent_session_id === tip && !seen.has(s.id)).sort((a, b) => Number(a.started_at) - Number(b.started_at))[0]
        : undefined
      if (!next) break
      seen.add(tip = next.id)
    }
    const lineage = hermesLineage(tip, sessions, receipt)
    const inLineage = new Set(lineage)
    const rows = (res[2] as HermesMessage[]).filter(m => inLineage.has(m.session_id))
    const steps = stepsOf(parseHermes(hermesVisible(rows), sessions))
    const model = sessions.find(s => s.id === lineage.at(-1))?.model || null
    return { steps, size: rows.reduce((n, m) => Math.max(n, m.id), 0), gen: hash12(steps.map(s => s.fp).join('|')), model }
  }

  // The database and its WAL as they are now: a cached document is reused
  // while neither moves.
  async function load(loc: HermesLoc): Promise<HermesDoc | null> {
    if (fs !== localFs && !fs.run) throw Object.assign(new Error('remote reads unavailable'), { code: SQLITE_UNSUPPORTED })
    const [db, wal] = await fs.statMany([loc.db, `${loc.db}-wal`])
    if (!db?.isFile) throw missing()
    const stamp = [db, wal].map(s => (s ? `${s.ino ?? 0}:${s.mtimeMs}:${s.size}` : '-')).join('|')
    const key = `${loc.db}|${loc.session}`
    const hit = docs.get(key)
    if (hit?.stamp === stamp) return hit.doc
    const doc = await read(loc)
    if (doc) remember(docs, key, { stamp, doc })
    else docs.delete(key)
    return doc
  }

  async function chat(loc: HermesLoc, opts: PageOptions = {}): Promise<ChatResponse> {
    const key = `${loc.db}|${loc.session}`
    try {
      const doc = await load(loc)
      if (!doc) return { available: false, reason: 'not_found' }
      const reply = { ...pageSteps(doc.steps, { file: loc.session, size: doc.size, gen: doc.gen }, opts), session: loc.session }
      if (opts.before == null && reply.token) remember(lastGood, key, reply.token)
      return reply
    } catch (e) {
      if (isMissing(e)) return { available: false, reason: 'not_found' }
      if (isSqliteUnsupported(e)) return { available: false, reason: 'unsupported' }
      // A read that failed (a busy or moving database): an unchanged client keeps its view.
      if (opts.before == null && opts.since && lastGood.get(key) === opts.since) {
        return { available: true, session: loc.session, file: loc.session, token: opts.since, unchanged: true }
      }
      throw new HerdrError('internal', 'Unable to read Hermes conversation')
    }
  }

  async function search(loc: HermesLoc, text: string, deadline: number) {
    const doc = Date.now() < deadline ? await load(loc).catch(e => { if (isMissing(e) || isSqliteUnsupported(e)) return null; throw e }) : null
    const hits: { role: 'user' | 'assistant', text: string, excerpt: string, ts: string | null, offset: number }[] = []
    const steps = doc?.steps || []
    for (let i = steps.length - 1; i >= 0; i--) {
      if (Date.now() >= deadline) return { hits, limited: true, kind: 'hermes' }
      for (const item of steps[i]!.items) {
        if (item.role !== 'user' && item.role !== 'assistant') continue
        const at = matchAt(item.text || '', text)
        if (at < 0) continue
        hits.push({ role: item.role, text: item.text!.slice(0, 180), excerpt: excerpt(item.text!, at, 120, text), ts: item.ts ?? null, offset: steps[i]!.idx })
        if (hits.length === 8) return { hits, limited: i > 0, kind: 'hermes' }
      }
    }
    return { hits, limited: !doc && Date.now() >= deadline, kind: 'hermes' }
  }

  async function model(loc: HermesLoc): Promise<ModelInfo | null> {
    const doc = await load(loc).catch(() => null)
    return doc?.model ? { id: doc.model, label: ompModelLabel(doc.model) } : null
  }

  return { chat, search, model }
}

// The pane's Hermes process: its interpreter, its own environment and the
// environments of its Node children (the TUI), one shell call on its machine.
const PROBE_SH = `printf 'exe %s\\n' "$(readlink "/proc/$1/exe" 2>/dev/null)"
printf 'env %s\\n' "$(head -c 262144 "/proc/$1/environ" 2>/dev/null | base64 | tr -d '\\n')"
${HERMES_ENVIRON_SH}`

function probeLocal(pid: number): Promise<string> {
  return new Promise(resolve => execFile('sh', ['-c', PROBE_SH, 'sh', String(pid)], { timeout: 5000, maxBuffer: 4 << 20 }, (_e, out) => resolve(String(out || ''))))
}

/**
 * Which conversation a Hermes pane shows (see hermesSessions.ts): the TUI's
 * active-session file, else the classic CLI's bottom bar on `screen()`; the
 * database of the profile the process serves. Anything unsure gives null.
 */
export async function locateHermes(fs: MachineFs, home: string, proc: { pid?: number, argv?: string[] }, screen: () => Promise<string>): Promise<HermesLoc | null> {
  const pid = proc.pid
  if (!Number.isSafeInteger(pid) || pid! <= 0) return null
  const out = fs === localFs ? await probeLocal(pid!) : fs.run ? (await fs.run(PROBE_SH, [String(pid)], { timeoutMs: 8000 })).toString('utf8') : ''
  const line = (tag: string) => out.split('\n').find(l => l.startsWith(`${tag} `))?.slice(tag.length + 1).trim() || ''
  const exe = line('exe')
  const node = hermesNodeEnviron(out)
  // Pure helpers take sync readers: ask once for the file they want, read it, ask again.
  const twice = async <T>(ask: (read: (file: string) => string | null) => T): Promise<T> => {
    let want: string | null = null
    const first = ask((file) => { want = file; return null })
    if (!want) return first
    const text = await fs.readFile(want).catch(() => null)
    return ask(file => (file === want ? text : null))
  }
  const dbOf = (env: HermesEnv, argv: string[]) => twice(read => hermesHome(env, home, argv, root => read(path.join(root, 'active_profile'))))
  const session = node ? await twice(read => hermesTuiSession(node, read)) : hermesToolbarSession(await screen().catch(() => ''))
  const db = node ? await dbOf(node, []) : await dbOf(parseEnviron(Buffer.from(line('env'), 'base64').toString('utf8')), proc.argv || [])
  return session && db ? { db, session, ...(path.isAbsolute(exe) ? { python: exe } : {}) } : null
}
