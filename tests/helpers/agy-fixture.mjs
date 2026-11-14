import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Invented Antigravity conversations, shared by reader and session tests.
// Never opens the developer's ~/.gemini/antigravity-cli files. The protobuf
// blobs below are written with this file's own minimal wire encoder, matching
// the reader in server/utils/agyTranscripts.ts:
//   metadata/payload.5: { 1: ts, 4: { 1: callId, 2: name, 3: args }, 6/8: span }
//   payload.19: { 2: user text }         (step_type 14, USER_INPUT)
//   payload.20: { 1: reply, 3: thinking, 7: { 1: id, 2: name, 3: args } } (15)
//   payload.24: { 3: { 2: text } }       (step_type 17, ERROR_MESSAGE)
//   payload.140: { 2: { 1: output } }    (step_type 132, OBSERVATION)
//   gen_metadata.data: { 1: { 19: model id, 21: label }, 3: { 28: model id } }
export const AGY_SESSION = '11111111-2222-4333-8444-555555555555'
export const AGY_OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const enc = new TextEncoder()
function varint(v) {
  let n = BigInt(v)
  const out = []
  do {
    let b = Number(n & 0x7fn)
    n >>= 7n
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return Buffer.from(out)
}
const key = (tag, wire) => varint(BigInt(tag) * 8n + BigInt(wire))
const vint = (tag, v) => Buffer.concat([key(tag, 0), varint(v)])
const msg = (tag, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([key(tag, 2), varint(b.length), b]) }
const str = (tag, s) => msg(tag, enc.encode(s))
const ts = (tag, iso) => {
  const ms = BigInt(Date.parse(iso))
  return msg(tag, vint(1, ms / 1000n), vint(2, (ms % 1000n) * 1000000n))
}

const BASE = Date.parse('2026-02-02T12:00:00Z')
const at = idx => new Date(BASE + idx * 1000).toISOString()

// Row shapes: user { role:'user', text }, agent { role:'agent', text?,
// thinking?, calls?: [{ id, name, args }], status? }, obs { role:'obs',
// resultOf, out, error? }, error { role:'error', text }, hidden
// { role:'hidden', type } — an internal step the chat must not render.
function stepBlobs(row, idx) {
  const meta = [ts(1, at(idx)), ts(6, at(idx))]
  if (row.role === 'obs') meta.push(msg(4, str(1, row.resultOf), str(2, row.name || 'run_command'), str(3, '{}')))
  meta.push(ts(8, at(idx)))
  let type = 101
  let inner = []
  if (row.role === 'user') { type = 14; inner = [msg(19, str(2, row.text))] }
  else if (row.role === 'agent') {
    type = 15
    const f20 = []
    if (row.text) f20.push(str(1, row.text))
    if (row.thinking) f20.push(str(3, row.thinking))
    for (const c of row.calls || []) f20.push(msg(7, str(1, c.id), str(2, c.name), str(3, c.args || '{}')))
    inner = [msg(20, ...f20)]
  } else if (row.role === 'error') { type = 17; inner = [msg(24, msg(3, str(2, row.text)))] }
  else if (row.role === 'obs') { type = 132; inner = [msg(140, msg(2, str(1, row.out)))] }
  else { type = row.type ?? 23 }
  const payload = Buffer.concat([vint(1, type), msg(5, ...meta), ...inner])
  const metadata = Buffer.concat(meta)
  return { type, metadata, payload }
}

function createConversation(file, session) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory numeric,
      metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)`)
  db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 1, 1)')
    .run(`traj-${session.slice(0, 8)}`, session)
  return db
}

function insertRows(db, rows, offset = 0) {
  const ins = db.prepare(`INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, render_info, step_payload, step_format)
    VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, 0)`)
  rows.forEach((row, i) => {
    const idx = row.idx ?? offset + i
    const { type, metadata, payload } = stepBlobs(row, idx)
    ins.run(idx, type, row.status ?? 3, metadata, payload)
  })
}

function insertModel(db, model, label) {
  if (!model) return
  const data = Buffer.concat([msg(1, str(19, model), str(21, label || model)), msg(3, str(28, model))])
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(data, data.length)
}

/**
 * Creates <home>/.gemini/antigravity-cli/conversations/<session>.db.
 * With `wal: true` the database stays open in WAL mode: pass the returned
 * `append(rows)` more rows to leave committed frames in the -wal sidecar, and
 * `close()` when done. Otherwise the fixture is fully written and closed.
 */
export function openAgyFixture(home, { session = AGY_SESSION, rows = [], model = 'test-model-a', modelLabel, wal = false } = {}) {
  const dir = path.join(home, '.gemini/antigravity-cli/conversations')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${session}.db`)
  const db = createConversation(file, session)
  insertModel(db, model, modelLabel)
  if (wal) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    insertRows(db, rows)
    return { file, db, append: extra => insertRows(db, extra, rows.length), close: () => db.close() }
  }
  insertRows(db, rows)
  db.close()
  return { file }
}

export function writeAgyFixture(home, opts = {}) {
  return openAgyFixture(home, opts).file
}

// A presence lock agy holds for its live conversation.
export function writeAgyPresence(home, session = AGY_SESSION) {
  const dir = path.join(home, '.gemini/antigravity-cli/presence')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${session}.lock`)
  fs.writeFileSync(file, '')
  return file
}

// conversation_summaries.db rows: { id, uris: [paths or file:// uris],
// depth, killed, modified, title, preview }.
export function writeAgySummaries(home, rows = []) {
  const dir = path.join(home, '.gemini/antigravity-cli')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'conversation_summaries.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
    step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, source TEXT, agent_name TEXT,
    parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, last_user_input_time TEXT,
    last_user_input_step_index INTEGER, app_data_dir TEXT, raw_summary TEXT, group_id TEXT)`)
  const ins = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, preview, step_count,
    last_modified_time, workspace_uris, status, nesting_depth, killed) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
  for (const [i, r] of rows.entries()) {
    const uris = (r.uris || []).map(u => u.startsWith('file://') ? u : `file://${u}`)
    ins.run(r.id, r.title ?? `Conversation ${i + 1}`, r.preview ?? '', r.steps ?? 4,
      r.modified ?? new Date(BASE + i * 60_000).toISOString(), JSON.stringify(uris), r.depth ?? 0, r.killed ?? 0)
  }
  db.close()
  return file
}
