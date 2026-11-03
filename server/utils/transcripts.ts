import { createHash } from 'node:crypto'
import path from 'node:path'
import { imageTagCount } from '../../shared/queuedMatch'
import type { ChatItem, ChatResponse, ClaudeQueueEntry, CommandCodeStatus, CommandCodeToolUpdate, ModelInfo, PromptDetail } from '../../shared/types'
import { ompToolCall, ompToolResult, ompUserRun } from './ompTools'
import { pendingClaudeTool, pendingCodexTool, pendingOmpTool } from './promptDetail'
import { type ClaudeAsked, type OmpAsked, pendingClaudeAsk, pendingOmpAsk } from './choices'
import { cleanModelName, lastModel, mergeOmpModel, ompLastModel, ompModelComplete, ompModelLabel, ompModelResult } from './models'
import { type MachineFs, type ShellExec, chunksByBytes, localFs } from './fsx'
import { createDevinTranscripts } from './devinTranscripts'
import { createOpenCodeTranscripts, type OpenCodeOptions } from './opencodeTranscripts'
import type { ChildProcessWithoutNullStreams } from 'node:child_process' 
import { searchFile } from './conversationSearch'
import { hasTranscript, transcriptKind } from '../../shared/agentKind'
import { type CommandTemplate, ompCommandTemplates } from './slash'
import { fmt } from '../../shared/message'
import { pastedBlocks } from '../../shared/pastedText'
import { createActivity } from '../../shared/integrations'

// Backward reading by windows until there are enough messages: Claude's
// transcripts embed images in base64, a few screenshots
// weigh several MB for three lines of conversation.
const WINDOW_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 24 * 1024 * 1024 // per request
const PAGE_ITEMS = 120
const MAX_TEXT = 20000

export interface TranscriptPane {
  id: string
  agent: string | null
  cwd: string | null
  agentSession?: string | null
  bornAt?: number
  status?: string | null
}

interface Loc { file: string, session: string, guessed?: boolean }
interface CodexRollout { file: string, id: string, ts: number, mtimeMs: number }
// Window in which a Codex's conversation is created around its appearance.
const CODEX_BIRTH_BEFORE = 5000
const CODEX_BIRTH_AFTER = 120000
type Lines = string[] & { refs?: string[], raw?: string[] }
type Parsed = ChatItem[] & { queue?: ClaudeQueueEntry[], popped?: ClaudeQueueEntry[], updates?: CommandCodeToolUpdate[] }
// `anchor`: fingerprint of the bytes just above `start` (see anchorAt).
interface TailResult { start: number, items: ChatItem[], queue: ClaudeQueueEntry[], popped?: ClaudeQueueEntry[], updates?: CommandCodeToolUpdate[], anchor?: string }

// Join check of a re-read from a cursor: the bytes just above it, hashed. A
// transcript rewritten at the same size, or shortened but still longer than
// the cursor, keeps the token's size and may keep a line start at the cursor,
// so the client would splice a new bottom under pages of another file. The
// token carries the anchor of its start (`/<start>.<hash>`) and a re-read from
// that start checks it first.
const ANCHOR_BYTES = 4096
// A watched tool result is fingerprinted on this many leading bytes: enough
// to notice a rewrite without transferring a huge output again on each poll.
const WATCH_BYTES = 64 * 1024
const anchorHash = (b: Uint8Array) => createHash('sha1').update(b).digest('hex').slice(0, 12)
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/
// Anchor of a token as the client sent it (other suffixes allowed after it).
export function anchorOf(token: string | null | undefined): { start: number, hash: string } | null {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}
// File generation for the token: another inode or another modification time
// is another state, even at the same size.
// Modification time in microseconds.
const genOf = (st: { mtimeMs: number, ino?: number }) => `${st.ino ? `${st.ino}-` : ''}${Math.round(st.mtimeMs * 1000)}`
// State a client's token was read from: file, size, cursor, inode, mtime
// (`!`: read before its mtime second was over, see SETTLE_MS).
const HEAD = /^(.*):(\d+):(null|\d+):(?:(\d+)-)?(\d+)(!?)(?=[@/%~#]|$)/
// Command Code invalidation generation carried by a token (`@N`, before the
// anchor): a client whose generation is behind rebuilds the older pages it
// kept. `~` stays the taken-back marker of server/api/chat.get.ts.
const EPOCH = /@(\d+)(?=[/%~#]|$)/
export function cmdEpochOf(token: string | null | undefined): number | null {
  const m = EPOCH.exec(String(token || ''))
  return m ? Number(m[1]) : null
}
// A restart drops the reader's remembered cross-page results: the instance
// nonce makes an old token reload the pages instead of showing a tool without
// its output.
const READER = /%([a-z0-9]+)(?=[/~#]|$)/
export function cmdReaderOf(token: string | null | undefined): string | null {
  const m = READER.exec(String(token || ''))
  return m ? m[1]! : null
}
export function headOf(token: string | null | undefined): { file: string, size: number, from: number | null, ino: number | null, gen: string, unsettled: boolean } | null {
  const m = HEAD.exec(String(token || ''))
  if (!m) return null
  return { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), ino: m[4] ? Number(m[4]) : null, gen: `${m[4] ? `${m[4]}-` : ''}${m[5]}`, unsettled: m[6] === '!' }
}
// A stat that gives whole seconds only (a remote `stat` without fractions, a
// coarse file system): a rewrite at the same size within the second already
// read keeps the same generation. Such a state is only trusted ("unchanged",
// parse cache) once read this long after it was first seen: any write of
// that second happened before first sight + 1 s. Until then its token is
// marked `!`, and the checksum of the file taken at first sight tells whether
// what the client read is still there (see chat).
const SETTLE_MS = 1500
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HerdrCall = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + '…' : s)
// Keep notification identities server-side. Absolute line offsets survive a
// moving tail window; lengths and text can change while a reply streams.
const replyKeys = new WeakMap<ChatItem, string>()
function replyItem(item: ChatItem, ref: string | undefined, block = 0): ChatItem {
  if (ref) replyKeys.set(item, `${item.ts || ''}:${ref.split(':')[0]}:${block}`)
  return item
}
const firstLine = (s: unknown) => String(s || '').split('\n').find(l => l.trim()) || ''

// "Technical" messages injected into the thread (system reminders, outputs of
// local commands…): not real user messages.
const isNoise = (t: string) => /^\s*<(?!command-name)[a-z_-]+[\s>]/i.test(t) || /^\s*Caveat:/.test(t)
// "[Image #1]" (Claude Code), "[Image #1, 756x477]" (omp).
const stripImageTags = (t: unknown) => String(t || '').replace(/\[Image #\d+(?:, \d+x\d+)?\]\s*/g, '').trim()
// Pasted text (a multi-line send from wherdr is one): Claude Code
// wraps it in <pasted_content id="…">…</pasted_content id="…">. It is a
// real user message: we keep the text, without the tags; the long blocks
// pasted next to typed words are also listed (`pasted`) to be shown as cards.
const PASTED = /<pasted_content(?:\s[^>]*)?>\n?|\n?<\/pasted_content(?:\s[^>]*)?>/g
export const unwrapPasted = (t: string) => (t.includes('<pasted_content') ? t.replace(PASTED, '').trim() : t)
// Prompt of a scheduled task (CronCreate, /loop…) wrapped by Claude Code.
const SCHEDULED = /^\s*<scheduled-task(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/scheduled-task>\s*$/
const scheduledText = (t: unknown) => (String(t || '').match(SCHEDULED) || [])[1]?.trim() || null
// A message written by the user (after removing the paste wrappers).
function humanText(t: unknown): string | null {
  const s = String(t || '')
  const u = unwrapPasted(s)
  if (u !== s) return u
  return isNoise(s) ? null : s
}
// `pasted` of a user item: the long pasted blocks of its text parts (each
// part on its own: several messages may be grouped), clipped like the text.
const pastedOf = (...parts: string[]) => {
  const b = parts.flatMap(pastedBlocks).map(s => clip(s))
  return b.length ? { pasted: b } : {}
}
// Same message? (spaces, case and images ignored; Claude may group
// several into one turn, hence inclusion rather than equality).
const normMsg = (t: string) => stripImageTags(t).replace(/\s+/g, ' ').trim().toLowerCase()
export function sameMsg(queued: string, said: string): boolean {
  const q = normMsg(queued).slice(0, 60)
  return Boolean(q) && normMsg(said).includes(q)
}

// Base64 images (Claude: source.data, Codex: data:image/…): we
// empty them before JSON.parse, only their count matters to us.
export const stripBlobs = (line: string) => (line.length > 50000
  ? line.replace(/"data":"[A-Za-z0-9+/=]{500,}"/g, '"data":""').replace(/"data:image\/[^"]{500,}"/g, '""')
  : line)

export function toolSummary(name: string, input: Json, home = ''): string {
  const i = input || {}
  const shortPath = (p: unknown) => (home ? String(p || '').replace(home, '~') : String(p || ''))
  switch (name) {
    case 'Bash': return i.description || firstLine(i.command)
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return shortPath(i.file_path || i.notebook_path)
    case 'Grep': return `${i.pattern || ''}${i.path ? ' · ' + shortPath(i.path) : ''}`
    case 'Glob': return i.pattern || ''
    case 'WebFetch': return i.url || ''
    case 'WebSearch': return i.query || ''
    case 'Task': case 'Agent': return i.description || firstLine(i.prompt)
    case 'TodoWrite': return fmt('{count} tasks', { count: (i.todos || []).length })
    case 'AskUserQuestion': return firstLine((i.questions && i.questions[0] && i.questions[0].question) || '')
    default: {
      const v = Object.values(i).find(x => typeof x === 'string')
      return firstLine(v || '')
    }
  }
}

// The /model and /effort menus may be opened then cancelled to read their
// content. We only show confirmations of a real change, as a
// system line. "Kept model as …" and "Cancelled" stay invisible.
const isPickerCmd = (name: string) => /^\/(?:model|effort)$/.test(name.trim())
// /clear, /new, /reset: "Conversation cleared" separator, without output (what
// Claude Code writes afterwards is not an output of the command, often a status
// like "Update installed"). /compact keeps its line (its instructions), without
// output either: its separator comes from compact_boundary.
const isResetCmd = (name: string) => /^\/(?:clear|new|reset)$/.test(name.trim())
function modelChange(text: unknown): string | null {
  const m = String(text || '').match(/<local-command-stdout>\s*Set model to\s+`([^`]+)`/)
  return m ? `/model → ${cleanModelName(m[1]!)}` : null
}
function effortChange(text: unknown): string | null {
  const m = String(text || '').match(/<local-command-stdout>\s*(Set effort level to (low|medium|high|xhigh|max|ultracode)\b[\s\S]*?)<\/local-command-stdout>/i)
  if (!m) return null
  return /\((?:for )?this session only\)/i.test(m[1]!)
    ? `Effort : ${m[2]!.toLowerCase()} (cette session)`
    : m[1]!.trim()
}

// "!" commands (Claude Code bash mode): <bash-input>cmd</bash-input>,
// then a <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr> message.
// Outputs of local commands: <local-command-stdout|stderr>.
const MAX_OUT = 8000
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const tagText = (s: string, tag: string) => {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1]! : null
}
const cleanOut = (s: string | null) => clip(String(s || '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, ''), MAX_OUT)
export function bashInput(text: string): string | null {
  const m = String(text || '').match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/)
  return m ? m[1]!.trim() : null
}
export function commandOutput(text: string): { out: string, err: string } | null {
  const s = String(text || '')
  if (!/^\s*<(?:bash-std(?:out|err)|local-command-std(?:out|err))>/.test(s)) return null
  const out = tagText(s, 'bash-stdout') ?? tagText(s, 'local-command-stdout')
  const err = tagText(s, 'bash-stderr') ?? tagText(s, 'local-command-stderr')
  return { out: cleanOut(out), err: cleanOut(err) }
}

// Output of a local command reduced to one useful line: never the screen
// text that Claude Code sometimes copies there (spinner, "Running N shell
// command…", tips, update statuses).
const SCREEN_JUNK = /^(?:[*✢✳✶✻✽·⏺●◯○]\s*\S+…|Running \d+ (?:shell )?commands?…?|Tip:|Context Usage$|\(no content\)$|✔?\s*Update installed|Restart to update|.*\besc to interrupt\b|.*\bctrl\+\w+ to\b|⎿)/i
export function usefulOutput(out: string | undefined, err: string | undefined): string | null {
  for (const raw of `${err || ''}\n${out || ''}`.split('\n')) {
    const l = raw.replace(/^[\s⎿]+/, '').trim()
    if (l && !SCREEN_JUNK.test(l)) return clip(l, 160)
  }
  return null
}

// Text Claude Code shows with ● in the terminal. Recent models (Claude
// Code 2.1.28x) also write the short narration between tool calls as a
// signed `thinking` block (after an empty one) rather than a `text` block;
// the terminal displays it like a reply, so the conversation does too.
function assistantText(part: Json): string | null {
  const t = part && (part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : null)
  return typeof t === 'string' && t.trim() ? t : null
}

export function parseClaude(lines: Lines, home = ''): Parsed {
  const items: Parsed = []
  const tools = new Map<string, ChatItem>()
  // Claude's own queue (messages typed while it works,
  // from the phone or the computer): enqueue, then dequeue (taken at the end of
  // the turn) or remove "absorbed_mid_turn" (taken during the turn).
  const queue: ClaudeQueueEntry[] = []
  // Entries pulled back out of the queue into the input field (`popAll`: ↑ in
  // the terminal, or wherdr's Cancel) and not queued again since: unless
  // they are submitted again, Claude will not read them (see checkSent).
  const popped: ClaudeQueueEntry[] = []
  let started: ClaudeQueueEntry | null = null
  // A user message appears: it leaves the queue, even without
  // dequeue; otherwise, the head of the queue may be this message, modified.
  // Photos alone have no text: the oldest photos-only entry leaves the queue
  // when a message with images and no text appears.
  const said = (text: string, ts: string | null, images = 0) => {
    const before = queue.length
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]!
      if ((!q.ts || !ts || q.ts <= ts) && sameMsg(q.text, text)) queue.splice(i, 1)
    }
    if (images && !stripImageTags(text)) {
      const i = queue.findIndex(q => !q.text && (q.images || 0) > 0 && (!q.ts || !ts || q.ts <= ts))
      if (i >= 0) queue.splice(i, 1)
    }
    const head = queue.find(q => !isNoise(q.text))
    if (queue.length === before && head && (!head.ts || !ts || head.ts <= ts)) started = head
  }
  // Prompt injected by Claude Code itself (scheduled task, task notification…):
  // it leaves the queue, never typed by the user. Scheduled ones are shown
  // where they ran, as a note, not as a user message.
  let fire: string | null = null
  const injected = (text: string, ts: string | null, scheduled: boolean) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]!
      if ((!q.ts || !ts || q.ts <= ts) && (sameMsg(q.text, text) || sameMsg(scheduledText(q.text) || '', text))) queue.splice(i, 1)
    }
    if (scheduled && text.trim()) items.push({ role: 'notice', name: 'scheduled', text: clip(text.trim()), ts })
    fire = null
    pendingCmd = null
  }
  // Command ("!" or "/") waiting for its output: the next message.
  let open: ChatItem | null = null
  // "/" command followed by an agent reply (skill, custom command,
  // /review…): it is a user message, not a command block.
  let pendingCmd: ChatItem | null = null
  const pushCmd = (it: ChatItem) => {
    if (/^\/compact\b/.test(it.text)) it.out = ''
    items.push(it)
    open = it
    pendingCmd = it.role === 'cmd' ? it : null
  }
  // Output of the command just before; elsewhere (/model, /effort menus…) ignored.
  const output = (text: string) => {
    const o = commandOutput(text)
    if (!o) return false
    if (open && !open.text) {
      open = null
      return true
    }
    if (open && items[items.length - 1] === open && open.out === undefined) {
      open.out = o.out
      open.err = o.err
    }
    open = null
    return true
  }
  // /clear…: separator, and the following output is swallowed (item without rendering).
  const swallow = (ts: string | null) => {
    items.push({ role: 'system', text: 'Conversation cleared', ts })
    pendingCmd = null
    open = { role: 'system', text: '', ts }
  }
  // "Special" text message (command, output): handled here.
  const special = (text: string, ts: string | null) => {
    const bash = bashInput(text)
    if (bash !== null) {
      pushCmd({ role: 'bash', text: clip(bash, 2000), ts })
      said(bash, ts)
      return true
    }
    return output(text)
  }
  // Last user message typed by the user, with its place in the message tree.
  // Stop before any reply puts the prompt back into Claude's field: the next
  // message is then written as its sibling (same parent), and the cancelled
  // one drops out of the conversation, as in Claude (see interruptRestore.ts).
  let lastSaid = null as { item: ChatItem, parent: string, uuid: string } | null
  const noteSaid = (d: Json) => {
    const item = items[items.length - 1]
    lastSaid = item && item.role === 'user' && d.parentUuid ? { item, parent: d.parentUuid, uuid: d.uuid } : null
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const ref = lines.refs ? lines.refs[li] : undefined
    if (!line) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    if (lastSaid && d.type === 'user' && !d.isSidechain && d.parentUuid === lastSaid.parent && d.uuid !== lastSaid.uuid) {
      const i = items.indexOf(lastSaid.item)
      if (i >= 0 && !items.slice(i + 1).some(x => x.role === 'assistant' || x.role === 'tool')) items.splice(i, 1)
      lastSaid = null
    }
    if (d.type === 'queue-operation') {
      const raw = unwrapPasted(String(d.content || ''))
      const text = stripImageTags(raw)
      const images = imageTagCount(raw)
      if (d.operation === 'enqueue') {
        queue.push({ text, ts: d.timestamp || null, ...(images ? { images } : {}) })
        const p = popped.findIndex(q => q.text === text)
        if (p >= 0) popped.splice(p, 1)
      } else {
        if (d.operation === 'popAll' && !isNoise(text)) popped.push({ text, ts: d.timestamp || null, ...(images ? { images } : {}) })
        const i = queue.findIndex(q => q.text === text)
        queue.splice(i >= 0 ? i : 0, 1)
        if (queue[0] !== started) started = null
      }
      continue
    }
    // End of turn: the head entry taken by this turn without a trace in the queue
    // (no dequeue, modified text) has been handled.
    if (d.type === 'system' && d.subtype === 'scheduled_task_fire') {
      fire = typeof d.prompt === 'string' ? d.prompt : null
      continue
    }
    if (d.type === 'system' && d.subtype === 'turn_duration') {
      if (started) queue.splice(queue.indexOf(started), 1)
      started = null
      continue
    }
    if (d.isSidechain || d.isMeta) continue
    const ts: string | null = d.timestamp || null
    // Message taken during the turn: written as an attachment, not as a message.
    if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command'
      && d.attachment.commandMode === 'prompt' && (d.attachment.origin || {}).kind === 'human') {
      const parts: Json[] = Array.isArray(d.attachment.prompt) ? d.attachment.prompt : [{ type: 'text', text: String(d.attachment.prompt || '') }]
      const texts: string[] = parts.filter(p => p.type === 'text').map(p => String(p.text || ''))
      const text = stripImageTags(unwrapPasted(texts.join('\n')))
      const images = parts.filter(p => p.type === 'image').length
      if (text || images) {
        items.push({ role: 'user', text: clip(text), images, ref: images ? ref : undefined, ts: d.attachment.timestamp || ts, ...pastedOf(...texts) })
        pendingCmd = null
        said(text, d.attachment.timestamp || ts, images)
      }
      continue
    }
    if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command' && d.attachment.commandMode === 'prompt') {
      const parts: Json[] = Array.isArray(d.attachment.prompt) ? d.attachment.prompt : [{ type: 'text', text: String(d.attachment.prompt || '') }]
      const text = unwrapPasted(parts.filter(p => p.type === 'text').map(p => String(p.text || '')).join('\n'))
      const kind = String((d.attachment.origin || {}).kind || '')
      injected(scheduledText(text) || stripImageTags(text), d.attachment.timestamp || ts, /^(scheduled|cron)/.test(kind) || Boolean(scheduledText(text)))
      continue
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') {
      items.push({ role: 'system', text: 'Conversation compacted', ts })
      continue
    }
    // Local command (/context, /usage…): recent versions of Claude Code
    // write it as a system message, without its output (read from the screen).
    if (d.type === 'system' && d.subtype === 'local_command' && typeof d.content === 'string') {
      const cmd = d.content.match(/<command-name>([^<]*)<\/command-name>/)
      const changed = effortChange(d.content) || modelChange(d.content)
      if (changed) items.push({ role: 'system', text: changed, ts })
      else if (cmd && isResetCmd(cmd[1]!)) swallow(ts)
      else if (cmd && !isPickerCmd(cmd[1]!)) {
        const args = (d.content.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || ''
        pushCmd({ role: 'cmd', text: `${cmd[1]} ${args}`.trim(), ts })
      } else if (cmd) open = null
      else output(d.content)
      continue
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    const content = d.message && d.message.content
    if (d.type === 'assistant' && pendingCmd && Array.isArray(content) && content.some((c: Json) => c.type === 'tool_use' || assistantText(c))) {
      const c: ChatItem = pendingCmd
      c.role = 'user'
      delete c.out
      delete c.err
      said(c.text, c.ts || null)
      pendingCmd = null
      if (open === c) open = null
    }
    if (d.type === 'user') {
      if (d.isCompactSummary) continue
      if (typeof content === 'string') {
        const cmd = content.match(/<command-name>([^<]*)<\/command-name>/)
        const changed = effortChange(content) || modelChange(content)
        if (changed) items.push({ role: 'system', text: changed, ts })
        else if (cmd && isResetCmd(cmd[1]!)) swallow(ts)
        else if (cmd && isPickerCmd(cmd[1]!)) open = null
        else if (cmd) {
          const args = (content.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || ''
          pushCmd({ role: 'cmd', text: `${cmd[1]} ${args}`.trim(), ts })
        } else if (special(content, ts)) {
          continue
        } else if (/^\[Request interrupted/.test(content)) {
          items.push({ role: 'system', text: 'Interrupted', ts })
        } else if (scheduledText(content) || (fire && sameMsg(fire, content))) {
          injected(scheduledText(content) || content, ts, true)
        } else {
          const text = humanText(content)
          if (text) {
            items.push({ role: 'user', text: clip(text), ts, ...pastedOf(content) })
            pendingCmd = null
            said(text, ts)
            noteSaid(d)
          }
        }
        continue
      }
      if (!Array.isArray(content)) continue
      let text = ''
      const raw: string[] = []
      let images = 0
      // Images the line's tool results returned come after the message's
      // own (see extractImage).
      let toolImages = content.filter((p: Json) => p && p.type === 'image').length
      for (const part of content) {
        if (part.type === 'tool_result') {
          const t = tools.get(part.tool_use_id)
          if (t && part.is_error) t.error = true
          const n = Array.isArray(part.content) ? part.content.filter((p: Json) => p && p.type === 'image').length : 0
          if (t && n && ref) {
            t.images = n
            t.ref = ref
            if (toolImages) t.imageAt = toolImages
          }
          toolImages += n
        } else if (part.type === 'text') {
          const sched = scheduledText(part.text) || (fire && sameMsg(fire, String(part.text || '')) ? String(part.text) : null)
          if (sched) { injected(sched, ts, true); continue }
          if (special(String(part.text || ''), ts)) continue
          const t = humanText(part.text)
          if (t === null) continue
          raw.push(String(part.text || ''))
          if (/^\[Request interrupted/.test(t)) items.push({ role: 'system', text: 'Interrupted', ts })
          else text += (text ? '\n' : '') + unwrapPasted(t.replace(/\[Image #\d+\]\s*/g, ''))
        } else if (part.type === 'image') images++
      }
      if (text.trim() || images) {
        items.push({ role: 'user', text: clip(text.trim()), images, ref: images ? ref : undefined, ts, ...pastedOf(...raw) })
        pendingCmd = null
        said(text, ts, images)
        noteSaid(d)
      }
    } else if (Array.isArray(content)) {
      for (const [block, part] of content.entries()) {
        const reply = assistantText(part)
        if (reply) {
          items.push(replyItem({ role: 'assistant', text: clip(reply), ts }, ref, block))
        } else if (part.type === 'tool_use') {
          const t: ChatItem = { role: 'tool', name: part.name, text: clip(toolSummary(part.name, part.input, home), 300), ts }
          tools.set(part.id, t)
          items.push(t)
        }
      }
    }
  }
  // Local commands: one "/cmd → useful output" line, without a block.
  for (const it of items) {
    if (it.role !== 'cmd') continue
    const line = usefulOutput(it.out, it.err)
    if (line) it.text = `${it.text} → ${line}`
    delete it.out
    delete it.err
  }
  // Queued task notifications: not user messages.
  items.queue = queue.filter(q => !isNoise(q.text))
  items.popped = popped
  return items
}

export function codexCommand(input: unknown): string {
  const s = String(input || '')
  const m = s.match(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/) || s.match(/\bcmd\s*:\s*'((?:[^'\\]|\\.)*)'/) || s.match(/\bcmd\s*:\s*`([^`]*)`/)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) }
    catch { return m[1]! }
  }
  // Script without a shell command: we name the tool called (write_stdin, apply_patch…).
  const t = s.match(/\btools\.(\w+)\s*\(/)
  if (t) return t[1]!
  return firstLine(s)
}

// Codex writes an attached image as three content parts (codex-rs/protocol
// models.rs): '<image name=[Image #1] path="…">' ('<image name=[Image #1]>' in
// older versions, '<image>' for a remote one), the input_image, then '</image>'.
// The user's text, after them, keeps the composer's "[Image #1]" placeholder.
// Only parts right around an image are wrappers: the same text elsewhere is the user's.
const CODEX_IMAGE_OPEN = /^<image(?: name=\[Image #\d+\][^\n]*)?>$/
const CODEX_IMAGE_CLOSE = '</image>'
function codexImageWrappers(content: Json[]): Set<number> {
  const out = new Set<number>()
  content.forEach((part, k) => {
    if (part?.type !== 'input_image') return
    const before = content[k - 1]
    const after = content[k + 1]
    if (before?.type === 'input_text' && CODEX_IMAGE_OPEN.test(String(before.text || '').trim())) out.add(k - 1)
    if (after?.type === 'input_text' && String(after.text || '').trim() === CODEX_IMAGE_CLOSE) out.add(k + 1)
  })
  return out
}
// The composer's placeholders are not told apart by their text: "[Image #1]"
// typed by the user looks the same. Codex records them separately, as
// `text_elements` (UTF-8 byte ranges) of the text it was given, in the event
// written after the message: `user_message` (legacy rollouts) or
// `item_completed` with a `UserMessage` item (paginated ones). Only those
// ranges are removed. Without such an event (older Codex, or a page that cut
// it off), a text is kept unless it holds nothing but the placeholders of the
// message's own images, each once (a photo sent alone).
type Spans = [number, number][]
const IMAGE_LABEL = /^\[Image #(\d+)\]$/
function imageSpans(text: string, elements: unknown): Spans {
  if (!Array.isArray(elements)) return []
  const bytes = Buffer.from(text)
  const out: Spans = []
  for (const el of elements as Json[]) {
    const start = el?.byte_range?.start
    const end = el?.byte_range?.end
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > bytes.length || start >= end) continue
    const slice = bytes.subarray(start, end).toString()
    // The span must hold an image placeholder (not a mention or a paste).
    if (!IMAGE_LABEL.test(slice) || (el.placeholder != null && el.placeholder !== slice)) continue
    out.push([bytes.subarray(0, start).toString().length, bytes.subarray(0, end).toString().length])
  }
  return out
}
// Texts Codex declared with their image placeholders, from the turn events of
// these lines; each event is used once (the same text may be sent twice).
function codexPlaceholders(lines: Lines): Map<string, Spans[]> {
  const out = new Map<string, Spans[]>()
  const add = (text: unknown, elements: unknown) => {
    if (typeof text !== 'string') return
    // Kept even with no image span: the text is then known to be typed.
    out.set(text, [...(out.get(text) || []), imageSpans(text, elements)])
  }
  for (const line of lines) {
    if (!line || !line.includes('"event_msg"') || !line.includes('text_elements')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    const e = d?.payload
    if (d?.type !== 'event_msg' || !e) continue
    if (e.type === 'user_message') add(e.message, e.text_elements)
    else if (e.type === 'item_completed' && e.item?.type === 'UserMessage' && Array.isArray(e.item.content)) {
      for (const c of e.item.content) if (c?.type === 'text') add(c.text, c.text_elements)
    }
  }
  return out
}
// The text without the [start, end) ranges, and without the spaces or line they leave.
function dropSpans(text: string, spans: Spans): string {
  for (const [start, end] of [...spans].sort((x, y) => y[0] - x[0])) {
    let a = start
    let b = end
    while (text[b] === ' ' || text[b] === '\t') b++
    if (b === text.length || text[b] === '\n') while (a > 0 && (text[a - 1] === ' ' || text[a - 1] === '\t')) a--
    if ((a === 0 || text[a - 1] === '\n') && text[b] === '\n') b++
    text = text.slice(0, a) + text.slice(b)
  }
  return text
}
// Nothing but the placeholders of the message's images, each once: "[Image #1]",
// "[Image #1] [Image #2]"… (what the composer leaves when no text is typed).
function onlyOwnLabels(text: string, images: number): boolean {
  const t = text.trim()
  if (!/^(?:\[Image #\d+\]\s*)+$/.test(t)) return false
  const nums = [...t.matchAll(/\[Image #(\d+)\]/g)].map(m => Number(m[1]))
  return nums.every(n => n >= 1 && n <= images) && new Set(nums).size === nums.length
}

export function parseCodex(lines: Lines): Parsed {
  const items: Parsed = []
  const calls = new Map<string, ChatItem>()
  const placeholders = codexPlaceholders(lines)
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const ref = lines.refs ? lines.refs[li] : undefined
    if (!line) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    // Turn stopped by Escape (or by anything Codex took for it): shown like
    // Claude's "[Request interrupted by user]".
    if (d.type === 'event_msg' && d.payload?.type === 'turn_aborted') {
      if (d.payload.reason === 'interrupted') items.push({ role: 'system', text: 'Interrupted', ts: d.timestamp || null })
      continue
    }
    if (d.type !== 'response_item' || !d.payload) continue
    const p = d.payload
    const ts: string | null = d.timestamp || null
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      let text = ''
      let images = 0
      const content: Json[] = Array.isArray(p.content) ? p.content : []
      const wrappers = p.role === 'user' ? codexImageWrappers(content) : new Set<number>()
      const imageCount = content.filter(part => part?.type === 'input_image').length
      for (const [k, part] of content.entries()) {
        if (wrappers.has(k)) continue
        // "!cmd" typed in Codex: run at once, written as
        // <user_shell_command><command>…</command><result>Exit code: N … Output:\n…</result>.
        const run = p.role === 'user' && part.type === 'input_text' ? /^\s*<user_shell_command>\s*<command>\s*([\s\S]*?)\s*<\/command>\s*(?:<result>([\s\S]*?)<\/result>)?/.exec(part.text || '') : null
        if (run) {
          const result = run[2] || ''
          const exit = /Exit code: (-?\d+)/.exec(result)
          const out = /(?:^|\n)Output:\n?([\s\S]*)$/.exec(result)
          items.push({ role: 'bash', text: clip(run[1]!, 2000), out: out ? out[1]!.replace(/\s+$/, '').slice(-MAX_OUT) : '', err: '', error: Boolean(exit && exit[1] !== '0'), ts })
        } else if (p.role === 'user' && imageCount && part.type === 'input_text' && part.text && !isNoise(part.text)) {
          const declared = placeholders.get(part.text)?.shift()
          const kept: string = declared ? dropSpans(part.text, declared) : onlyOwnLabels(part.text, imageCount) ? '' : part.text
          if (kept.trim()) text += (text ? '\n' : '') + kept
        } else if ((part.type === 'input_text' || part.type === 'output_text') && part.text && !isNoise(part.text)) text += (text ? '\n' : '') + part.text
        else if (part.type === 'input_image') images++
      }
      if (text.trim() || images) {
        const item: ChatItem = { role: p.role, text: clip(text.trim()), images, ref: images ? ref : undefined, ts }
        items.push(p.role === 'assistant' ? replyItem(item, ref) : item)
      }
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      let summary: unknown = ''
      if (p.type === 'custom_tool_call') summary = codexCommand(p.input)
      else if (p.arguments) {
        try {
          const a = JSON.parse(p.arguments)
          summary = Array.isArray(a.command) ? a.command.join(' ') : a.cmd || a.command || firstLine(p.arguments)
        } catch { summary = firstLine(p.arguments) }
      } else if (p.action && p.action.command) summary = ([] as string[]).concat(p.action.command).join(' ')
      const t: ChatItem = { role: 'tool', name: p.name || 'shell', text: clip(String(summary), 300), ts }
      if (typeof p.call_id === 'string') calls.set(p.call_id, t)
      items.push(t)
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && Array.isArray(p.output)) {
      // Images a tool returned (view_image…), re-read on demand from this line.
      const t = calls.get(p.call_id)
      const images = p.output.filter((o: Json) => o && o.type === 'input_image').length
      if (t && images && ref) {
        t.images = images
        t.ref = ref
      }
    }
  }
  return items
}

// omp tool names mapped to Claude Code's (labels, icons).
const OMP_TOOLS: Record<string, string> = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', ast_edit: 'Edit', grep: 'Grep',
  glob: 'Glob', find: 'Glob', web_search: 'WebSearch', fetch: 'WebFetch', task: 'Task', todo: 'TodoWrite',
}
function ompToolSummary(args: Json, home: string): string {
  const a = args && typeof args === 'object' ? args : {}
  // `i`: the intent the agent gives for each call ("Reading model settings").
  for (const k of ['i', 'title', 'description']) if (typeof a[k] === 'string' && a[k].trim()) return firstLine(a[k])
  if (typeof a.path === 'string') return home ? a.path.replace(home, '~') : a.path
  for (const k of ['command', 'pattern', 'query']) if (typeof a[k] === 'string') return firstLine(a[k])
  return firstLine(Object.values(a).find(x => typeof x === 'string') || '')
}

// omp (oh-my-pi): ~/.omp/agent/sessions/<encoded cwd>/<date>_<id>.jsonl, one
// entry per line. `message` carries a message (user, assistant, toolResult;
// developer and fileMention are agent injections); a `custom_message`
// "skill-prompt" attributed to the user is a skill they invoked.
// User messages injected by the agent (reminders, subagent
// instructions): `synthetic` or `attribution: 'agent'`. Images are
// stored separately (`data: "blob:sha256:<hash>"`, see extractImage). `templates`:
// omp's file commands, whose text it sends instead of "/name args".
export function parseOmp(lines: Lines, home = '', templates: readonly CommandTemplate[] = [], sessionCwd = ''): Parsed {
  const items: Parsed = []
  const tools = new Map<string, { item: ChatItem, name: string, at: number | null }>()
  let previousTs: string | null = null
  // Session folder (the file's first line, or `sessionCwd` for a slice
  // that does not include it): paths are shown relative to it, like omp does.
  let cwd = sessionCwd
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const ref = lines.refs ? lines.refs[li] : undefined
    if (!line) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    if (!d || typeof d !== 'object') continue
    const ts: string | null = typeof d.timestamp === 'string' ? d.timestamp : null
    const priorTs = previousTs
    if (ts) previousTs = ts
    if (d.type === 'session') {
      if (typeof d.cwd === 'string') cwd = d.cwd.replace(/\/+$/, '')
      continue
    }
    if (d.type === 'compaction') {
      items.push({ role: 'system', text: 'Conversation compacted', ts })
      continue
    }
    // Model switch (the selector, alt+p or /switch): shown like Claude's
    // "/model → …" line. "role": "temporary" only: a "default" change was
    // made from the provider settings panel, not from the conversation.
    if (d.type === 'model_change' && typeof d.model === 'string' && d.model && d.role === 'temporary') {
      items.push({ role: 'system', text: `/model → ${ompModelLabel(d.model)}`, ts })
      continue
    }
    if (d.type === 'custom_message') {
      const s = d.details
      if (d.customType === 'skill-prompt') {
        if (d.attribution === 'user' && s && typeof s.name === 'string') items.push({ role: 'user', text: clip(stripImageTags(`/skill:${s.name}${s.args ? ` ${s.args}` : ''}`)), ts })
      } else if (d.display && typeof d.customType === 'string') {
        // What the terminal also shows (advisor, finished background task,
        // IRC message, late diagnostics…), without the wrapper meant for the model.
        const notes: Json[] = d.customType === 'advisor' && s && Array.isArray(s.notes) ? s.notes : []
        const text = notes.length
          ? notes.filter(n => n && typeof n.note === 'string').map(n => (n.severity ? `**${n.severity}** — ${n.note}` : n.note)).join('\n\n')
          : String(d.content || '').replace(/^\s*<([\w:-]+)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>\s*$/, '$2').trim()
        if (d.customType === 'async-result' && Array.isArray(s?.jobs) && s.jobs.length) {
          for (const job of s.jobs) {
            if (typeof job.jobId !== 'string' || !/^bg_[\w-]+$/.test(job.jobId)) continue
            const header = text.match(/^Background job [^\n]+? has (completed|failed)\.[^\n]*\n?/i)
            const out = cleanOut(text.replace(header?.[0] || '', '').replace(/\n?Wall time: [\d.]+ seconds\s*$/, ''))
            items.push({ role: 'job', text: '', ts, error: header?.[1]?.toLowerCase() === 'failed',
              ms: Number.isFinite(job.durationMs) ? job.durationMs : undefined,
              job: { id: job.jobId, tool: String(job.type || 'job'), out } })
          }
        } else if (text) items.push({ role: 'notice', name: d.customType, text: clip(text), ts })
      }
      continue
    }
    if (d.type !== 'message' || !d.message) continue
    const m = d.message
    if (m.role === 'user') {
      if (m.synthetic || m.attribution === 'agent') continue
      const parts: Json[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
      const text = ompCommandText(stripImageTags(parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')), templates)
      const images = parts.filter(p => p && p.type === 'image').length
      if (text || images) items.push({ role: 'user', text: clip(text), images, ref: images ? ref : undefined, ts })
    } else if (m.role === 'assistant') {
      for (const [block, part] of (Array.isArray(m.content) ? m.content : []).entries()) {
        if (!part) continue
        if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
          const ms = ts && priorTs ? Math.max(0, Date.parse(ts) - Date.parse(priorTs)) : undefined
          items.push({ role: 'thinking', text: clip(part.thinking), ts, ms: Number.isFinite(ms) ? ms : undefined })
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          items.push(replyItem({ role: 'assistant', text: clip(part.text), ts }, ref, block))
        } else if (part.type === 'toolCall') {
          const name = String(part.name || '').trim()
          const t: ChatItem = { role: 'tool', name: OMP_TOOLS[name] || name, text: clip(ompToolSummary(part.arguments, home), 300), ts, omp: ompToolCall(name, part.arguments, cwd, home) }
          if (part.id) tools.set(part.id, { item: t, name, at: ts ? Date.parse(ts) || null : null })
          items.push(t)
        }
      }
      const end = ompTurnEnd(m)
      if (end) items.push({ ...end, ts })
    } else if (m.role === 'bashExecution' || m.role === 'pythonExecution') {
      // "!cmd" / "$ code" typed in omp's input field: a user action, like
      // Claude's bash mode, drawn the way omp draws it.
      const v = ompUserRun(m)
      if (v) items.push({ role: 'bash', text: v.target!, ts, error: Boolean(v.exit || v.cancelled), omp: v })
    } else if (m.role === 'toolResult') {
      const t = tools.get(m.toolCallId)
      if (!t) continue
      if (m.isError) t.item.error = true
      // Images the tool returned (read of a PNG, screenshot…): re-read on
      // demand from this line, like the user's.
      const images = Array.isArray(m.content) ? m.content.filter((p: Json) => p && p.type === 'image').length : 0
      if (images && ref) {
        t.item.images = images
        t.item.ref = ref
      }
      if (t.item.omp) ompToolResult(t.item.omp, t.name, m, t.at, cwd, home)
    }
  }
  return items
}

// How an omp assistant turn ended, when it failed: what omp's terminal shows
// under it when it replays the session. A provider error (usage limit,
// credit balance, stalled stream, "Retry budget exhausted…") is a turn with
// `stopReason: "error"`, its `errorMessage` and often no content at all.
// When omp retries, it later marks the failed attempt (`retryRecovery`, by
// rewriting the file): "superseded" attempts are hidden, a "recovered" one
// becomes a one-line note. Error ids carry omp's flags (pi-ai error/flags.ts).
const OMP_SILENT_ABORT = 0x0200_0000
const OMP_USER_INTERRUPT = 0x0400_0000
const OMP_ABORT = 0x0800_0000
function ompTurnEnd(m: Json): Pick<ChatItem, 'role' | 'text' | 'name' | 'error'> | null {
  const status = m.retryRecovery && typeof m.retryRecovery === 'object' ? m.retryRecovery.status : null
  if (status === 'superseded') return null
  if (status === 'recovered') return { role: 'system', text: 'Retried after an error' }
  const message = typeof m.errorMessage === 'string' ? m.errorMessage.trim() : ''
  const id = Number.isInteger(m.errorId) ? m.errorId as number : 0
  if (id & OMP_SILENT_ABORT || message === '__omp.silent_abort__') return null
  if (id & OMP_USER_INTERRUPT || (m.stopReason === 'aborted' && /interrupt/i.test(message))) return { role: 'system', text: 'Interrupted' }
  let text = ''
  if (m.stopReason === 'error') text = message || 'Error'
  else if (m.stopReason === 'aborted') text = id & OMP_ABORT || !message || message === 'Request was aborted' ? 'Operation aborted' : message
  else text = message
  return text ? { role: 'notice', name: 'error', text: clip(text), error: true } : null
}

// Text of an omp file command: "/name args". omp appends the arguments
// after the text, unless the command places them itself ($1, {{args}}…): the
// text then only starts like the command, and its arguments are lost.
function ompCommandText(text: string, templates: readonly CommandTemplate[]): string {
  for (const t of templates) {
    if (text === t.body) return `/${t.name}`
    if (text.startsWith(`${t.body}\n\n`)) return `/${t.name} ${text.slice(t.body.length + 2).trim()}`
    const head = t.body.slice(0, 160)
    if (head.length === 160 && !/[$]|\{\{/.test(head) && text.startsWith(head)) return `/${t.name}`
  }
  return text
}

// `base`: position (in bytes) of `text` in the file. Each line keeps
// its "start:length" position (lines.refs): messages with images
// carry it, to re-read the image on demand (see image()).
// Command Code (commandcode.ai): one JSONL session per project, shaped like
// Claude's (message / model_change / session lines, tool_use + tool_result,
// thinking, images). `meta.source` separates a human turn from tool results
// and injected context; `model` on assistant lines is the session's model.
function commandCodeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(p => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
}

function commandCodeTool(name: string, input: Json): string {
  if (typeof input === 'string') return firstLine(input)
  const i = input && typeof input === 'object' ? input : {}
  switch (name) {
    case 'shell_command': return firstLine(i.description || i.command)
    case 'read_file': case 'write_file': case 'edit_file':
      return firstLine(i.file_path || i.path)
    case 'grep': return `${i.pattern || ''}${i.path ? ` · ${i.path}` : ''}`
    case 'glob': return firstLine(i.pattern)
    case 'agent': return firstLine(i.description || i.prompt)
    case 'ask_user_question': return firstLine(i.questions && i.questions[0] && i.questions[0].question)
    case 'search_tools': return firstLine(i.query)
    default: {
      const v = Object.values(i).find(x => typeof x === 'string')
      return firstLine(v)
    }
  }
}

export type CommandCodeResult = { out?: string, error?: boolean, images?: number, ref?: string, imageAt?: number, at?: number, len?: number, hash?: string }
export type CommandCodeWatch = { at: number, len: number, hash: string }

export function parseCommandCode(lines: Lines, results?: Map<string, CommandCodeResult>, updates?: CommandCodeToolUpdate[], watches?: Map<string, CommandCodeWatch>): Parsed {
  const items: Parsed = []
  const tools = new Map<string, ChatItem>()
  for (let i = 0; i < lines.length; i++) {
    let d: Json
    try { d = JSON.parse(lines[i]!) } catch { continue }
    if (!d || d.type !== 'message' || !d.message || typeof d.message !== 'object') continue
    const m = d.message
    const ref = lines.refs?.[i]
    const ts = typeof d.timestamp === 'string'
      ? d.timestamp
      : (Number.isFinite(m.meta?.createdAt) ? new Date(m.meta.createdAt).toISOString() : null)
    if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : []
      let images = 0
      let lastText: ChatItem | null = null
      for (const [block, part] of content.entries()) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
          items.push({ role: 'thinking', text: clip(part.thinking), ts })
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          lastText = replyItem({ role: 'assistant', text: clip(part.text), ts }, ref, block)
          items.push(lastText)
        } else if (part.type === 'tool_use' && typeof part.id === 'string') {
          const name = typeof part.name === 'string' ? part.name : 'Tool'
          const t: ChatItem = { role: 'tool', name, toolId: part.id, text: clip(commandCodeTool(name, part.input), 300), ts }
          // Its result may have been parsed in a newer page (a page boundary
          // between the call and the result): apply the remembered outcome.
          const saved = results?.get(part.id)
          if (saved) {
            if (saved.out) t.out = saved.out
            if (saved.error) t.error = true
            if (saved.images && saved.ref) {
              t.images = saved.images
              t.ref = saved.ref
              if (saved.imageAt) t.imageAt = saved.imageAt
            }
          }
          tools.set(part.id, t)
          items.push(t)
        } else if (part.type === 'image') images++
      }
      if (images) {
        // An assistant image belongs to the text reply, not to an extra empty
        // turn that would replace the Copy/Reply target.
        if (lastText) {
          lastText.images = images
          if (ref) lastText.ref = ref
        } else {
          items.push(replyItem({ role: 'assistant', text: '', images, ts, ...(ref ? { ref } : {}) }, ref))
        }
      }
      continue
    }
    if (m.role !== 'user') continue
    const content = m.content
    const source = m.meta && typeof m.meta.source === 'string' ? m.meta.source : null
    // `meta.isMeta` marks automation (monitor wake-ups, goal continuations):
    // its source is still "user" but it is not a human turn.
    const hidden = m.meta?.isMeta === true
    if (typeof content === 'string') {
      const text = content.trim()
      if (text && source !== 'system' && !hidden) items.push({ role: 'user', text: clip(text), ts })
      continue
    }
    if (!Array.isArray(content)) continue
    let text = ''
    let images = 0
    // Images the line's tool results returned come after the message's own
    // (see lineImages / extractImage).
    let toolImages = content.filter((p: Json) => p && p.type === 'image').length
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') {
        text += (text ? '\n' : '') + part.text
      } else if (part.type === 'image') {
        images++
      } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const t = tools.get(part.tool_use_id)
        const n = Array.isArray(part.content) ? part.content.filter((p: Json) => p && p.type === 'image').length : 0
        const out = commandCodeText(part.content)
        // Watch every result record, whether its call is in this page or an
        // older one: an in-place rewrite of shown output must invalidate the
        // client pages that display it.
        let watch: CommandCodeWatch | null = null
        if (ref) {
          const [at, len] = ref.split(':')
          const raw = Buffer.from(lines.raw?.[i] ?? lines[i]!)
          watch = { at: Number(at), len: Number(len), hash: createHash('sha256').update(raw.subarray(0, WATCH_BYTES)).digest('hex').slice(0, 16) }
          if (watches) {
            watches.set(part.tool_use_id, watch)
            if (watches.size > 4096) watches.delete(watches.keys().next().value!)
          }
        }
        if (t) {
          if (out) t.out = clip(out, 8000)
          if (part.is_error) t.error = true
          if (n && ref) {
            t.images = n
            t.ref = ref
            if (toolImages) t.imageAt = toolImages
          }
        } else if (results) {
          // The call is in an older page: remember its result for the page
          // that will render it.
          const rec: CommandCodeResult = {}
          if (out) rec.out = clip(out, 8000)
          if (part.is_error) rec.error = true
          if (watch) {
            rec.at = watch.at
            rec.len = watch.len
            rec.hash = watch.hash
          }
          if (n && ref) {
            rec.images = n
            rec.ref = ref
            if (toolImages) rec.imageAt = toolImages
          }
          if (rec.out || rec.error || rec.images) {
            results.set(part.tool_use_id, rec)
            if (results.size > 4096) results.delete(results.keys().next().value!)
            // The call may already be shown in an older page the client
            // loaded: send the outcome so it updates without a reopen.
            updates?.push({
              id: part.tool_use_id,
              ...(rec.out !== undefined ? { out: rec.out } : {}),
              ...(rec.error ? { error: true } : {}),
              ...(rec.images ? { images: rec.images, ref: rec.ref, imageAt: rec.imageAt } : {}),
            })
          }
        }
        // lineImages() counts this result's images even when its call is
        // outside the loaded page: the next matched tool's offset must skip them.
        toolImages += n
      }
    }
    const human = !hidden && (source === 'user' || (!source && !content.some((p: Json) => p && p.type === 'tool_result')))
    if (human && (text.trim() || images)) {
      items.push({ role: 'user', text: clip(text.trim()), images, ...(images && ref ? { ref } : {}), ts })
    }
  }
  return items
}

export function parseLines(text: string, kind: string | null, base = 0, home = '', templates?: readonly CommandTemplate[], cwd = '', cmdResults?: Map<string, CommandCodeResult>, cmdWatches?: Map<string, CommandCodeWatch>): Parsed {
  const raw = text.split('\n')
  const refs: string[] = []
  let off = base
  for (const l of raw) {
    const n = Buffer.byteLength(l)
    refs.push(`${off}:${n}`)
    off += n + 1
  }
  const lines: Lines = raw.map(stripBlobs)
  lines.refs = refs
  lines.raw = raw
  const cmdUpdates: CommandCodeToolUpdate[] = []
  const items = kind === 'omp' ? parseOmp(lines, home, templates, cwd) : kind === 'codex' ? parseCodex(lines) : kind === 'cmd' ? parseCommandCode(lines, cmdResults, cmdUpdates, cmdWatches) : parseClaude(lines, home)
  if (cmdUpdates.length) items.updates = cmdUpdates
  // Content hash of each image, to spot one shown twice (see shared/imageDupes.ts).
  const byRef = new Map<string, number>()
  refs.forEach((r, i) => byRef.set(r, i))
  for (const it of items) {
    if (!it.images || !it.ref) continue
    const i = byRef.get(it.ref)
    if (i === undefined) continue
    const all = lineImageHashes(raw[i]!)
    const at = it.imageAt || 0
    const own = all.slice(at, at + it.images)
    if (own.length === it.images) it.hashes = own
  }
  return items
}

// Hashes are cached per line: transcripts only grow, a line never changes,
// and its multi-MB base64 is decoded and hashed once, not at every poll.
const HASH_CACHE_MAX = 2000
const hashCache = new Map<string, string[]>()
export function lineImageHashes(line: string): string[] {
  if (!line.includes('"type":"image"') && !line.includes('"input_image"')) return []
  const key = `${line.length}:${line.slice(0, 200)}:${line.slice(-200)}`
  const hit = hashCache.get(key)
  if (hit) return hit
  let hashes: string[] = []
  try {
    hashes = lineImages(JSON.parse(line)).map(img => 'blob' in img ? img.blob : createHash('sha256').update(Buffer.from(img.data, 'base64')).digest('hex'))
  } catch { hashes = [] }
  if (hashCache.size >= HASH_CACHE_MAX) hashCache.delete(hashCache.keys().next().value!)
  hashCache.set(key, hashes)
  return hashes
}

// Types served as is: an SVG image (or any type written in the
// transcript) opened from wherdr would run its scripts on its origin.
const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp)$/

// Image no. `index` of a JSON transcript line (Claude, Codex, omp). omp
// stores its images separately: `blob` is then the hash to re-read in
// ~/.omp/agent/blobs (see image()).
export type TranscriptImage = { type: string, body: Buffer } | { type: string, blob: string }
type LineImage = { type: string, data: string } | { type: string, blob: string }
// Images of a line, in the order of the `i` of /api/chat/image.
function lineImages(d: Json): LineImage[] {
  const found: LineImage[] = []
  const visit = (parts: Json[] | null) => {
    for (const p of parts || []) {
      if (p && p.type === 'image' && p.source && p.source.data) found.push({ type: p.source.media_type || 'image/png', data: p.source.data })
      else if (p && p.type === 'image' && typeof p.data === 'string') {
        const blob = /^blob:sha256:([a-f0-9]{64})$/.exec(p.data)
        found.push(blob ? { type: p.mimeType || 'image/png', blob: blob[1]! } : { type: p.mimeType || 'image/png', data: p.data })
      } else if (p && p.type === 'input_image') {
        const u = typeof p.image_url === 'string' ? p.image_url : p.image_url && p.image_url.url
        const mm = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(u || '')
        if (mm) found.push({ type: mm[1]!, data: mm[2]! })
      }
    }
  }
  visit(d.message && Array.isArray(d.message.content) ? d.message.content : null)
  visit(d.attachment && Array.isArray(d.attachment.prompt) ? d.attachment.prompt : null)
  visit(d.payload && Array.isArray(d.payload.content) ? d.payload.content : null)
  // Codex: images a tool returned (view_image…).
  visit(d.payload && Array.isArray(d.payload.output) ? d.payload.output : null)
  // Claude: images returned by tool results, after the message's own (see parseClaude).
  if (d.message && Array.isArray(d.message.content)) {
    for (const p of d.message.content) if (p && p.type === 'tool_result' && Array.isArray(p.content)) visit(p.content)
  }
  return found
}
export function extractImage(d: Json, index: number): TranscriptImage | null {
  const img = lineImages(d)[index]
  if (!img) return null
  const lower = String(img.type).toLowerCase()
  const type = IMAGE_TYPES.test(lower) ? lower : 'application/octet-stream'
  return 'blob' in img ? { type, blob: img.blob } : { type, body: Buffer.from(img.data, 'base64') }
}

// `fs`: disk of the machine where the agents run (local, or remote over SSH).
// File really missing, as opposed to a failed read (SSH cut,
// timeout): only absence means "no conversation". Remotely,
// Shell reads use an explicit missing-path exit code; retain the message
// fallback for other remote filesystem implementations.
export function isMissing(e: unknown): boolean {
  const err = e as { code?: string, message?: string } | null
  if (!err) return false
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true
  return err.code === 'remote' && /no such file|not a directory|introuvable/i.test(err.message || '')
}

// One tab-separated line per file: `M` missing, `E` unreadable, `H` + first
// line. `head` inside a pipeline hides its own failure behind the last
// command's success: capture first, then take the line.
export const CMD_HEADERS_SCRIPT = `for f in "$@"; do
  if [ ! -e "$f" ]; then printf "%s\\tM\\n" "$f"
  elif [ ! -r "$f" ]; then printf "%s\\tE\\n" "$f"
  elif h=$(head -c 65536 "$f" 2>/dev/null) && h=$(printf "%s\\n" "$h" | head -n 1); then
    printf "%s\\tH%s\\n" "$f" "$h"
  else
    printf "%s\\tE\\n" "$f"
  fi
done`

export function createTranscripts({ home, herdr, fs = localFs, now = Date.now, exec, stream }: { home: string, herdr: HerdrCall, fs?: MachineFs, now?: () => number, exec?: ShellExec, stream?: (script: string, args: string[]) => ChildProcessWithoutNullStreams | null }) {
  const devin = createDevinTranscripts({ home, fs, exec })
  const opencode = createOpenCodeTranscripts({ home, exec, stream })
  // Command Code discovery/status caches: project headers change rarely, and
  // an unchanged session must not be re-read on every 5 s status refresh.
  const cmdHeaders = new Map<string, { size: number, mtimeMs: number, cwd: string | null, id: string | null }>()
  const cmdStatsCache = new Map<string, { file: string, size: number, gen: string, stats: CommandCodeStatus | null, session: string | null }>()
  // Tool results parsed in a newer page than their call (a page boundary):
  // the call's page applies them when it is read. Scoped per transcript so a
  // truncated or another session's call id cannot resurrect an old result.
  const cmdResults = new Map<string, Map<string, CommandCodeResult>>()
  // Fingerprints of every parsed tool result (matched or orphan), used to
  // detect an in-place rewrite of output already shown in a loaded page.
  const cmdWatches = new Map<string, Map<string, CommandCodeWatch>>()
  const cmdSizes = new Map<string, { size: number, gen: string, ino?: number }>()
  // Per-file invalidation generation: carried by tokens so a client that did
  // not witness the rewrite still rebuilds the older pages it kept.
  const cmdEpochs = new Map<string, number>()
  // Identifies this reader instance: a restart empties the cross-page result
  // map, so an old token must reload the pages instead of showing a tool
  // without output that was parsed in another, now-forgotten page.
  const readerId = Math.random().toString(36).slice(2, 10)
  function evictCmdFile(file: string) {
    // The evicted transcript's own epoch advances: only the clients that may
    // have loaded its pages rebuild, not every open Command Code chat.
    cmdEpochs.set(file, (cmdEpochs.get(file) ?? 0) + 1)
    if (cmdEpochs.size > 4096) cmdEpochs.delete(cmdEpochs.keys().next().value!)
    forgetCmdFile(file)
    cmdSizes.delete(file)
  }
  function cmdResultsFor(file: string) {
    let m = cmdResults.get(file)
    if (!m) {
      m = new Map()
      cmdResults.set(file, m)
      if (cmdResults.size > 64) evictCmdFile(cmdResults.keys().next().value!)
    }
    return m
  }
  function cmdWatchesFor(file: string) {
    let m = cmdWatches.get(file)
    if (!m) {
      m = new Map()
      cmdWatches.set(file, m)
      if (cmdWatches.size > 64) evictCmdFile(cmdWatches.keys().next().value!)
    }
    return m
  }
  // File -> state (size, generation) and when this server first saw it, for
  // whole-second mtimes (see SETTLE_MS); `file|size|gen` -> checksum of the
  // file at first sight (null: could not be taken).
  const genSeen = new Map<string, { state: string, at: number }>()
  const firstSums = new Map<string, Promise<string | null>>()
  const sumKey = (file: string, size: number, gen: string) => `${file}|${size}|${gen}`
  async function settledGen(file: string, st: { size: number, mtimeMs: number }, gen: string) {
    if (Math.round(st.mtimeMs * 1000) % 1_000_000) return true // sub-second mtime: exact
    const state = `${st.size}|${gen}`
    const seen = genSeen.get(file)
    if (seen && seen.state === state) return now() - seen.at >= SETTLE_MS
    genSeen.delete(file)
    genSeen.set(file, { state, at: now() })
    if (genSeen.size > 64) genSeen.delete(genSeen.keys().next().value!)
    if (fs.digest) {
      // Taken before the bottom is read: what any client reads of this
      // state comes after it.
      const sum = fs.digest(file, st.size).catch(() => null)
      firstSums.set(sumKey(file, st.size, gen), sum)
      if (firstSums.size > 64) firstSums.delete(firstSums.keys().next().value!)
      await sum
    }
    return false
  }
  // A client list read from a state not settled yet: is its part of the file
  // (its first `size` bytes, appends only add after them) still the same?
  async function stillThere(file: string, prev: { size: number, gen: string }) {
    if (!fs.digest) return true // no checksum on this machine: cannot tell
    const before = await firstSums.get(sumKey(file, prev.size, prev.gen))
    if (!before) return false // forgotten (server restarted): start again to be safe
    return await fs.digest(file, prev.size).catch(() => null) === before
  }
  const locCache = new Map<string, { at: number, loc: Loc | null, session?: string | null }>()
  const lastLoc = new Map<string, Loc>() // last file found, fallback if a lookup fails
  const parseCache = new Map<string, { size: number, gen: string, settled: boolean, r: TailResult }>()
  // A file's remembered results and parsed tails travel together: clearing one
  // without the other would serve a cached page that no longer has them.
  function forgetCmdFile(file: string) {
    cmdResults.delete(file)
    cmdWatches.delete(file)
    for (const key of [...parseCache.keys()]) if (key.startsWith(`${file}|`)) parseCache.delete(key)
  }

  // A larger same-inode file may still be an in-place rewrite: every parsed
  // result record (matched or orphan) must still fingerprint the same bytes.
  // One bounded read covers the whole watch set: a per-record pipeline would
  // launch thousands of processes on a tool-heavy session.
  async function cmdResultsValid(file: string): Promise<boolean | null> {
    const watches = cmdWatches.get(file)
    if (!watches || !watches.size) return true
    const records = new Map<string, CommandCodeWatch>()
    for (const w of watches.values()) records.set(`${w.at}:${w.len}:${w.hash}`, w)
    const all = [...records.values()].sort((a, b) => a.at - b.at)
    // Only the sampled prefix is read: a huge result never exceeds the budget.
    const sampleLen = (w: CommandCodeWatch) => Math.min(w.len, WATCH_BYTES)
    let first = all[0]!.at
    const last = all[all.length - 1]!
    const end = last.at + sampleLen(last)
    let selected = all
    // Above the cap, validate the newest records that fit: the work stays
    // bounded whatever the session size.
    const CAP = 4 * 1024 * 1024
    if (end - first > CAP) {
      // Compare every candidate against the fixed end: adjacent records may
      // be close while the whole watched span is much larger than the cap.
      let i = all.length - 1
      while (i > 0 && end - all[i - 1]!.at <= CAP) i--
      selected = all.slice(i)
      first = selected[0]!.at
    }
    let buf: Buffer
    // Unknown, not valid: the caller keeps the previous size and retries on
    // the next poll instead of trusting an unvalidated state.
    try { buf = await fs.read(file, first, end - first) } catch { return null }
    for (const w of selected) {
      const from = w.at - first
      const n = sampleLen(w)
      if (from < 0 || from + n > buf.length) return null
      const h = createHash('sha256').update(buf.subarray(from, from + n)).digest('hex').slice(0, 16)
      if (h !== w.hash) return false
    }
    return true
  }
  const metaCache = new Map<string, Json>()
  // omp file commands of this machine (see parseOmp), re-read every 5 min.
  let ompTemplates: { at: number, list: CommandTemplate[] } = { at: 0, list: [] }
  async function refreshOmpTemplates() {
    if (Date.now() - ompTemplates.at < 5 * 60 * 1000) return
    ompTemplates = { at: Date.now(), list: await ompCommandTemplates(fs, home).catch(() => ompTemplates.list) }
  }

  // ------------------------------------------------------------ localisation
  async function paneProcess(paneId: string, kind: string) {
    const r = await herdr('pane.process_info', { pane_id: paneId }, 4000)
    const procs: Json[] = (r.process_info && r.process_info.foreground_processes) || []
    const match = procs.find(p => p.name === kind || path.basename((p.argv && p.argv[0]) || '') === kind)
    return match || procs[0] || null
  }

  const encodeCwd = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

  async function exists(f: string) {
    try { return (await fs.stat(f)).isFile }
    catch (e) {
      if (isMissing(e)) return false
      throw e
    }
  }
  // First existing file among `files` (a single round trip remotely).
  async function firstExisting(files: string[]) {
    if (!files.length) return null
    const st = await fs.statMany(files)
    const i = st.findIndex(s => s && s.isFile)
    return i < 0 ? null : files[i]!
  }
  async function listDir(d: string) {
    try { return await fs.readdir(d) }
    catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }

  async function locateClaude(proc: { pid: number }): Promise<Loc | null> {
    let sess: Json
    try { sess = JSON.parse(await fs.readFile(path.join(home, '.claude/sessions', `${proc.pid}.json`))) }
    catch (e) {
      if (e instanceof SyntaxError || isMissing(e)) return null
      throw e
    }
    if (!sess.sessionId) return null
    const direct = path.join(home, '.claude/projects', encodeCwd(sess.cwd || ''), `${sess.sessionId}.jsonl`)
    if (await exists(direct)) return { file: direct, session: sess.sessionId }
    // Folder encoding different from the assumed one: we look for the file.
    const root = path.join(home, '.claude/projects')
    const f = await firstExisting((await listDir(root)).map(d => path.join(root, d, `${sess.sessionId}.jsonl`)))
    return f ? { file: f, session: sess.sessionId } : null
  }

  async function rolloutMeta(file: string) {
    if (metaCache.has(file)) return metaCache.get(file)
    let meta: Json = null
    try {
      const first = (await fs.read(file, 0, 64 * 1024)).toString('utf8').split('\n')[0]!
      const d = JSON.parse(first)
      if (d.type === 'session_meta') meta = d.payload
    } catch { meta = null }
    // An incomplete line (brand new file): we will retry later.
    if (meta) metaCache.set(file, meta)
    return meta
  }

  // Main Codex conversations (thread_source "user", no parent) of the
  // last three days in `cwd`.
  async function codexRollouts(cwd: string | null) {
    const root = path.join(home, '.codex/sessions')
    const files: string[] = []
    const now = new Date()
    for (let back = 0; back < 3; back++) {
      const d = new Date(now.getTime() - back * 86400000)
      const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      for (const n of await listDir(dir)) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.push(path.join(dir, n))
    }
    const stats = files.length ? await fs.statMany(files) : []
    const out: CodexRollout[] = []
    for (let i = 0; i < files.length; i++) {
      const st = stats[i]
      if (!st) continue
      const meta = await rolloutMeta(files[i]!)
      if (!meta || !meta.id || meta.parent_thread_id || (meta.thread_source && meta.thread_source !== 'user')) continue
      if (cwd && meta.cwd !== cwd) continue
      out.push({ file: files[i]!, id: meta.id, ts: Date.parse(meta.timestamp || 0) || 0, mtimeMs: st.mtimeMs })
    }
    return out
  }

  // Recent Codex (shared app-server, "managed daemon"): the session hook
  // of the Herdr integration runs in the daemon, with the environment of the first
  // Codex that started it; a new Codex's session is then reported to the
  // pane of that first Codex. So we do not trust it blindly: each Codex
  // claims the conversation created right after it appeared (`bornAt`), and a
  // reported session that is another pane's "birth" is ignored.
  async function locateCodexPane(pane: TranscriptPane): Promise<Loc | null> {
    const rolls = await codexRollouts(pane.cwd)
    const birth = (p: TranscriptPane) => {
      if (!p.bornAt) return null
      let best: CodexRollout | null = null
      for (const r of rolls) {
        if (r.ts < p.bornAt - CODEX_BIRTH_BEFORE || r.ts > p.bornAt + CODEX_BIRTH_AFTER) continue
        if (!best || r.ts < best.ts) best = r
      }
      return best
    }
    const others = [...codexPeers.values()].filter(o => o.id !== pane.id && o.agent === 'codex' && o.cwd === pane.cwd)
    const taken = new Set(others.map(o => birth(o)?.id).filter(Boolean) as string[])
    if (pane.agentSession && !taken.has(pane.agentSession)) {
      const f = await findSessionFile('codex', pane.agentSession)
      if (f) return { file: f, session: pane.agentSession }
    }
    // `codex resume <uuid>` can keep writing a rollout created months ago.
    // Missing hooks must not restrict that explicit session to the recent scan.
    // Include it among candidates, rather than pinning it forever: /new can
    // create a newer conversation without changing the process's launch args.
    let resumed: string | null = null
    try {
      const proc = await paneProcess(pane.id, 'codex')
      const args = Array.isArray(proc?.argv) ? proc.argv : []
      const at = args.indexOf('resume')
      const id = at >= 0 ? args[at + 1] : null
      if (typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) {
        const file = await findSessionFile('codex', id)
        const meta = file && await rolloutMeta(file)
        const stat = file ? await fs.stat(file) : null
        if (file && meta?.id === id && stat?.isFile) {
          resumed = id
          rolls.push({ file, id, ts: Date.parse(meta.timestamp || 0) || 0, mtimeMs: stat.mtimeMs })
        }
      }
    } catch { /* process information is optional; retain the recent fallback */ }
    let best: CodexRollout | null = null
    for (const r of rolls) {
      if (taken.has(r.id)) continue
      if (r.id !== resumed && pane.bornAt && r.ts < pane.bornAt - 60000) continue
      if (!best || r.mtimeMs > best.mtimeMs) best = r
    }
    return best && { file: best.file, session: best.id, ...(best.id !== resumed ? { guessed: true } : {}) }
  }

  // Codex panes of the machine (kept up to date by the state): for the claims.
  const codexPeers = new Map<string, TranscriptPane>()
  // Agents seen at work: they have a conversation (see shared/integrations.ts).
  const activity = createActivity()
  function observe(panes: TranscriptPane[]) {
    opencode.observe(panes)
    codexPeers.clear()
    for (const p of panes) if (p.agent === 'codex') codexPeers.set(p.id, p)
    const live = new Set(panes.map(p => p.id))
    activity.prune(id => live.has(id))
    for (const p of panes) activity.observe({ id: p.id, agent: p.agent, status: p.status ?? null })
  }

  // File of a session known by its identifier (Herdr integration).
  const bySession = new Map<string, string>()
  async function findSessionFile(kind: string | null, id: string) {
    const known = bySession.get(id)
    if (known) {
      if (await exists(known)) return known
      bySession.delete(id)
    }
    let found: string | null = null
    if (kind === 'codex') {
      // ~/.codex/sessions/YYYY/MM/DD/rollout-<date>-<id>.jsonl, from newest to oldest.
      const root = path.join(home, '.codex/sessions')
      const sortDesc = async (d: string) => (await listDir(d)).sort().reverse()
      outer:
      for (const y of await sortDesc(root)) {
        for (const m of await sortDesc(path.join(root, y))) {
          for (const d of await sortDesc(path.join(root, y, m))) {
            const dir = path.join(root, y, m, d)
            const hit = (await sortDesc(dir)).find(n => n.endsWith(`-${id}.jsonl`))
            // A folder with that name is not a conversation.
            if (hit && await exists(path.join(dir, hit))) { found = path.join(dir, hit); break outer }
          }
        }
      }
    } else if (kind === 'claude') {
      const root = path.join(home, '.claude/projects')
      found = await firstExisting((await listDir(root)).map(d => path.join(root, d, `${id}.jsonl`)))
    } else if (kind === 'omp') {
      // omp's Herdr integration reports the session path, not an
      // identifier: only an omp session (~/.omp/agent/sessions).
      const f = path.normalize(id)
      if (path.isAbsolute(f) && f.endsWith('.jsonl') && transcriptKind(f) === 'omp' && await exists(f)) found = f
    } else if (kind === 'cmd') {
      // ~/.commandcode/projects/<project-slug>/<session-id>.jsonl. The slug
      // is not reversible (camelCase is split): scan the project folders.
      const root = path.join(home, '.commandcode/projects')
      const sid = path.basename(id).replace(/\.jsonl$/, '')
      found = await firstExisting((await listDir(root)).map(d => path.join(root, d, `${sid}.jsonl`)))
    }
    if (found) bySession.set(id, found)
    return found
  }

  // Command Code has no Herdr session integration yet: find the project by the
  // `cwd` recorded in each session's first line, then the most recently
  // written session there. A resumed session keeps appending to its file, so
  // mtime follows the pane in use; two live panes in the same project would
  // still share the newest file (see docs/conversation.md).
  async function commandCodeSessions() {
    const root = path.join(home, '.commandcode/projects')
    let paths: string[] = []
    // Remote: one `find` for every project, then one batched stat. Listing
    // each project directory separately costs an SSH round-trip per folder.
    if (exec) {
      try {
        const r = await exec('find "$1" -type f -name "*.jsonl" ! -name "*.checkpoints.jsonl" -print', [root], { timeoutMs: 4000 })
        if (r.code === 0) paths = r.stdout.toString('utf8').split('\n').filter(Boolean)
      } catch { paths = [] }
    }
    if (!paths.length) {
      for (const d of await listDir(root)) {
        const dir = path.join(root, d)
        const files = (await listDir(dir)).filter(n => n.endsWith('.jsonl') && !n.endsWith('.checkpoints.jsonl'))
        for (const n of files) paths.push(path.join(dir, n))
      }
    }
    if (!paths.length) return []
    const stats = await fs.statMany(paths)
    const out: { file: string, mtimeMs: number, size: number }[] = []
    for (let i = 0; i < paths.length; i++) if (stats[i]?.isFile) out.push({ file: paths[i]!, mtimeMs: stats[i]!.mtimeMs, size: stats[i]!.size })
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  // First line of every candidate in byte-bounded remote shell passes (one
  // SSH command per batch, not one per session), falling back to local reads.
  // `M` marks a missing file (not a candidate, as on disk); `E` marks a read
  // failure, which must reach locate()'s last-known fallback instead of
  // silently choosing an older session in the same folder.
  async function commandCodeHeaders(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!paths.length) return out
    if (exec) {
      try {
        for (const chunk of chunksByBytes(paths)) {
          const r = await exec(CMD_HEADERS_SCRIPT, chunk, { timeoutMs: 4000 })
          if (r.code !== 0) throw new Error(`header batch failed: ${r.stderr || r.code}`)
          for (const line of r.stdout.toString('utf8').split('\n')) {
            const tab = line.indexOf('\t')
            if (tab <= 0) continue
            const file = line.slice(0, tab)
            const rest = line.slice(tab + 1)
            if (rest === 'E') throw new Error(`read failed: ${file}`)
            if (rest === 'M') continue
            if (rest.startsWith('H')) out.set(file, rest.slice(1))
          }
        }
        return out
      } catch { /* fall back to per-file reads */ }
    }
    for (const p of paths) {
      try { out.set(p, (await fs.read(p, 0, 64 * 1024)).toString('utf8').split('\n')[0]!) } catch (e) {
        if (isMissing(e)) continue
        throw e
      }
    }
    return out
  }

  async function locateCommandCode(pane: TranscriptPane): Promise<Loc | null> {
    if (pane.agentSession) {
      const f = await findSessionFile('cmd', pane.agentSession)
      if (f) return { file: f, session: pane.agentSession }
    }
    if (!pane.cwd) return null
    const sessions = await commandCodeSessions()
    const missing = sessions.filter((s) => {
      const c = cmdHeaders.get(s.file)
      return !(c && c.size === s.size && c.mtimeMs === s.mtimeMs)
    }).map(s => s.file)
    const headers = await commandCodeHeaders(missing)
    // Resolve the complete batch for this pass. The shared cache caps its
    // size, so eviction must not hide a candidate from the selection below
    // (newest-first insertion would otherwise drop the newest headers).
    const resolved = new Map<string, Json | null>()
    for (const s of sessions) {
      const cached = cmdHeaders.get(s.file)
      if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) {
        resolved.set(s.file, cached.cwd === null ? null : { type: 'session', cwd: cached.cwd, id: cached.id })
        continue
      }
      const first = headers.get(s.file)
      if (first === undefined) continue
      try { resolved.set(s.file, JSON.parse(first)) } catch { resolved.set(s.file, null) }
    }
    let best: { file: string, id: string, cwdLength: number } | null = null
    for (const s of sessions) {
      const d = resolved.get(s.file)
      if (!d || d.type !== 'session' || typeof d.cwd !== 'string') continue
      if (d.cwd !== pane.cwd && !pane.cwd.startsWith(d.cwd + '/')) continue
      const hit = { file: s.file, id: typeof d.id === 'string' ? d.id : path.basename(s.file, '.jsonl'), cwdLength: d.cwd.length }
      if (!best || hit.cwdLength > best.cwdLength) best = hit
      if (d.cwd === pane.cwd) break // newest exact match
    }
    // Cache the valid headers now that the choice is made. Insert the oldest
    // first so the cap keeps the recent sessions, and so the next pass does
    // not reread the headers the exact-match break skipped.
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]!
      const d = resolved.get(s.file)
      if (!d || d.type !== 'session' || typeof d.cwd !== 'string') continue
      const cached = cmdHeaders.get(s.file)
      if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) continue
      cmdHeaders.set(s.file, { size: s.size, mtimeMs: s.mtimeMs, cwd: d.cwd, id: typeof d.id === 'string' ? d.id : null })
      if (cmdHeaders.size > 4096) cmdHeaders.delete(cmdHeaders.keys().next().value!)
    }
    return best ? { file: best.file, session: best.id, guessed: true } : null
  }

  // `fresh`: a cached "no file" is not trusted (a brand new Claude writes its
  // transcript with its first message, within those 8 s).
  async function locate(pane: TranscriptPane, fresh = false): Promise<Loc | null> {
    const hit = locCache.get(pane.id)
    if (hit && (hit.loc || !fresh) && Date.now() - hit.at < 8000 && hit.session === pane.agentSession) return hit.loc
    let loc: Loc | null = null
    let failed = false
    try {
      if (pane.agent === 'codex') loc = await locateCodexPane(pane)
      else if (pane.agent === 'cmd') loc = await locateCommandCode(pane)
      else if (pane.agentSession) {
        const f = await findSessionFile(pane.agent, pane.agentSession)
        if (f) loc = { file: f, session: pane.agentSession }
      }
      if (!loc && pane.agent === 'claude') {
        const proc = await paneProcess(pane.id, 'claude')
        if (proc) loc = await locateClaude(proc)
      }
    } catch { failed = true }
    // Failed read (SSH, timeout): we keep the last known file rather
    // than conclude "no conversation" (the view would empty for a second).
    if (failed) {
      const last = lastLoc.get(pane.id)
      return last && (!pane.agentSession || last.session === pane.agentSession) ? last : null
    }
    locCache.set(pane.id, { at: Date.now(), loc, session: pane.agentSession })
    if (loc) lastLoc.set(pane.id, loc)
    return loc
  }

  // ------------------------------------------------------------ reading
  // Reads bytes [start, end) of the file. If `start` falls in the middle of a
  // line, it is skipped: the returned `start` is always a line start. A
  // `start` already at a line start (the byte before is a newline) is kept:
  // re-reading the bottom from a known start must not lose its first message.
  async function readRange(file: string, start: number, end: number) {
    if (start <= 0) return { start: 0, text: (await fs.read(file, 0, end)).toString('utf8') }
    const buf = await fs.read(file, start - 1, end - start + 1)
    const nl = buf.indexOf(0x0a)
    const off = nl < 0 ? buf.length : nl + 1
    return { start: start - 1 + off, text: buf.subarray(off).toString('utf8') }
  }

  // omp session folder, from the file's first line ("session" entry): the
  // slices read further down do not contain it.
  const ompCwds = new Map<string, string>()
  async function ompCwd(file: string): Promise<string> {
    const known = ompCwds.get(file)
    if (known !== undefined) return known
    let cwd = ''
    try {
      const d = JSON.parse((await readRange(file, 0, 4096)).text.split('\n')[0]!)
      if (d && d.type === 'session' && typeof d.cwd === 'string') cwd = d.cwd.replace(/\/+$/, '')
    } catch { /* first line longer than 4 KB or unreadable: paths stay under ~ */ }
    ompCwds.set(file, cwd)
    if (ompCwds.size > 64) ompCwds.delete(ompCwds.keys().next().value!)
    return cwd
  }

  async function anchorAt(file: string, start: number) {
    const s0 = Math.max(0, start - ANCHOR_BYTES)
    return anchorHash(start > 0 ? await fs.read(file, s0, start - s0) : new Uint8Array())
  }

  // Goes back from `end` by windows up to PAGE_ITEMS messages (or the start).
  async function readBackwards(file: string, end: number, kind: string | null): Promise<TailResult> {
    const cwd = kind === 'omp' ? await ompCwd(file) : ''
    let start = end
    let items: ChatItem[] = []
    let queue: ClaudeQueueEntry[] | null = null
    let popped: ClaudeQueueEntry[] | null = null
    let updates: CommandCodeToolUpdate[] = []
    // Command Code's result may sit in the newer window while its call is in
    // the older one: the per-file results map bridges the windows. Other
    // agents never allocate these caches.
    const results = kind === 'cmd' ? cmdResultsFor(file) : undefined
    while (start > 0 && end - start < MAX_READ_BYTES) {
      // Window widened as long as it contains no line start (a
      // multi-MB line: message with images), within the cap.
      let w = WINDOW_BYTES
      let r: { start: number, text: string }
      for (;;) {
        const s0 = Math.max(0, start - w)
        r = await readRange(file, s0, start)
        if (r.start < start || s0 === 0 || w >= MAX_READ_BYTES) break
        w *= 2
      }
      if (r.start === start) break // giant line beyond the cap: stop there
      // Each window is parsed alone; Command Code orphans are carried in the
      // per-file results map, so a later window's call still gets its output.
      const parsed = parseLines(r.text, kind, r.start, home, ompTemplates.list, cwd, results, kind === 'cmd' ? cmdWatchesFor(file) : undefined)
      if (!queue) queue = parsed.queue || [] // the queue lives in the most recent window
      if (!popped) popped = parsed.popped || []
      if (parsed.updates?.length) updates = parsed.updates.concat(updates)
      items = parsed.concat(items)
      start = r.start
      if (items.length >= PAGE_ITEMS) break
    }
    return { start, items, queue: queue || [], popped: popped || [], ...(updates.length ? { updates } : {}) }
  }

  // Bottom of the conversation: from `from` (already shown on the phone) or,
  // on first load, the last PAGE_ITEMS messages. Cached by
  // (file, kind, size, generation, from), when read once the state settled.
  async function tail(file: string, kind: string | null, size: number, gen: string, from: number | null, settled = true): Promise<TailResult> {
    const key = `${file}|${kind}|${from}`
    const c = parseCache.get(key)
    if (c && c.settled && c.size === size && c.gen === gen) return c.r
    let r: TailResult
    if (from !== null && from <= size && size - from <= MAX_READ_BYTES) {
      // One read for the anchor above `from` and the bottom (as readRange: a
      // `from` in the middle of a line skips to the next line start).
      const s0 = Math.max(0, from - ANCHOR_BYTES)
      const buf = await fs.read(file, s0, size - s0)
      const above = buf.subarray(0, from - s0)
      let off = from - s0
      if (from > 0 && above[above.length - 1] !== 0x0a) {
        const nl = buf.indexOf(0x0a, off)
        off = nl < 0 ? buf.length : nl + 1
      }
      const items = parseLines(buf.subarray(off).toString('utf8'), kind, s0 + off, home, ompTemplates.list, kind === 'omp' ? await ompCwd(file) : '', kind === 'cmd' ? cmdResultsFor(file) : undefined, kind === 'cmd' ? cmdWatchesFor(file) : undefined)
      // Start kept even when it moved to the next line: the client then sees a
      // stale anchor (or another start) and reloads from the bottom.
      r = {
        start: from, items, queue: items.queue || [], popped: items.popped || [],
        ...(items.updates?.length ? { updates: items.updates } : {}),
        anchor: off === from - s0 ? anchorHash(above) : '',
      }
    } else {
      r = await readBackwards(file, size, kind)
      r.anchor = await anchorAt(file, r.start)
    }
    parseCache.set(key, { size, gen, settled, r })
    if (parseCache.size > 16) parseCache.delete(parseCache.keys().next().value!)
    return r
  }

  // ------------------------------------------------------------ API
  async function search(pane: TranscriptPane, query: string, deadline: number) {
    if (pane.agent === 'devin') return devin.search(pane, query, deadline)
    if (pane.agent === 'opencode') return opencode.search(pane, query, deadline)
    if (!hasTranscript(pane.agent)) return { hits: [], limited: false, kind: null }
    const loc = await locate(pane)
    if (!loc || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: null }
    // The transcript path tells the real kind (closed agent mislabeled).
    const kind = transcriptKind(loc.file) || pane.agent
    return { ...await searchFile(fs, loc.file, kind, home, query, deadline), kind }
  }

  // opts.since : token of the last state seen ("unchanged" reply if it has not moved)
  // opts.from  : re-read the bottom from this byte (continuity with older pages)
  // opts.before: load the older slice ending at this byte
  // opts.fresh : look for the file again if none was found lately (see locate)
  // opts.anchor: token as the client sent it, for the join check (anchorOf),
  //              when `since` was dropped (list the server no longer knows)
  async function chat(pane: TranscriptPane, options: OpenCodeOptions & { fresh?: boolean } = {}): Promise<ChatResponse> {
    if (pane.agent === 'devin') {
      const r = await devin.chat(pane, { since: options.since, from: typeof options.from === 'number' ? options.from : null, before: typeof options.before === 'number' ? options.before : null, anchor: options.anchor })
      for (const item of r.items || []) if (item.role === 'assistant' && item.ref) replyKeys.set(item, `devin:${r.session}:${item.ref}`)
      return r
    }
    if (pane.agent === 'opencode') {
      const r = await opencode.chat(pane, options)
      for (const item of r.items || []) if (item.role === 'assistant' && item.ref) replyKeys.set(item, `opencode:${r.session}:${item.ref}`)
      return r
    }
    // Numeric offsets remain exclusive to the existing file-backed readers.
    const opts = { ...options, from: typeof options.from === 'number' ? options.from : null, before: typeof options.before === 'number' ? options.before : null }
    if (!hasTranscript(pane.agent)) return { available: false, reason: 'unsupported' }
    const loc = await locate(pane, Boolean(opts.fresh))
    if (!loc) return { available: false, reason: 'not_found' }
    let st
    try { st = await fs.stat(loc.file) }
    catch (e) {
      // Failed read: an error (the client keeps what it shows), not an empty result.
      if (!isMissing(e)) throw e
      st = null
    }
    // Gone, or a folder where the transcript was expected: no conversation.
    if (!st || !st.isFile) {
      locCache.delete(pane.id)
      lastLoc.delete(pane.id)
      return { available: false, reason: 'not_found' }
    }
    const fileId = path.basename(loc.file)
    let cmdInvalidated = false
    if (transcriptKind(loc.file) === 'cmd') {
      // A rewrite/truncation invalidates results remembered for the removed
      // page; a still-growing file keeps them unless the bytes of a retained
      // result changed (an in-place rewrite). Either way the client must
      // rebuild its older pages, which may show the superseded output.
      const prev = cmdSizes.get(loc.file)
      const g = genOf(st)
      const replaced = Boolean(prev) && (
        st.size < prev!.size
        || (prev!.ino !== undefined && st.ino !== undefined && prev!.ino !== st.ino)
        || (st.size === prev!.size && prev!.gen !== g)
      )
      const grewInPlace = Boolean(prev) && st.size > prev!.size && prev!.ino === st.ino
      const verdict = grewInPlace ? await cmdResultsValid(loc.file) : true
      cmdInvalidated = replaced || verdict === false
      if (cmdInvalidated) {
        cmdEpochs.set(loc.file, (cmdEpochs.get(loc.file) ?? 0) + 1)
        forgetCmdFile(loc.file)
      }
      // A failed validation keeps the previous size, so the next poll retries
      // before trusting this state.
      if (verdict !== null) {
        cmdSizes.set(loc.file, { size: st.size, gen: g, ino: st.ino })
        if (cmdSizes.size > 64) evictCmdFile(cmdSizes.keys().next().value!)
      }
    }
    const base = { available: true, file: fileId, session: loc.session, guessed: Boolean(loc.guessed) }
    // The transcript path tells the real kind: a pane whose agent changed while
    // its session stayed must not read the file as another agent's (no message).
    const kind = transcriptKind(loc.file) || pane.agent
    if (kind === 'omp') await refreshOmpTemplates()
    if (opts.before !== null && opts.before !== undefined) {
      const r = await readBackwards(loc.file, Math.min(opts.before, st.size), kind)
      return { ...base, older: true, items: r.items, start: r.start, ...(r.updates?.length ? { toolUpdates: r.updates } : {}) }
    }
    const from = opts.from === undefined ? null : opts.from
    const gen = genOf(st)
    const settled = await settledGen(loc.file, st, gen)
    const epoch = kind === 'cmd' ? cmdEpochs.get(loc.file) ?? 0 : 0
    const sent = opts.anchor ?? opts.since
    const prev = headOf(sent)
    const same = prev !== null && prev.file === fileId
    const sentEpoch = cmdEpochOf(opts.since || opts.anchor)
    const sentReader = cmdReaderOf(opts.since || opts.anchor)
    // A client that did not witness an invalidation (a preview read or
    // another client consumed it), or that outlived a reader restart, still
    // has an older state in its token: rebuild its pages. Cache eviction
    // advances only the evicted transcript's own epoch (see evictCmdFile).
    const readerChanged = kind === 'cmd' && same && sentReader !== readerId
    const staleState = kind === 'cmd' && same && (readerChanged || (sentEpoch === null ? epoch > 0 : sentEpoch !== epoch))
    // Token: file, size, cursor, generation (unchanged as long as these are,
    // once settled), Command Code invalidation generation and reader, then
    // the anchor.
    const head = `${fileId}:${st.size}:${from}:${gen}${settled ? '' : '!'}${epoch ? `@${epoch}` : ''}${kind === 'cmd' ? `%${readerId}` : ''}`
    if (settled && !staleState && opts.since && opts.since.split('/')[0] === head) return { ...base, unchanged: true, token: opts.since }
    let r = await tail(loc.file, kind, st.size, gen, from, settled)
    // The client's list starts at the cursor, and the file was rewritten
    // above it: replaced by another file (inode), shorter, rewritten at the
    // same size (appends always grow it), other bytes just above the cursor
    // (anchor), or no line start there any more. Read back from the end, and
    // say so: the client starts again.
    const at = anchorOf(sent)
    // A list read before its state settled (whole-second mtimes): rewritten
    // within that second if its part of the file changed since.
    const fileRewritten = from !== null && from > 0 && at !== null && at.start === from && (cmdInvalidated
      || r.anchor !== at.hash
      || (same && prev.ino !== null && st.ino !== undefined && prev.ino !== st.ino)
      || (same && st.size < prev.size)
      || (same && st.size === prev.size && prev.gen !== gen)
      || (same && prev.unsettled && !await stillThere(loc.file, prev)))
    const rewritten = staleState || fileRewritten
    if (rewritten) {
      // A stale token only means this client must reload; it must not erase
      // results another client collected from the unchanged transcript.
      if (kind === 'cmd' && fileRewritten) forgetCmdFile(loc.file)
      r = await tail(loc.file, kind, st.size, gen, null, settled)
    }
    const token = r.anchor ? `${head}/${r.start}.${r.anchor}` : head
    return {
      ...base, token, items: r.items, start: r.start, queue: r.queue || [],
      ...(r.popped?.length ? { popped: r.popped } : {}),
      ...(r.updates?.length ? { toolUpdates: r.updates } : {}),
      ...(rewritten ? { rewritten: true } : {}),
    }
  }

  // Agent's last reply, for cards and notifications.
  // A stable message identity lets notifications distinguish a new reply
  // from another poll (or more streamed text in the same reply).
  async function latestReply(pane: TranscriptPane): Promise<{ key: string, text: string } | null> {
    try {
      const r = await chat(pane, {})
      if (!r.available || !r.items) return null
      for (let i = r.items.length - 1; i >= 0; i--) {
        const it = r.items[i]!
        if (it.role === 'assistant' && it.text.trim()) {
          const text = it.text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
          const key = replyKeys.get(it)
          if (key) return { key, text }
        }
      }
    } catch { /* no preview */ }
    return null
  }
  async function preview(pane: TranscriptPane): Promise<string | null> {
    return (await latestReply(pane))?.text ?? null
  }

  // Image no. `index` of the message at `ref` ("start:length"): we re-read
  // that single line and decode the image it contains (base64).
  async function image(pane: TranscriptPane, fileId: string | null, ref: string | null, index: number) {
    if (pane.agent === 'devin') return devin.image(pane, fileId, ref, index)
    if (pane.agent === 'opencode') return opencode.image(pane, fileId, ref, index)
    const loc = await locate(pane)
    if (!loc || path.basename(loc.file) !== fileId) return null
    const m = /^(\d+):(\d+)$/.exec(String(ref || ''))
    if (!m) return null
    const off = Number(m[1])
    const len = Number(m[2])
    if (len > 60 * 1024 * 1024) return null
    let d: Json
    try { d = JSON.parse((await fs.read(loc.file, off, len)).toString('utf8')) }
    catch { return null }
    const img = extractImage(d, index)
    if (!img || !('blob' in img)) return img
    const blob = path.join(home, '.omp/agent/blobs', img.blob)
    try {
      const { size } = await fs.stat(blob)
      return size > 60 * 1024 * 1024 ? null : { type: img.type, body: await fs.read(blob, 0, size) }
    } catch { return null }
  }

  // Last model written in the transcript. Backward reading by windows
  // (up to MODEL_MAX_BYTES), then only the part added since. omp writes its
  // model and its thinking level in separate entries: each is the latest of
  // its kind, so the reading goes on until both are found (`raw`: partial).
  const MODEL_WINDOW = 512 * 1024
  const MODEL_MAX_BYTES = 16 * 1024 * 1024
  const modelCache = new Map<string, { file: string, size: number, raw: ModelInfo | null, info: ModelInfo | null }>()
  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    if (pane.agent === 'devin') return devin.model(pane)
    if (pane.agent === 'opencode') return opencode.model(pane)
    if (!pane.agent || !['claude', 'codex', 'omp', 'cmd'].includes(pane.agent)) return null
    const loc = await locate(pane)
    if (!loc) return null
    // A failed read (SSH dropped, timeout) says nothing about the model: keep
    // the last value of this file, or let the caller keep its own. Only a
    // missing file means "no model".
    const stale = (e: unknown) => {
      if (c && c.file === loc.file) return c.info
      if (isMissing(e)) return null
      throw e
    }
    const c = modelCache.get(pane.id)
    let size: number
    try { size = (await fs.stat(loc.file)).size }
    catch (e) { return stale(e) }
    if (c && c.file === loc.file && c.size === size) return c.info
    const omp = pane.agent === 'omp'
    let raw: ModelInfo | null = null
    let done = size // end of the last complete line (a line being written will be re-read)
    try {
      // Already read up to c.size: only what follows can bring something new. We
      // start from the byte before (the newline): readRange skips the line
      // started at the beginning of the window.
      const floor = c && c.file === loc.file && c.size < size ? c.size : 0
      let end = size
      let w = MODEL_WINDOW
      while (end > floor && size - end < MODEL_MAX_BYTES) {
        const s0 = Math.max(floor ? floor - 1 : 0, end - w)
        const r = await readRange(loc.file, s0, end)
        if (r.start >= end) {
          // No whole line in the window (message with images): we widen it.
          if (s0 <= Math.max(0, floor - 1) || w >= MODEL_MAX_BYTES) break
          w *= 2
          continue
        }
        if (end === size && !r.text.endsWith('\n')) done = size - Buffer.byteLength(r.text.slice(r.text.lastIndexOf('\n') + 1))
        const lines = r.text.split('\n').map(stripBlobs)
        raw = omp ? mergeOmpModel(raw, ompLastModel(lines)) : lastModel(lines, pane.agent)
        if (omp ? ompModelComplete(raw) : raw) break
        end = r.start
      }
      if (floor && c) raw = omp ? mergeOmpModel(raw, c.raw) : raw || c.raw
    } catch (e) { return stale(e) }
    const info = omp ? ompModelResult(raw) : raw
    modelCache.set(pane.id, { file: loc.file, size: done, raw, info })
    return info
  }

  // Command Code: the last assistant turn's model and context, for the
  // composer's status line. `/model` and `/effort` only change the default
  // for new sessions, so this stays a read-only display.
  async function commandCodeStats(pane: TranscriptPane): Promise<{ status: CommandCodeStatus | null, session: string | null }> {
    if (pane.agent !== 'cmd') return { status: null, session: null }
    const loc = await locate(pane)
    if (!loc) return { status: null, session: null }
    let st
    try { st = await fs.stat(loc.file) } catch { return { status: null, session: loc.session } }
    const gen = genOf(st)
    const hit = cmdStatsCache.get(pane.id)
    if (hit && hit.file === loc.file && hit.size === st.size && hit.gen === gen) {
      return { status: hit.stats, session: hit.session }
    }
    const size = st.size
    let context: number | null = null
    let cost: number | null = null
    // A single trailing record (a screenshot, a huge tool result) may be
    // larger than the first window: widen backwards until a complete
    // assistant usage is in view, not just a cut record.
    for (let length = 256 * 1024; ; length *= 2) {
      const start = Math.max(0, size - length)
      let text: string
      try { text = (await fs.read(loc.file, start, size - start)).toString('utf8') } catch { return { status: null, session: loc.session } }
      const from = start > 0 ? text.indexOf('\n') + 1 : 0
      for (const line of text.slice(from).split('\n')) {
        let d: Json
        try { d = JSON.parse(line) } catch { continue }
        if (!d || d.type !== 'message' || !d.message || d.message.role !== 'assistant') continue
        const u = d.usage
        if (u && typeof u === 'object') {
          // `inputTokens` already includes `cacheReadTokens` (a breakdown).
          context = Number(u.inputTokens) || 0
          cost = Number.isFinite(u.costUsd) ? Number(u.costUsd) : null
        }
      }
      if (context !== null || start === 0 || length >= 16 * 1024 * 1024) break
    }
    if (context === null) {
      // Cache the "no usage yet" answer too: a new session with no assistant
      // turn must not rescan the file every five seconds.
      cmdStatsCache.set(pane.id, { file: loc.file, size, gen, stats: null, session: loc.session })
      if (cmdStatsCache.size > 256) cmdStatsCache.delete(cmdStatsCache.keys().next().value!)
      return { status: null, session: loc.session }
    }
    const status: CommandCodeStatus = { contextTokens: context, costUsd: cost }
    cmdStatsCache.set(pane.id, { file: loc.file, size, gen, stats: status, session: loc.session })
    if (cmdStatsCache.size > 256) cmdStatsCache.delete(cmdStatsCache.keys().next().value!)
    return { status, session: loc.session }
  }

  // Tool call waiting for a permission: the last one without a result, read
  // from the end of the transcript (re-read only if the file has grown).
  // `tool`: name shown on screen (omp's dialog title), to pick among parallel calls.
  const PENDING_WINDOW = 1024 * 1024
  const pendingCache = new Map<string, { file: string, size: number, tool: string | null, detail: PromptDetail | null }>()
  async function pendingTool(pane: TranscriptPane, tool: string | null = null): Promise<PromptDetail | null> {
    if (pane.agent !== 'claude' && pane.agent !== 'codex' && pane.agent !== 'omp') return null
    const loc = await locate(pane)
    if (!loc) return null
    let size: number
    try { size = (await fs.stat(loc.file)).size }
    catch { return null }
    const c = pendingCache.get(pane.id)
    if (c && c.file === loc.file && c.size === size && c.tool === tool) return c.detail
    let detail: PromptDetail | null = null
    try {
      const r = await readRange(loc.file, Math.max(0, size - PENDING_WINDOW), size)
      const lines = r.text.split('\n').map(stripBlobs)
      const kind = transcriptKind(loc.file) || pane.agent
      detail = kind === 'codex' ? pendingCodexTool(lines) : kind === 'omp' ? pendingOmpTool(lines, tool) : pendingClaudeTool(lines, home)
    } catch { detail = null }
    pendingCache.set(pane.id, { file: loc.file, size, tool, detail })
    return detail
  }

  // omp: the "ask" call still unanswered (see pendingOmpAsk).
  const askCache = new Map<string, { file: string, size: number, asked: OmpAsked[] }>()
  async function pendingAsk(pane: TranscriptPane): Promise<OmpAsked[]> {
    if (pane.agent !== 'omp') return []
    const loc = await locate(pane)
    if (!loc) return []
    let size: number
    try { size = (await fs.stat(loc.file)).size }
    catch { return [] }
    const c = askCache.get(pane.id)
    if (c && c.file === loc.file && c.size === size) return c.asked
    let asked: OmpAsked[] = []
    try { asked = pendingOmpAsk((await readRange(loc.file, Math.max(0, size - PENDING_WINDOW), size)).text.split('\n').map(stripBlobs)) }
    catch { asked = [] }
    askCache.set(pane.id, { file: loc.file, size, asked })
    return asked
  }

  // Claude: the AskUserQuestion call still unanswered (see pendingClaudeAsk).
  const claudeAskCache = new Map<string, { file: string, size: number, asked: ClaudeAsked[] }>()
  async function pendingClaudeQuestions(pane: TranscriptPane): Promise<ClaudeAsked[]> {
    if (pane.agent !== 'claude') return []
    const loc = await locate(pane)
    if (!loc) return []
    let size: number
    try { size = (await fs.stat(loc.file)).size }
    catch { return [] }
    const c = claudeAskCache.get(pane.id)
    if (c && c.file === loc.file && c.size === size) return c.asked
    let asked: ClaudeAsked[] = []
    try { asked = pendingClaudeAsk((await readRange(loc.file, Math.max(0, size - PENDING_WINDOW), size)).text.split('\n').map(stripBlobs)) }
    catch { asked = [] }
    claudeAskCache.set(pane.id, { file: loc.file, size, asked })
    return asked
  }

  function forget(paneId: string) {
    // File-scoped results/tails stay: another pane may share the session, and
    // a rewrite/truncation invalidates them through cmdSizes anyway.
    locCache.delete(paneId)
    lastLoc.delete(paneId)
    modelCache.delete(paneId)
    pendingCache.delete(paneId)
    askCache.delete(paneId)
    claudeAskCache.delete(paneId)
    cmdStatsCache.delete(paneId)
  }

  return { chat, preview, latestReply, image, forget, locate, model, commandCodeStats, observe, dispose: opencode.dispose, wasActive: activity.was, search, pendingTool, pendingAsk, pendingClaudeQuestions, opencodeModels: opencode.models, opencodePatchModel: opencode.patchModel, opencodePending: opencode.pending, opencodeReplyPermission: opencode.replyPermission, opencodeReplyForm: opencode.replyForm, opencodePermissionMatch: opencode.permissionMatch, opencodeInbox: opencode.inbox, opencodeInboxDelete: opencode.inboxDelete, opencodeShell: opencode.shell, opencodeStatus: opencode.status }
}

export type Transcripts = ReturnType<typeof createTranscripts>
