// What a permission request allows, to show it above the
// question: the tool, its description, the full command, or the file.
//
// Two sources:
//  - the transcript: the last tool call still without a result is
//    the one waiting for permission (full command, never cut by the
//    terminal width);
//  - the screen, failing that: in Claude Code, the block between the ─── rule and the
//    question; in Codex, the lines between the question and the options:
//
//   ──────────────────────────────            Would you like to run the following command?
//    Bash command                               Reason: needs network access
//      npm test                                 $ npm install
//      Run the unit tests                     › 1. Yes, proceed (y)
//    Do you want to proceed?
//    ❯ 1. Yes
import type { PromptDetail } from '../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const MAX_BODY = 20000
const RULE = /^\s*[─━═]{8,}\s*$/
const DASHED = /^\s*[╌┄┈╍┅┉-]{8,}\s*$/

// Question of a permission request (and not of AskUserQuestion, the folder
// trust screen, a menu…).
export function isPermissionQuestion(q: string | null | undefined): boolean {
  return /\b(?:proceed|allow|approve|make (?:this|these|the following) edits?|want to (?:make|create|run|edit|write|fetch|use|delete)|like to (?:run|make|apply|allow))\b/i.test(String(q || ''))
}

function body(text: string): Pick<PromptDetail, 'command' | 'truncated'> {
  const s = text.replace(/\s+$/, '')
  return s.length > MAX_BODY ? { command: s.slice(0, MAX_BODY), truncated: true } : { command: s }
}

const shortPath = (p: unknown, home: string) => {
  const s = String(p || '')
  return home.length > 1 && (s === home || s.startsWith(home + '/')) ? '~' + s.slice(home.length) : s
}

// Lines removed / added between two texts (multiset count:
// a summary, not a real diff).
export function lineStats(before: string, after: string): { added: number, removed: number } {
  const count = (s: string) => {
    const m = new Map<string, number>()
    if (s) for (const l of s.split('\n')) m.set(l, (m.get(l) || 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  let removed = 0
  let added = 0
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0))
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0))
  return { added, removed }
}

// Common lines at the start and end kept as context, the middle as -/+.
function diffText(before: string, after: string): string {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  return [
    ...a.slice(0, p).map(l => '  ' + l),
    ...a.slice(p, a.length - q).map(l => '- ' + l),
    ...b.slice(p, b.length - q).map(l => '+ ' + l),
    ...a.slice(a.length - q).map(l => '  ' + l),
  ].join('\n')
}

// ------------------------------------------------------------ Claude
export function claudeToolDetail(name: string, input: Json, home = ''): PromptDetail | null {
  const i = input || {}
  switch (name) {
    // Not permissions: the question is on screen, or it comes from a subagent.
    case 'AskUserQuestion': case 'Task': case 'Agent': return null
    case 'Bash': case 'PowerShell':
      return { tool: name, description: i.description || undefined, ...body(String(i.command || '')) }
    case 'Edit': {
      const s = lineStats(String(i.old_string || ''), String(i.new_string || ''))
      return { tool: name, file: shortPath(i.file_path, home), ...s, ...body(diffText(String(i.old_string || ''), String(i.new_string || ''))) }
    }
    case 'MultiEdit': {
      const edits: Json[] = Array.isArray(i.edits) ? i.edits : []
      let added = 0
      let removed = 0
      for (const e of edits) {
        const s = lineStats(String(e.old_string || ''), String(e.new_string || ''))
        added += s.added
        removed += s.removed
      }
      const diff = edits.map(e => diffText(String(e.old_string || ''), String(e.new_string || ''))).join('\n…\n')
      return { tool: name, file: shortPath(i.file_path, home), added, removed, ...body(diff) }
    }
    case 'Write': {
      const content = String(i.content || '')
      return { tool: name, file: shortPath(i.file_path, home), added: content ? content.replace(/\n$/, '').split('\n').length : 0, ...body(content) }
    }
    case 'NotebookEdit':
      return { tool: name, file: shortPath(i.notebook_path, home), ...body(String(i.new_source || '')) }
    case 'Read':
      return { tool: name, file: shortPath(i.file_path, home) }
    case 'WebFetch':
      return { tool: name, description: i.prompt || undefined, ...body(String(i.url || '')) }
    case 'WebSearch':
      return { tool: name, ...body(String(i.query || '')) }
    case 'ExitPlanMode':
      return { tool: name, ...body(String(i.plan || '')) }
    default: {
      // MCP tool (mcp__server__tool) or other: its input as readable JSON.
      const m = name.match(/^mcp__(.+?)__(.+)$/)
      const json = Object.keys(i).length ? JSON.stringify(i, null, 2) : ''
      return { tool: m ? `${m[1]} · ${m[2]}` : name, ...(json ? body(json) : {}) }
    }
  }
}

// First tool call without a result since the user's last
// message (JSON lines of a Claude Code transcript).
export function pendingClaudeTool(lines: string[], home = ''): PromptDetail | null {
  const pending = new Map<string, { name: string, input: Json }>()
  for (const line of lines) {
    if (!line || !line.includes('"type"')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    if (d.isSidechain) continue
    const content = d.message && d.message.content
    if (d.type === 'user') {
      if (typeof content === 'string') { pending.clear(); continue }
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part.type === 'tool_result') pending.delete(part.tool_use_id)
        else if (part.type === 'text' && !d.isMeta) pending.clear()
      }
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) if (part.type === 'tool_use' && part.id) pending.set(part.id, { name: part.name, input: part.input })
    }
  }
  const first = pending.values().next().value
  return first ? claudeToolDetail(String(first.name || ''), first.input, home) : null
}

// ------------------------------------------------------------ omp
// The call waiting for approval: started (tool_execution_start) with no
// result yet. Its full input comes from the assistant message's toolCall
// (omp cuts it on screen, and a long one scrolls the dialog's title away).
// `tool`: name read in the dialog's title, when shown (calls run in parallel).
export function pendingOmpTool(lines: string[], tool?: string | null): PromptDetail | null {
  const calls = new Map<string, { name: string, args: Json, intent?: string }>()
  const started: string[] = []
  for (const line of lines) {
    if (!line || !line.includes('"type"')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    const m = d.type === 'message' && d.message
    if (m && m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === 'toolCall' && part.id) calls.set(part.id, { name: String(part.name || ''), args: part.arguments, intent: part.intent })
    } else if (m && m.role === 'toolResult' && m.toolCallId) {
      const i = started.indexOf(m.toolCallId)
      if (i >= 0) started.splice(i, 1)
    } else if (m && m.role === 'user') started.length = 0
    else if (d.type === 'custom' && d.customType === 'tool_execution_start' && d.data && d.data.toolCallId) {
      started.push(d.data.toolCallId)
      if (!calls.has(d.data.toolCallId)) calls.set(d.data.toolCallId, { name: String(d.data.toolName || ''), args: d.data.args, intent: d.data.intent })
    }
  }
  const ids = started.filter(id => calls.has(id) && (!tool || calls.get(id)!.name === tool))
  const call = ids.length ? calls.get(ids[ids.length - 1]!)! : null
  if (!call) return null
  const { i: _, ...args } = call.args && typeof call.args === 'object' ? call.args : {} as Json
  const text = typeof args.command === 'string' ? args.command
    : typeof args.code === 'string' ? args.code
      : Object.keys(args).length ? JSON.stringify(args, null, 2) : ''
  return { tool: call.name || 'tool', ...(call.intent ? { description: String(call.intent) } : {}), ...(text ? body(text) : {}) }
}

// ------------------------------------------------------------ Codex
// `["bash", "-lc", "script"]` → the script; otherwise the arguments joined.
function shellText(cmd: unknown): string {
  if (Array.isArray(cmd)) {
    const a = cmd.map(String)
    if (a.length === 3 && /(?:^|\/)(?:ba|z|)sh$/.test(a[0]!) && /^-l?c$/.test(a[1]!)) return a[2]!
    return a.join(' ')
  }
  return String(cmd || '')
}

export function codexPatchDetail(patch: string): PromptDetail {
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1]!.trim())
  let added = 0
  let removed = 0
  for (const l of patch.split('\n')) {
    if (/^\+(?!\+\+)/.test(l)) added++
    else if (/^-(?!--)/.test(l)) removed++
  }
  return { tool: 'apply_patch', file: files.join(', ') || undefined, added, removed, ...body(patch) }
}

export function pendingCodexTool(lines: string[]): PromptDetail | null {
  const pending = new Map<string, Json>()
  for (const line of lines) {
    if (!line || !line.includes('response_item')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    const p = d.type === 'response_item' && d.payload
    if (!p) continue
    if (p.type === 'message' && p.role === 'user') pending.clear()
    else if ((p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') && p.call_id) pending.set(p.call_id, p)
    else if (/_output$/.test(p.type || '') && p.call_id) pending.delete(p.call_id)
  }
  const p = pending.values().next().value
  if (!p) return null
  if (p.type === 'custom_tool_call') {
    const input = String(p.input || '')
    if (p.name === 'apply_patch' || input.includes('*** Begin Patch')) return codexPatchDetail(input)
    return { tool: p.name || 'tool', ...body(input) }
  }
  let a: Json = {}
  if (p.arguments) {
    try { a = JSON.parse(p.arguments) }
    catch { return { tool: p.name || 'shell', ...body(String(p.arguments)) } }
  } else if (p.action) a = { command: p.action.command, workdir: p.action.working_directory }
  const cmd = shellText(a.cmd ?? a.command)
  if (!cmd) return { tool: p.name || 'tool', ...body(JSON.stringify(a, null, 2)) }
  return { tool: p.name || 'shell', description: a.justification || undefined, ...body(cmd) }
}

// ------------------------------------------------------------ screen
function dedent(lines: string[]): string[] {
  const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length))
  return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0).replace(/\s+$/, ''))
}
function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a]!.trim()) a++
  while (b > a && !lines[b - 1]!.trim()) b--
  return lines.slice(a, b)
}
// A sentence (the description) rather than a command line.
const prose = (l: string) => /^[A-Z][^$|&;<>`=\\{}[\]]*$/.test(l.trim()) && /\s/.test(l.trim())

// Codex: "Reason: …" and "$ command" between the question and the options.
function codexScreen(between: string[]): PromptDetail | null {
  const lines = trimBlank(dedent(between))
  let description: string | undefined
  const cmd: string[] = []
  let inCmd = false
  for (const l of lines) {
    const r = l.match(/^Reason:\s*(.*)$/)
    if (r) { description = r[1]!; inCmd = false; continue }
    const c = l.match(/^\$\s(.*)$/)
    if (c) { cmd.push(c[1]!); inCmd = true; continue }
    if (inCmd && l.trim()) cmd.push(l)
    else inCmd = false
  }
  if (!cmd.length && !description) return null
  return { tool: 'shell', description, ...(cmd.length ? body(cmd.join('\n')) : {}) }
}

// Claude : bloc entre le dernier trait plein au-dessus de la question et elle.
function claudeScreen(lines: string[], q: number): PromptDetail | null {
  let b = -1
  for (let i = q - 1; i >= Math.max(0, q - 40); i--) if (RULE.test(lines[i]!)) { b = i; break }
  if (b < 0) return null
  const block = trimBlank(dedent(lines.slice(b + 1, q)))
  if (block.length < 2) return null
  const title = block[0]!.trim()
  if (title.length > 60) return null
  const rest = trimBlank(block.slice(1))
  if (rest.some(l => DASHED.test(l)) || /\bfile\b/i.test(title)) {
    // File: path then diff excerpt (line numbers, +/-).
    const content = rest.filter(l => !DASHED.test(l))
    const fi = content.findIndex(l => l.trim() && !/\s{2}/.test(l.trim()) && !/^\s*\d+\s/.test(l))
    const file = fi >= 0 ? content[fi]!.trim() : undefined
    const diff = trimBlank(dedent(content.filter((_, i) => i !== fi)))
    const added = diff.filter(l => /^\s*\d+\s*\+/.test(l)).length
    const removed = diff.filter(l => /^\s*\d+\s*-/.test(l)).length
    return { tool: title, file, ...(added || removed ? { added, removed } : {}), ...(diff.length ? body(diff.join('\n')) : {}) }
  }
  // Command: first paragraph (command, then its description if there is one).
  const blank = rest.findIndex(l => !l.trim())
  const first = trimBlank(dedent(blank < 0 ? rest : rest.slice(0, blank)))
  if (!first.length) return { tool: title }
  let description: string | undefined
  if (first.length >= 2 && prose(first[first.length - 1]!)) description = first.pop()!.trim()
  return { tool: title, description, ...body(first.join('\n')) }
}

// `q`: question line, `top`: first option (screen already rid
// of any neighbouring panel).
export function screenDetail(lines: string[], q: number, top: number): PromptDetail | null {
  if (q < 0) return null
  return codexScreen(lines.slice(q + 1, top)) || claudeScreen(lines, q)
}
