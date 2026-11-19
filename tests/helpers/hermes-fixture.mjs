import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Invented Hermes Agent state.db, shared by reader tests. Hand-written: only the
// columns wherdr reads (the full schema is checked separately against
// tests/fixtures/hermes-schema.sql). Never opens the developer's ~/.hermes.
//
// Conversation "local-chat" spans three segments:
//   local-chat --compression--> seg-2 --/reset--> seg-3   (receipt in state_meta)
// It holds a rewind, a model_only summary, "\x00json:" multimodal content, a tool
// call and its result, and a reasoning-only answer. `legacy: true` writes an old
// schema (v30) without message_uid and without the state_meta receipt (then
// only compression links segments: seg-3 stands alone).
const J = '\x00json:'
const T0 = 1767268800 // 2026-01-01T12:00:00Z

export function writeHermesFixture({ legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-hermes-'))
  const file = path.join(dir, 'state.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, cwd TEXT, title TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, transcript_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      reasoning TEXT, reasoning_content TEXT, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
      display_metadata TEXT${legacy ? '' : ', message_uid TEXT'});
    CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  db.prepare('INSERT INTO schema_version VALUES (?)').run(legacy ? 30 : 33)
  const session = db.prepare(`INSERT INTO sessions (id, source, model, cwd, title, parent_session_id, started_at, ended_at, end_reason)
    VALUES (?, 'tui', 'test-model', '~/project', 'Fixture chat', ?, ?, ?, ?)`)
  session.run('local-chat', null, T0, T0 + 100, 'compression')
  session.run('seg-2', 'local-chat', T0 + 100, T0 + 200, 'session_reset')
  session.run('seg-3', 'seg-2', T0 + 200, null, null)
  session.run('other', null, T0, null, null)

  const cols = ['session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp',
    'reasoning', 'reasoning_content', 'active', 'compacted', 'display_metadata', ...(legacy ? [] : ['message_uid'])]
  const insert = db.prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
  let t = T0
  const add = (sid, role, content, o = {}) => {
    const row = { session_id: sid, role, content, timestamp: t++, active: 1, compacted: 0, ...o }
    insert.run(...cols.map(c => row[c] ?? null))
  }
  const call = JSON.stringify([{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la\necho done' }) } }])

  // Segment 1, compacted by the compression into seg-2.
  add('local-chat', 'user', 'List the files', { active: 0, compacted: 1, message_uid: 'u1' })
  add('local-chat', 'assistant', '', { tool_calls: call, active: 0, compacted: 1, message_uid: 'u2' })
  add('local-chat', 'tool', 'a.txt\nb.txt', { tool_call_id: 'call_1', tool_name: 'terminal', active: 0, compacted: 1, message_uid: 'u3' })
  add('local-chat', 'assistant', 'Two files.', { active: 0, compacted: 1, message_uid: 'u4' })
  // Segment 2: the compression summary (model only), the protected tail copied
  // (same uid, newer content), then a rewound turn.
  add('seg-2', 'user', '[Summary of earlier turns]', { display_metadata: JSON.stringify({ model_only: true }), message_uid: 'sum' })
  add('seg-2', 'assistant', 'Two files: a and b.', { message_uid: 'u4' })
  add('seg-2', 'user', 'Delete them', { active: 0, compacted: 0, message_uid: 'u5' })
  add('seg-2', 'assistant', 'Deleted.', { active: 0, compacted: 0, message_uid: 'u6' })
  add('seg-2', 'user', `${J}${JSON.stringify([{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])}`, { message_uid: 'u7' })
  add('seg-2', 'assistant', '', { reasoning: 'It looks like a diagram.', message_uid: 'u8' })
  // Segment 3, after /reset.
  add('seg-3', 'user', 'Fresh start', { message_uid: 'u9' })
  add('seg-3', 'assistant', 'Hello again.', { message_uid: 'u10' })
  add('other', 'user', 'Another chat', { message_uid: 'x1' })

  if (!legacy) {
    db.prepare('INSERT INTO state_meta VALUES (?, ?)').run('gateway.local_policy.v1:local-chat', JSON.stringify({
      session_id: 'local-chat', entry: { session_id: 'seg-3' }, lineage: ['local-chat', 'seg-2', 'seg-3'],
    }))
  }
  db.close()
  return { dir, file, id: 'local-chat', current: 'seg-3' }
}
