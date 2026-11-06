// Command Code session lines (one JSONL file per session): a `session`
// header, optional `model_change` lines, then `message` records. Fixture
// shape ported from v2's command-code fixture with neutral values only —
// shared by the parser spec and the later reader specs.
export const AT = 1_700_000_000_000
export const at = (ms: number) => new Date(AT + ms).toISOString()
export const J = (...lines: unknown[]) => lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')

export const sess = (id: string, ms = 0) => ({ type: 'session', version: 3, id, timestamp: at(ms), cwd: '/home/alice/acme-shop' })
export const modelChange = (ms = 0) => ({ type: 'model_change', id: `model-${ms}`, parentId: null, timestamp: at(ms), model: 'example/model-a' })
export const user = (id: string, content: unknown, ms = 0, meta: Record<string, unknown> = {}) =>
  ({ type: 'message', id, parentId: null, timestamp: at(ms), message: { role: 'user', content, meta: { source: 'user', createdAt: AT + ms, ...meta } } })
export const assistant = (id: string, content: unknown, ms = 0) =>
  ({ type: 'message', id, parentId: null, timestamp: at(ms), model: 'example/model-a', message: { role: 'assistant', content, meta: { source: 'model', createdAt: AT + ms } } })
export const results = (id: string, parts: { tool_use_id: string, content: unknown, is_error?: boolean }[], ms = 0) =>
  ({
    type: 'message', id, parentId: null, timestamp: at(ms),
    message: { role: 'user', meta: { source: 'tool', createdAt: AT + ms }, content: parts.map(r => ({ type: 'tool_result', ...r })) },
  })
