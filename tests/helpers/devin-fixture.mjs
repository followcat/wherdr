import { execFileSync } from 'node:child_process'
import path from 'node:path'

// Invented SQLite sessions, shared by reader and browser tests. Never opens
// the developer's session database.
export function writeDevinFixture(home, { session = 'devin-test', rows = [], head = rows.at(-1)?.id ?? null, model = 'test-model', states = [] } = {}) {
  const file = path.join(home, '.local/share/devin/cli/sessions.db')
  execFileSync('python3', ['-c', `
import json, pathlib, sqlite3, sys
file = pathlib.Path(sys.argv[1])
file.parent.mkdir(parents=True, exist_ok=True)
data = json.load(sys.stdin)
con = sqlite3.connect(file)
con.execute('PRAGMA journal_mode=WAL')
con.executescript('''
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, main_chain_id INTEGER, model TEXT);
CREATE TABLE IF NOT EXISTS message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, PRIMARY KEY(session_id,node_id));
CREATE TABLE IF NOT EXISTS tool_call_state(session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT, source_node_ids TEXT, PRIMARY KEY(session_id,tool_call_id));
''')
con.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?)', (data['session'],data['head'],data['model']))
for row in data['rows']:
 con.execute('INSERT OR REPLACE INTO message_nodes VALUES(?,?,?,?)', (data['session'],row['id'],row.get('parent'),json.dumps(row['message'])))
for state in data['states']:
 con.execute('INSERT OR REPLACE INTO tool_call_state VALUES(?,?,?,?,?)', (data['session'],state['id'],json.dumps(state.get('call',{})),json.dumps(state.get('update',{})),'[]'))
con.commit()
con.close()
`, file], { input: JSON.stringify({ session, rows, head, model, states }) })
  return file
}

export const devinMessage = (role, content, extra = {}) => ({
  role, content, metadata: { created_at: '2026-01-01T12:00:00Z', ...(role === 'user' ? { is_user_input: true } : {}) }, ...extra,
})
