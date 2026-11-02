// Invented Command Code session lines. The real CLI writes one JSONL file per
// session under ~/.commandcode/projects/<project-slug>/<session-id>.jsonl:
// a `session` header, optional `model_change` lines, then `message` lines.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const at = (ms) => new Date(1_700_000_000_000 + ms).toISOString()
const created = (ms) => 1_700_000_000_000 + ms

export const commandCodePNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='

export function commandCodeSession(id, cwd, ms = 0) {
  return { type: 'session', version: 3, id, timestamp: at(ms), cwd }
}

export function commandCodeModel(model, ms = 0) {
  return { type: 'model_change', id: `model-${ms}`, parentId: null, timestamp: at(ms), model }
}

export function commandCodeUser(id, parentId, text, ms = 0) {
  return {
    type: 'message', id, parentId, timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'text', text }], meta: { source: 'user', createdAt: created(ms) } },
  }
}

export function commandCodeAssistant(id, parentId, content, { model = 'example/model-a', ms = 0, usage } = {}) {
  return {
    type: 'message', id, parentId, timestamp: at(ms), model,
    ...(usage ? { usage } : {}),
    message: { role: 'assistant', content, meta: { source: 'model', createdAt: created(ms) } },
  }
}

// `results`: [{ tool_use_id, content: part[], is_error? }] — a user turn whose
// meta.source is "tool", as the CLI writes tool results.
export function commandCodeToolResults(id, parentId, results, ms = 0) {
  return {
    type: 'message', id, parentId, timestamp: at(ms),
    message: {
      role: 'user',
      meta: { source: 'tool', createdAt: created(ms) },
      content: results.map(r => ({ type: 'tool_result', ...r })),
    },
  }
}

export function writeCommandCodeSession(home, { id, cwd, slug = 'home-user-acme-shop', lines, mtime = null }) {
  const dir = path.join(home, '.commandcode/projects', slug)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  if (mtime !== null) utimesSync(file, mtime, mtime)
  return file
}
