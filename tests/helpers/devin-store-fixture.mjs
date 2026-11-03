import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Invented sessions.db stores, shared by the store-reader tests. Never opens
// the developer's own Devin CLI files. The schema is the one Devin CLI
// 3000.11.234 really writes (its version lives in refinery_schema_history and
// guards the reader); the rows are invented.
const BUILD = String.raw`
import json, os, sqlite3, sys

file, request = sys.argv[1], json.loads(sys.argv[2])
os.makedirs(os.path.dirname(file), exist_ok=True)
con = sqlite3.connect(file)
con.execute('PRAGMA journal_mode=WAL')
con.executescript('''
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE IF NOT EXISTS message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id));
CREATE TABLE IF NOT EXISTS tool_call_state (
    session_id    TEXT    NOT NULL,
    tool_call_id  TEXT    NOT NULL,
    tool_call_json     TEXT,
    tool_call_update_json TEXT, source_node_ids TEXT,
    PRIMARY KEY (session_id, tool_call_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id));
CREATE TABLE IF NOT EXISTS refinery_schema_history(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));
CREATE INDEX IF NOT EXISTS idx_message_nodes_session ON message_nodes(session_id);
''')
version = request.get('schemaVersion')
if version is not None:
    con.execute('DELETE FROM refinery_schema_history')
    con.execute('INSERT INTO refinery_schema_history(version,name,applied_on,checksum) VALUES (?,?,?,?)',
                (version, 'schema-v%d' % version, '2026-01-01', 'fixture'))
sid = request['session']
rows = request.get('rows') or []
head = request.get('head')
if head is None and rows:
    head = rows[-1].get('id')
con.execute('INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id) VALUES (?,?,?,?,?,?,?,?,?) '
            'ON CONFLICT(id) DO UPDATE SET model=excluded.model, main_chain_id=excluded.main_chain_id',
            (sid, '/home/user/acme-shop', 'cli', request.get('model') or 'test-model', 'default',
             1700000000, 1700000000, 'Fixture session', head))
for r in rows:
    meta = r.get('meta')
    con.execute('INSERT OR IGNORE INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES (?,?,?,?,?,?)',
                (sid, r['id'], r.get('parent'), json.dumps(r['message']),
                 r.get('created') if r.get('created') is not None else 1700000000 + r['id'],
                 json.dumps(meta) if meta is not None else None))
con.commit()
con.close()
`

export function devinStorePath(home, cliDir) {
  return path.join(cliDir || path.join(home, '.local/share/devin/cli'), 'sessions.db')
}

// Writes (or appends to) <home>/.local/share/devin/cli/sessions.db. Rows keep
// their node ids between calls: a later call can append nodes, graft a
// compaction (rows with meta.summarized_from) or rewind main_chain_id.
export function writeDevinStore(home, { session = 'devin-test', rows = [], head, model = 'test-model', schemaVersion = 20, cliDir } = {}) {
  const file = devinStorePath(home, cliDir)
  const r = spawnSync('python3', ['-X', 'utf8', '-c', BUILD, file, JSON.stringify({ session, rows, head, model, schemaVersion })], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`devin-store fixture failed: ${r.stderr || r.stdout}`)
  return file
}
