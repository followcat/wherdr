// Command Code session lines (one JSONL file per session): a `session`
// header, optional `model_change` lines, then `message` records.
//
// The JSONL format (`version: 3`) is the one Command Code `1.93.0` writes.
// Fixture shape ported from v2's command-code fixture with neutral values
// only — shared by the parser spec and the later reader specs.
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

// An anonymised real transcript from Command Code `1.93.0` (format
// `version: 3`): the exact record structure the app writes, five lines as
// they appear in the file, with neutral values only (`alice`,
// `/home/alice/acme-shop`). A pinned sample: if the parser stops reading a
// real 1.93.0 session, this test says so.
export const REAL_SAMPLE: string[] = [
  '{"type":"session","version":3,"id":"11111111-2222-4333-8444-555555555555","cwd":"/home/alice/acme-shop","timestamp":"2026-11-20T10:00:00.000Z"}',
  '{"type":"message","id":"msg-u1","parentId":null,"timestamp":"2026-11-20T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Check package.json scripts"}],"meta":{"createdAt":1795168801000,"messageId":"m-u1","source":"user"}}}',
  '{"type":"message","id":"msg-a1","parentId":"msg-u1","timestamp":"2026-11-20T10:00:03.000Z","model":"deepseek/deepseek-v4.1-flash","effort":"high","usage":{"inputTokens":420,"outputTokens":85,"cacheReadTokens":300,"cacheWriteTokens":120,"costUsd":0.0004},"message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me inspect package.json first.","signature":"sig-opaque-1"},{"type":"text","text":"Reading package.json."},{"type":"tool_use","id":"call_read_1","name":"read_file","input":{"file_path":"/home/alice/acme-shop/package.json"}}],"meta":{"createdAt":1795168803000,"messageId":"m-a1","source":"model"}}}',
  '{"type":"message","id":"msg-t1","parentId":"msg-a1","timestamp":"2026-11-20T10:00:04.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_read_1","content":[{"type":"text","text":"{\\"scripts\\":{\\"test\\":\\"vitest\\"}}"}]}],"meta":{"messageId":"m-t1","source":"tool"}}}',
  '{"type":"message","id":"msg-a2","parentId":"msg-t1","timestamp":"2026-11-20T10:00:06.000Z","model":"deepseek/deepseek-v4.1-flash","effort":"high","usage":{"inputTokens":510,"outputTokens":40,"cacheReadTokens":420,"cacheWriteTokens":0,"costUsd":0.0002},"message":{"role":"assistant","content":[{"type":"text","text":"The test script runs vitest."}],"meta":{"createdAt":1795168806000,"messageId":"m-a2","source":"model"}}}',
]
