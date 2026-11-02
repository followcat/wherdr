import fs from 'node:fs'
import path from 'node:path'

// Invented ATIF transcripts, shared by reader and browser tests. Never opens
// the developer's Devin CLI files. Incremental writes keep the node graph in
// `extra.wherdr_fixture` so a later append or rewind can rebuild the main chain.
const FIXTURE_KEY = 'wherdr_fixture'

function loadStore(file, session, model, head) {
  if (!fs.existsSync(file)) return { session, model, head, nodes: {} }
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (prev?.extra?.[FIXTURE_KEY]) return prev.extra[FIXTURE_KEY]
  } catch { /* replace a broken fixture */ }
  return { session, model, head, nodes: {} }
}

function chainOf(store) {
  const chain = []
  const seen = new Set()
  let node = store.head
  while (node != null && store.nodes[node] && !seen.has(node)) {
    seen.add(node)
    chain.push(store.nodes[node])
    node = store.nodes[node].parent
  }
  chain.reverse()
  return chain
}

function toStep(row, model) {
  const m = row.message || {}
  const thinking = typeof m.thinking === 'string' ? m.thinking : m.thinking?.thinking
  return {
    step_id: row.id + 1,
    source: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent',
    message: m.content,
    ...(thinking ? { reasoning_content: thinking } : {}),
    ...(Array.isArray(m.tool_calls) ? {
      tool_calls: m.tool_calls.map(call => ({
        tool_call_id: call.id,
        function_name: call.name,
        arguments: call.arguments || {},
      })),
    } : {}),
    metadata: {
      created_at: m.metadata?.created_at,
      is_user_input: m.metadata?.is_user_input === true,
      ...(m.role === 'assistant' && model ? { generation_model: model } : {}),
      ...(m.metadata?.extensions ? { extensions: m.metadata.extensions } : {}),
    },
  }
}

function mergeTool(steps, row) {
  const m = row.message || {}
  const result = {
    source_call_id: m.tool_call_id,
    content: m.content,
    extra: m.metadata?.extensions || m.extra,
  }
  const prev = [...steps].reverse().find(step => (step.tool_calls || []).some(call => call.tool_call_id === m.tool_call_id))
  if (prev) {
    prev.observation ||= { results: [] }
    prev.observation.results.push(result)
    return
  }
  steps.push({
    step_id: row.id + 1,
    source: 'tool',
    observation: { results: [result] },
    metadata: { created_at: m.metadata?.created_at },
  })
}

export function writeDevinFixture(home, { session = 'devin-test', rows = [], head = rows.at(-1)?.id ?? null, model = 'test-model', states: _states = [] } = {}) {
  const dir = path.join(home, '.local/share/devin/cli/transcripts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${session}.json`)
  const store = loadStore(file, session, model, head)
  store.session = session
  store.model = model
  if (head !== undefined) store.head = head
  else if (rows.length) store.head = rows.at(-1).id
  for (const row of rows) store.nodes[row.id] = { id: row.id, parent: row.parent ?? null, message: row.message }
  const steps = []
  for (const row of chainOf(store)) {
    if (row.message?.role === 'tool') mergeTool(steps, row)
    else steps.push(toStep(row, store.model))
  }
  const doc = {
    schema_version: 'ATIF-v1.7',
    session_id: session,
    agent: { name: 'devin', model_name: store.model },
    steps,
    notes: 'Synthetic ATIF-v1.7 fixture. Real Devin CLI 3000.11.234 writes this schema at ~/.local/share/devin/cli/transcripts/<session-id>.json.',
    extra: { [FIXTURE_KEY]: store },
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc))
  fs.renameSync(tmp, file)
  return file
}

export const devinMessage = (role, content, extra = {}) => ({
  role, content, metadata: { created_at: '2026-01-01T12:00:00Z', ...(role === 'user' ? { is_user_input: true } : {}) }, ...extra,
})
