import fs from 'node:fs'
import path from 'node:path'

// Invented Cline CLI sessions (the 3.0.74 on-disk layout):
// <data dir>/sessions/<id>/<id>.json and <id>.messages.json. Never reads the
// developer's ~/.cline.
export const CLINE_ID = '1794894104593_rurer'

export const clineUser = (text, mode = 'act') => ({ type: 'text', text: `<user_input mode="${mode}">${text}</user_input>` })
export const clineText = text => ({ type: 'text', text })
export const clineThinking = thinking => ({ type: 'thinking', thinking })
export const clineToolUse = (name, input, id) => ({ type: 'tool_use', id, name, input })
export const clineToolResult = (id, name, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, name, content, ...extra })

export function clineMessage(role, content, ts = Date.parse('2026-01-01T12:00:00Z')) {
  return { id: `msg_${role}_${ts}_${Math.abs(ts % 1000)}`, role, content, ts }
}

// Writes one session (manifest + messages) and returns its messages file.
export function writeClineFixture(home, {
  id = CLINE_ID, dataDir, pid = 4321, startedAt = '2026-01-01T12:00:00.000Z',
  cwd = '/work/acme-shop', workspaceRoot = cwd, model = 'demo/demo-model-1', messages = [],
} = {}) {
  const dir = dataDir || path.join(home, '.cline/data')
  const sessionDir = path.join(dir, 'sessions', id)
  fs.mkdirSync(sessionDir, { recursive: true })
  const file = path.join(sessionDir, `${id}.messages.json`)
  const manifest = path.join(sessionDir, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    updated_at: startedAt,
    agent: 'lead',
    sessionId: id,
    origin: { source: 'cli', mode: 'user', sessionId: id, version: '3.0.74' },
    messages,
    system_prompt: 'Synthetic Cline conversation fixture.',
  }))
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1,
    session_id: id,
    source: 'cli',
    pid,
    started_at: startedAt,
    status: 'completed',
    interactive: true,
    provider: 'demo',
    model,
    cwd,
    workspace_root: workspaceRoot,
    prompt: messages[0] ? messages[0].content[0].text : '',
    metadata: { mode: 'act', title: 'Fixture', usage: { inputTokens: 0, outputTokens: 0 } },
    messages_path: file,
  }))
  return file
}

// An old session folder with no manifest (skipped by the lookup).
export function writeClineOrphan(home, { id = '1794890000000_orphan', dataDir } = {}) {
  const dir = dataDir || path.join(home, '.cline/data')
  const sessionDir = path.join(dir, 'sessions', id)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, `${id}.messages.json`), JSON.stringify({ version: 1, messages: [] }))
  return sessionDir
}
