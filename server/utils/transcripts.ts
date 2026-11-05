import { createHash, type Hash } from 'node:crypto'
import path from 'node:path'
import { imageTagCount } from '../../shared/queuedMatch'
import type { ChatItem, ChatResponse, ClaudeQueueEntry, CommandCodeToolUpdate, ModelInfo, PromptDetail } from '../../shared/types'
import { ompToolCall, ompToolResult, ompUserRun } from './ompTools'
import { pendingClaudeTool, pendingCodexTool, pendingOmpTool } from './promptDetail'
import { type ClaudeAsked, type OmpAsked, pendingClaudeAsk, pendingOmpAsk } from './choices'
import { cleanModelName, lastModel, mergeOmpModel, ompLastModel, ompModelComplete, ompModelLabel, ompModelResult } from './models'
import { type FsStat, type MachineFs, localFs } from './fsx'
import { fingerprintRefs, type CommandCodeResultRef } from './commandCodeWatch'
import { createCommandCodeState, type CommandCodeFileHandle, type CommandCodeObservation } from './commandCodeState'
import { searchFile } from './conversationSearch'
import { hasTranscript, transcriptKind } from '../../shared/agentKind'
import { type CommandTemplate, ompCommandTemplates } from './slash'
import { fmt } from '../../shared/message'
import { pastedBlocks } from '../../shared/pastedText'
import { createActivity } from '../../shared/integrations'
import { createDevinTranscripts } from './devinTranscripts'
import { devinSession } from './devinSessions'

// Backward reading by windows until there are enough messages: Claude's
// transcripts embed images in base64, a few screenshots
// weigh several MB for three lines of conversation.
const WINDOW_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 24 * 1024 * 1024 // per request
const PAGE_ITEMS = 120
const PREVIEW_BYTES = 256 * 1024 // card previews read this much first (latestReply)
const MAX_TEXT = 20000

export interface TranscriptPane {
  id: string
  agent: string | null
  cwd: string | null
  agentSession?: string | null
  bornAt?: number
  status?: string | null
}

export interface Loc { file: string, session: string, guessed?: boolean }
interface CodexRollout { file: string, id: string, ts: number, mtimeMs: number }
// Window in which a Codex's conversation is created around its appearance.
const CODEX_BIRTH_BEFORE = 5000
const CODEX_BIRTH_AFTER = 120000
export type Lines = string[] & { refs?: string[] }
type Parsed = ChatItem[] & { queue?: ClaudeQueueEntry[], popped?: ClaudeQueueEntry[], updates?: CommandCodeToolUpdate[], resultRefs?: CommandCodeResultRef[] }
// `anchor`: fingerprint of the bytes just above `start` (see anchorAt).
interface TailResult { start: number, items: ChatItem[], queue: ClaudeQueueEntry[], popped?: ClaudeQueueEntry[], anchor?: string, updates?: CommandCodeToolUpdate[] }

// Join check of a re-read from a cursor: the bytes just above it, hashed. A
// transcript rewritten at the same size, or shortened but still longer than
// the cursor, keeps the token's size and may keep a line start at the cursor,
// so the client would splice a new bottom under pages of another file. The
// token carries the anchor of its start (`/<start>.<hash>`) and a re-read from
// that start checks it first.
const ANCHOR_BYTES = 4096
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
const HEAD = /^(.*):(\d+):(null|\d+):(?:(\d+)-)?(\d+)(!?)(?=[/~#]|$)/
export function headOf(token: string | null | undefined): { file: string, size: number, from: number | null, ino: number | null, gen: string, unsettled: boolean } | null {
  const m = HEAD.exec(String(token || ''))
  if (!m) return null
  return { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), ino: m[4] ? Number(m[4]) : null, gen: `${m[4] ? `${m[4]}-` : ''}${m[5]}`, unsettled: m[6] === '!' }
}
// Command Code tokens also carry the file's generation stamp and this
// reader's nonce (`~s<stamp>~r<reader>`): a page remembered under another
// generation or another process must never splice under the current one.
const CSTAMP = /~s(\d+)~r([a-z0-9]+)(?=[~/#]|$)/
const tokenStamp = (token: string | null | undefined): { stamp: number, reader: string } | null => {
  const m = CSTAMP.exec(String(token || ''))
  return m ? { stamp: Number(m[1]), reader: m[2]! } : null
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
// For cmd the strip must not turn a rejected payload into an accepted
// empty image: only shapes its filter would accept are emptied — an
// invalid data URL stays verbatim and stays rejected.
export const stripBlobs = (line: string, kind?: string | null) => (line.length > 50000
  ? kind === 'cmd'
    ? line.replace(/"data":"[A-Za-z0-9+/=]{500,}"/g, '"data":""')
      .replace(/"data":"data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]{500,}"/g, '"data":""')
    : line.replace(/"data":"[A-Za-z0-9+/=]{500,}"/g, '"data":""').replace(/"data:image\/[^"]{500,}"/g, '""')
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
  const p = claudeParser(home)
  p.feed(lines)
  return p.result()
}

// Claude's parser, fed line by line: a transcript only grows, so the bottom
// of a conversation is parsed once and each poll feeds only the lines
// appended since (see readTail). Its items keep changing as lines come (a
// tool result marks its call, a "/" command becomes a user message…):
// result() hands out copies, so a list already given never changes. The copy
// of an item is made once and handed out again until the item changes
// (touch): chatDelta signs each copy once.
export type ClaudeParser = ReturnType<typeof claudeParser>
export function claudeParser(home = '') {
  const items: ChatItem[] = []
  const copies = new WeakMap<ChatItem, ChatItem>()
  const touch = (it: ChatItem) => { copies.delete(it) }
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
      touch(open)
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
    // A prompt Claude ran from its queue (promptSource "queued") is never put back into its field.
    lastSaid = item && item.role === 'user' && d.parentUuid && d.promptSource !== 'queued' ? { item, parent: d.parentUuid, uuid: d.uuid } : null
  }
  function feed(lines: Lines) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const ref = lines.refs ? lines.refs[li] : undefined
      if (!line) continue
      let d: Json
      try { d = JSON.parse(line) }
      catch { continue }
      // The sibling must be a new prompt: the result of a cancelled tool call shares the parent too.
      if (lastSaid && d.type === 'user' && !d.isSidechain && d.parentUuid === lastSaid.parent && d.uuid !== lastSaid.uuid
        && !(Array.isArray(d.message?.content) && d.message.content.some((c: Json) => c?.type === 'tool_result'))) {
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
        touch(c)
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
            if (t) touch(t)
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
  }
  function result(): Parsed {
    const out: Parsed = items.map((orig) => {
      let it = copies.get(orig)
      if (it) return it
      it = { ...orig }
      copies.set(orig, it)
      const key = replyKeys.get(orig)
      if (key) replyKeys.set(it, key)
      // Local commands: one "/cmd → useful output" line; the full output stays
      // only when it says more than that line (opened by a tap, see ChatView);
      // screen text copied there alone (no useful line) is dropped.
      if (it.role !== 'cmd') return it
      const line = usefulOutput(it.out, it.err)
      if (line) it.text = `${it.text} → ${line}`
      const full = [it.err, it.out].filter(Boolean).join('\n').trim()
      if (!line || full === line) {
        delete it.out
        delete it.err
      } else {
        if (!it.out) delete it.out
        if (!it.err) delete it.err
      }
      return it
    })
    // Queued task notifications: not user messages.
    out.queue = queue.filter(q => !isNoise(q.text))
    out.popped = [...popped]
    return out
  }
  return { feed, result }
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
  // Only string values are summarized: a malformed field must never throw on
  // String coercion or leak an arbitrary object into the summary.
  const s = (v: unknown) => typeof v === 'string' ? v : ''
  switch (name) {
    case 'shell_command': return firstLine(s(i.description) || s(i.command))
    case 'read_file': case 'write_file': case 'edit_file':
      return firstLine(s(i.file_path) || s(i.path))
    case 'grep': return `${s(i.pattern)}${typeof i.path === 'string' && i.path ? ` · ${i.path}` : ''}`
    case 'glob': return firstLine(s(i.pattern))
    case 'agent': return firstLine(s(i.description) || s(i.prompt))
    case 'ask_user_question': return firstLine(s(Array.isArray(i.questions) ? i.questions[0]?.question : ''))
    case 'search_tools': return firstLine(s(i.query))
    default: {
      const v = Object.values(i).find(x => typeof x === 'string')
      return firstLine(v)
    }
  }
}

// Outcome remembered for a call whose tool_use is in an older page than the
// tool_result being parsed (see commandCodeParser). `at` is the result's
// absolute byte offset: the revision chronology compares, never arrival
// order. Images and the result watch fields arrive with their tasks.
export type CommandCodeResult = { out?: string, error?: boolean, images?: number, ref?: string, imageAt?: number, at?: number }

// Ids live in the bounded maps across parses: cap their bytes (a transcript
// can carry an arbitrarily large one). An oversized id is rejected on call
// and result alike — never truncated into a false match.
const CMD_ID_MAX = 128
const CMD_NAME_MAX = 100
const cmdId = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= CMD_ID_MAX ? v : null

// State of an incremental Command Code parse (see commandCodeParser):
// the items of the bottom fed so far, their served copies, the retained
// call index, the outcome bookkeeping, and the opt-in cross-page map.
interface CmdParseState {
  items: ChatItem[]
  copies: WeakMap<ChatItem, ChatItem>
  tools: Map<string, ChatItem>
  // Outcomes already on the wire per id: a repeat of the same revision must
  // not amplify into repeated serialized updates, a changed outcome at the
  // same offset (a rewritten record) still emits.
  emitted: Map<string, CommandCodeToolUpdate>
  pending: Map<string, CommandCodeToolUpdate>
  updates: CommandCodeToolUpdate[]
  // The cross-page orphan map is opt-in: without it a result before its
  // call is dropped for this parse, exactly as a lone window always was.
  results?: Map<string, CommandCodeResult>
  // Absolute positions of the result records parsed since the last result()
  // — reader metadata for raw watch registration, drained once with the
  // items, newest absolute offset per id (an equal offset may hold a
  // changed record), bounded like the watch map.
  resultRefs: Map<string, CommandCodeResultRef>
}

// Chronology on absolute result byte offsets (`at`): an outcome replaces
// only an equal-or-older one, whichever order pages were parsed in.
const cmdNewer = (at: number | undefined, was: number | undefined) => (at ?? -Infinity) >= (was ?? -Infinity)
// Absolute position of a "start:length" ref: both halves well-formed,
// non-negative safe integers and the record's end still on the number
// line — anything else is no position at all (an impossible extent is
// never revision or watch metadata), never a NaN/Infinity offset on the
// wire or in the maps.
const cmdRefPos = (ref: string | undefined): { at: number, len: number } | null => {
  const m = ref && /^(\d+):(\d+)$/.exec(ref)
  if (!m) return null
  const at = Number(m[1])
  const len = Number(m[2])
  return at >= 0 && len >= 0 && Number.isSafeInteger(at) && Number.isSafeInteger(len) && Number.isSafeInteger(at + len) ? { at, len } : null
}

// Apply a result to a call item, if it is not older than what is shown.
function cmdApply(p: CmdParseState, t: ChatItem, rec: CommandCodeResult) {
  if (!cmdNewer(rec.at, t.toolAt)) return
  p.copies.delete(t)
  t.out = rec.out
  t.error = rec.error || undefined
  t.images = rec.images
  t.ref = rec.ref
  t.imageAt = rec.imageAt
  if (rec.at !== undefined) t.toolAt = rec.at
}

// One update per id per feed, carrying the newest absolute revision.
function cmdEmit(p: CmdParseState, id: string, rec: CommandCodeResult) {
  const u: CommandCodeToolUpdate = { id, out: rec.out ?? '', error: rec.error === true, images: rec.images ?? 0, ref: rec.ref ?? '', imageAt: rec.imageAt ?? 0 }
  if (rec.at !== undefined) u.at = rec.at
  const was = p.pending.get(id)
  if (was && !cmdNewer(u.at, was.at)) return
  if (was) p.pending.delete(id)
  p.pending.set(id, u)
}

// The normalized outcome an update carries, without its revision: two
// updates of one revision differ only by this (a record rewritten in place).
const cmdSame = (a: CommandCodeToolUpdate, b: CommandCodeToolUpdate) =>
  a.out === b.out && a.error === b.error && a.images === b.images && a.ref === b.ref && a.imageAt === b.imageAt

// Command Code's parser, fed complete lines appended to a transcript: each
// poll feeds only the new lines (a transcript grows); old lines are never
// re-parsed. `tools` indexes retained calls for constant-time result
// matching — its entries live and die with their items (see drop), never
// with the separate bounded orphan-outcome map (`results`). Served items
// are immutable: result() hands out copies made once per item (chatDelta
// signs each); an outcome applied to a call already served touches it, so
// the next result() returns a fresh object while served ones never change.

function feedCommandCode(p: CmdParseState, lines: Lines) {
  const { items, tools, results } = p
  for (let i = 0; i < lines.length; i++) {
    let d: Json
    try { d = JSON.parse(lines[i]!) } catch { continue }
    if (!d || d.type !== 'message' || !d.message || typeof d.message !== 'object') continue
    const m = d.message
    const ref = lines.refs?.[i]
    const v = m.meta?.createdAt
    const ts = typeof d.timestamp === 'string' ? d.timestamp
      : Number.isFinite(v) && Math.abs(v) <= 8.64e15 ? new Date(v).toISOString() : null
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        if (m.content.trim()) items.push(replyItem({ role: 'assistant', text: clip(m.content), ts }, ref))
        continue
      }
      const content = Array.isArray(m.content) ? m.content : []
      let lastText: ChatItem | null = null
      let own = 0
      for (const [block, part] of content.entries()) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
          items.push({ role: 'thinking', text: clip(part.thinking), ts })
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          lastText = replyItem({ role: 'assistant', text: clip(part.text), ts }, ref, block)
          items.push(lastText)
        } else if (part.type === 'tool_use') {
          const id = cmdId(part.id)
          if (!id) continue
          const raw = typeof part.name === 'string' ? part.name : 'Tool'
          const t: ChatItem = { role: 'tool', name: clip(raw, CMD_NAME_MAX), toolId: id, text: clip(commandCodeTool(raw, part.input), 300), ts }
          // Its result may have been parsed in a newer page (a page
          // boundary between the call and the result): the remembered
          // outcome applies — then the page's own older result cannot.
          const saved = results?.get(id)
          if (saved) {
            t.out = saved.out
            t.error = saved.error || undefined
            t.images = saved.images
            t.ref = saved.ref
            t.imageAt = saved.imageAt
            if (saved.at !== undefined) t.toolAt = saved.at
          }
          tools.set(id, t)
          items.push(t)
        } else if (part.type === 'image' && cmdLineImage(part)) {
          own++
        }
      }
      // All accepted own images of the message form one ordered group on
      // its last text reply (Copy/Reply identity stays the text's); with
      // no text they are a single image reply — indices are the line's.
      if (own) {
        if (lastText) { lastText.images = own; lastText.ref = ref }
        else items.push(replyItem({ role: 'assistant', text: '', images: own, ref, ts }, ref))
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
      if (text && !hidden && (source === 'user' || !source)) items.push({ role: 'user', text: clip(text), ts })
      continue
    }
    if (!Array.isArray(content)) continue
    let text = ''
    let images = 0
    // Accepted images of a line are ordered own-first then per tool result
    // (lineImages): the offset starts at the count of accepted own images
    // and runs through every result, matched or not.
    let toolImages = content.reduce((n, p) => n + (p && cmdLineImage(p) ? 1 : 0), 0)
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') {
        text += (text ? '\n' : '') + part.text
      } else if (part.type === 'image') {
        if (cmdLineImage(part)) images++
      } else if (part.type === 'tool_result') {
        const n = Array.isArray(part.content) ? part.content.reduce((s: number, q: Json) => s + (q && cmdLineImage(q) ? 1 : 0), 0) : 0
        const id = cmdId(part.tool_use_id)
        if (!id) { toolImages += n; continue }
        const out = commandCodeText(part.content)
        // A result is the complete replacement of what the call showed: an
        // empty or successful one clears out/error/images instead of
        // preserving them. `at` is its absolute position: its revision.
        const pos = cmdRefPos(ref)
        const rec: CommandCodeResult = { out: out ? clip(out, 8000) : undefined, error: part.is_error === true, at: pos?.at }
        // The record's own raw position, for the reader's result watch:
        // newest absolute offset per id — an equal offset may hold a
        // changed record. Bounded like the watch map; drained by result().
        if (pos) {
          const was = p.resultRefs.get(id)
          if (!was || pos.at >= was.at) {
            p.resultRefs.set(id, { id, at: pos.at, len: pos.len })
            if (p.resultRefs.size > 4096) p.resultRefs.delete(p.resultRefs.keys().next().value!)
          }
        }
        if (n && ref) {
          rec.images = n
          rec.ref = ref
          if (toolImages) rec.imageAt = toolImages
        }
        const t = tools.get(id)
        if (results) {
          // The newest known outcome wins — this feed's record, the shared
          // entry, or the outcome already shown on the call itself: a shared
          // eviction must not let an older record downgrade other parsers.
          const saved = results.get(id)
          const shown: CommandCodeResult | undefined = t && t.toolAt !== undefined
            ? { out: t.out, error: t.error === true, images: t.images, ref: t.ref, imageAt: t.imageAt, at: t.toolAt }
            : undefined
          let best = rec
          if (saved && !cmdNewer(best.at, saved.at)) best = saved
          if (shown && !cmdNewer(best.at, shown.at)) best = shown
          if (best !== saved) {
            results.set(id, best)
            if (results.size > 4096) results.delete(results.keys().next().value!)
            // The call may already be shown in an older page the client
            // loaded: send the complete outcome so it updates — or clears.
            if (!t) cmdEmit(p, id, best)
          }
        }
        // Apply the newest outcome known for this call: the shared map may
        // hold one another parser stored later than this feed's record.
        if (t) cmdApply(p, t, results?.get(id) ?? rec)
        toolImages += n
      }
    }
    const human = !hidden && (source === 'user' || (!source && !content.some((p: Json) => p && p.type === 'tool_result')))
    if (human && (text.trim() || images)) items.push({ role: 'user', text: clip(text.trim()), ...(images ? { images, ref } : {}), ts })
  }
}

export type CommandCodeParser = ReturnType<typeof commandCodeParser>
export function commandCodeParser(shared?: Map<string, CommandCodeResult>) {
  const p: CmdParseState = {
    items: [],
    copies: new WeakMap(),
    tools: new Map(),
    emitted: new Map(),
    pending: new Map(),
    updates: [],
    results: shared,
    resultRefs: new Map(),
  }

  // Items below `n` left the bottom (the reader's window slid): their calls
  // leave the index with them; a later result then reports as an update.
  function drop(n: number) {
    const gone = new Set(p.items.splice(0, n))
    if (!gone.size) return
    for (const [id, t] of p.tools) if (gone.has(t)) p.tools.delete(id)
  }

  function result(): Parsed {
    // Only a revision the wire has not carried crosses into the updates: a
    // newer offset, or the same offset holding a different outcome.
    for (const u of p.pending.values()) {
      const e = p.emitted.get(u.id)
      if (u.at === undefined || e === undefined || u.at > (e.at ?? -Infinity) || (u.at === e.at && !cmdSame(u, e))) {
        p.updates.push(u)
        if (u.at !== undefined) p.emitted.set(u.id, u)
      }
    }
    p.pending.clear()
    while (p.emitted.size > 4096) p.emitted.delete(p.emitted.keys().next().value!)
    const out: Parsed = p.items.map((orig) => {
      let it = p.copies.get(orig)
      if (it) return it
      it = { ...orig }
      p.copies.set(orig, it)
      const key = replyKeys.get(orig)
      if (key) replyKeys.set(it, key)
      return it
    })
    if (p.updates.length) out.updates = p.updates.splice(0)
    if (p.resultRefs.size) {
      out.resultRefs = [...p.resultRefs.values()]
      p.resultRefs.clear()
    }
    return out
  }
  return { feed: (lines: Lines) => feedCommandCode(p, lines), result, drop }
}

// Stateless whole-lines parse: one feed of the window given. `updates`:
// late outcomes for calls outside the parse (ChatResponse.toolUpdates).
export function parseCommandCode(lines: Lines, results?: Map<string, CommandCodeResult>, updates?: CommandCodeToolUpdate[]): Parsed {
  const p = commandCodeParser(results)
  p.feed(lines)
  const out = p.result()
  if (updates && out.updates) updates.push(...out.updates)
  return out
}

// `base`: position (in bytes) of `text` in the file. Each line keeps
// its "start:length" position (lines.refs): messages with images
// carry it, to re-read the image on demand (see image()).
const parseKind = (lines: Lines, kind: string | null, home: string, templates?: readonly CommandTemplate[], cwd = '', cmd?: { results?: Map<string, CommandCodeResult>, updates?: CommandCodeToolUpdate[] }) =>
  kind === 'omp' ? parseOmp(lines, home, templates, cwd) : kind === 'codex' ? parseCodex(lines) : kind === 'cmd' ? parseCommandCode(lines, cmd?.results, cmd?.updates) : parseClaude(lines, home)

// Complete lines kept from one read to the next (see readTail): their
// positions, the lines without their base64, and the content hashes of their
// images (as parseLines gives them).
interface LineStore { lines: Lines & { refs: string[] }, hashes: Map<string, string[]>, keep: boolean }
export function storeLines(store: LineStore, text: string, base: number, kind?: string | null): Lines {
  const added: Lines = []
  added.refs = []
  let off = base
  for (const l of text.split('\n')) {
    const n = Buffer.byteLength(l)
    const ref = `${off}:${n}`
    off += n + 1
    const h = lineImageHashes(l, kind)
    if (h.length) store.hashes.set(ref, h)
    added.push(stripBlobs(l, kind))
    added.refs.push(ref)
  }
  if (store.keep) {
    for (const l of added) store.lines.push(l)
    for (const r of added.refs) store.lines.refs.push(r)
  }
  return added
}
export function withHashes(items: ChatItem[], hashes: Map<string, string[]>) {
  for (const it of items) {
    if (!it.images || !it.ref) continue
    const all = hashes.get(it.ref)
    if (!all) continue
    const at = it.imageAt || 0
    const own = all.slice(at, at + it.images)
    if (own.length === it.images) it.hashes = own
  }
}

export function parseLines(text: string, kind: string | null, base = 0, home = '', templates?: readonly CommandTemplate[], cwd = '', cmdResults?: Map<string, CommandCodeResult>): Parsed {
  const raw = text.split('\n')
  const refs: string[] = []
  let off = base
  for (const l of raw) {
    const n = Buffer.byteLength(l)
    refs.push(`${off}:${n}`)
    off += n + 1
  }
  const lines: Lines = raw.map(l => stripBlobs(l, kind))
  lines.refs = refs
  const cmdUpdates: CommandCodeToolUpdate[] = []
  const items = parseKind(lines, kind, home, templates, cwd, { results: cmdResults, updates: cmdUpdates })
  if (cmdUpdates.length) items.updates = cmdUpdates
  // Content hash of each image, to spot one shown twice (see shared/imageDupes.ts).
  const byRef = new Map<string, number>()
  refs.forEach((r, i) => byRef.set(r, i))
  // A ref's hash list is computed once per parse however many items carry
  // its images — for cmd each lookup pays a whole-line digest for its key.
  const hashed = new Map<string, string[]>()
  for (const it of items) {
    if (!it.images || !it.ref) continue
    let all = hashed.get(it.ref)
    if (!all) {
      const i = byRef.get(it.ref)
      if (i === undefined) continue
      all = lineImageHashes(raw[i]!, kind)
      hashed.set(it.ref, all)
    }
    const at = it.imageAt || 0
    const own = all.slice(at, at + it.images)
    if (own.length === it.images) it.hashes = own
  }
  return items
}

// A message the user typed: where a Codex or omp turn starts (see lastTurn).
export function turnStart(line: string, kind: string | null): boolean {
  if (!line.includes('"user"')) return false
  let d: Json
  try { d = JSON.parse(line) } catch { return false }
  if (kind === 'omp') return d?.type === 'message' && d.message?.role === 'user' && !d.message.synthetic && d.message.attribution !== 'agent'
  return d?.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'user'
}

// Hashes are cached per line: transcripts only grow, a line never changes,
// and its multi-MB base64 is decoded and hashed once, not at every poll.
const HASH_CACHE_MAX = 2000
const hashCache = new Map<string, string[]>()
export function lineImageHashes(line: string, kind?: string | null): string[] {
  // The compact precheck matches how Claude/Codex/omp writers serialize; cmd
  // transcripts may pretty-print `"type" : "image"`, so it uses a looser gate.
  if (kind === 'cmd' ? !line.includes('"image"') : !line.includes('"type":"image"') && !line.includes('"input_image"')) return []
  // The legacy key is approximate (length + first/last 200 chars): two large
  // images differing only in the middle would collide. cmd needs exact
  // identity — a digest of the whole line, never a retained payload.
  const key = kind === 'cmd'
    ? `c:${createHash('sha256').update(line).digest('hex')}`
    : `${line.length}:${line.slice(0, 200)}:${line.slice(-200)}`
  const hit = hashCache.get(key)
  if (hit) return hit
  let hashes: string[] = []
  try {
    hashes = lineImages(JSON.parse(line), kind).map(img => 'blob' in img ? img.blob : createHash('sha256').update(Buffer.from(img.data, 'base64')).digest('hex'))
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
// Command Code accepts inline image payloads only — positive base64 or
// data-URL shape, never a storage key, file/URL or path. Nothing a record
// says can make this open a filesystem or network resource, so it can't
// reach omp's blob store either. `''` counts: stripBlobs empties a large
// payload before parse but the image's position survives.
const B64 = /^[A-Za-z0-9+/=]*$/
const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.*)$/
// One accepted-image rule shared by parse counting, hashing and extraction:
// `{type:'image', source:{type:'base64', data}}` (Claude's shape) or flat
// `{type:'image', data}` as inline base64 or a data: URL.
function cmdLineImage(p: Json): LineImage | null {
  if (!p || typeof p !== 'object' || p.type !== 'image') return null
  if (p.source && typeof p.source === 'object' && !Array.isArray(p.source)) {
    const s = p.source
    return s.type === 'base64' && typeof s.data === 'string' && B64.test(s.data)
      ? { type: typeof s.media_type === 'string' ? s.media_type : 'image/png', data: s.data } : null
  }
  if (typeof p.data !== 'string') return null
  const mm = DATA_URL.exec(p.data)
  if (mm && mm[2] !== undefined) return B64.test(mm[2]) ? { type: mm[1]!, data: mm[2] } : null
  return B64.test(p.data)
    ? { type: typeof p.mimeType === 'string' ? p.mimeType : 'image/png', data: p.data } : null
}
// Images of a line, in the order of the `i` of /api/chat/image.
// A malformed record (`null`, a number, an array) carries no images.
function lineImages(d: Json, kind?: string | null): LineImage[] {
  const found: LineImage[] = []
  if (!d || typeof d !== 'object' || Array.isArray(d)) return found
  if (kind === 'cmd') {
    // Exactly what parseCommandCode reads: the message's own images first,
    // then each tool result's accepted images. attachment/payload metadata
    // is not part of cmd messages and cannot shift these indices.
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : null
    for (const p of content || []) {
      const img = cmdLineImage(p)
      if (img) found.push(img)
    }
    for (const p of content || []) {
      if (p && p.type === 'tool_result' && Array.isArray(p.content)) {
        for (const q of p.content) {
          const img = cmdLineImage(q)
          if (img) found.push(img)
        }
      }
    }
    return found
  }
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
export function extractImage(d: Json, index: number, kind?: string | null): TranscriptImage | null {
  const img = lineImages(d, kind)[index]
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

export function createTranscripts({ home, herdr, fs = localFs, now = Date.now, locateCommandCode }: { home: string, herdr: HerdrCall, fs?: MachineFs, now?: () => number, locateCommandCode?: (pane: TranscriptPane) => Promise<Loc | null> }) {
  const devin = createDevinTranscripts({ home, fs, now })
  // Command Code file generations of this machine (see commandCodeState):
  // cross-page outcomes, result-record watches, the trusted stat, the
  // invalidation stamps and the reader nonce client tokens carry.
  const cmd = createCommandCodeState({ fs })
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
  // Command Code replies bound to their generation (see withGen): the
  // file the reply was read from and an origin-bound live predicate.
  // Stamps are reader-local — a foreign reader's contexts never match.
  const contexts = new WeakMap<ChatResponse, { file: string, live: () => boolean }>()
  // Latest observed Command Code selection per pane: each lookup takes an
  // opaque ticket, so a lookup started before a forget (or a reused pane
  // id) can never carry a ticket that is reissued — a late stale lookup
  // never overwrites a newer observation. Publication guard only (see
  // live) — never a locator or cache fallback.
  const selections = new Map<string, { ticket: object, file: string | null }>()
  const selSeq = new Map<string, object>()
  const parseCache = new Map<string, { size: number, gen: string, settled: boolean, r: TailResult, stamp?: number }>()
  const tailReads = new Map<string, Promise<TailResult>>()
  const previewCache = new Map<string, { size: number, gen: string, reply: { key: string, text: string } }>()
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
    return match || (kind === 'devin' ? null : procs[0]) || null
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
    }
    if (found) bySession.set(id, found)
    return found
  }

  // `fresh`: a cached "no file" is not trusted (a brand new Claude writes its
  // transcript with its first message, within those 8 s).
  async function locate(pane: TranscriptPane, fresh = false): Promise<Loc | null> {
    // Command Code resolves through the machine's census-backed helper —
    // never the pane-id/session caches, and never agentSession. Any earlier
    // legacy entry for this pane is dropped so a later agent transition
    // cannot resurrect it; a failed/unavailable lookup is "no location",
    // not the failed-read path that preserves lastLoc. Without the callback
    // there is no evidence at all: null.
    if (pane.agent === 'cmd') {
      locCache.delete(pane.id)
      lastLoc.delete(pane.id)
      const ticket = {}
      selSeq.set(pane.id, ticket)
      const l = locateCommandCode ? await locateCommandCode(pane).catch(() => null) : null
      if (selSeq.get(pane.id) === ticket) selections.set(pane.id, { ticket, file: l?.file ?? null })
      return l
    }
    const hit = locCache.get(pane.id)
    if (hit && (hit.loc || !fresh) && Date.now() - hit.at < (pane.agent === 'devin' ? 1500 : 8000) && hit.session === pane.agentSession) return hit.loc
    let loc: Loc | null = null
    let failed = false
    try {
      if (pane.agent === 'devin') {
        const proc = await paneProcess(pane.id, 'devin')
        const id = proc ? await devinSession(fs, home, proc, fs === localFs) : pane.agentSession
        const file = id && devin.pathOf(id)
        if (file) loc = { file, session: id! }
      } else if (pane.agent === 'codex') loc = await locateCodexPane(pane)
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
  // A raw range — generation-bound when a Command Code context is given:
  // the helper then owns exact coverage and post-await currency, and null
  // is unknown (failed, short or detached), rejected so no parse, cache or
  // epoch advances on it. Without `ctx` this is a plain fs.read.
  async function cmdRead(file: string, start: number, len: number, ctx?: { stamp: number }): Promise<Buffer> {
    if (!ctx) return fs.read(file, start, len)
    const buf = await cmd.io.readExact(file, start, len, ctx.stamp)
    if (!buf) throw new Error('command code transcript read unknown')
    return buf
  }
  // Reads bytes [start, end) of the file. If `start` falls in the middle of a
  // line, it is skipped: the returned `start` is always a line start. A
  // `start` already at a line start (the byte before is a newline) is kept:
  // re-reading the bottom from a known start must not lose its first message.
  // `buf` is the fetched window itself (its first byte is absolute offset
  // `bufStart`): Command Code result positions are fingerprinted against
  // these bytes — never a re-encoded copy of a line.
  async function readRange(file: string, start: number, end: number, ctx?: { h: CommandCodeFileHandle, stamp: number }) {
    if (start <= 0) {
      const buf = await cmdRead(file, 0, end, ctx)
      return { start: 0, bufStart: 0, buf, text: buf.toString('utf8') }
    }
    const buf = await cmdRead(file, start - 1, end - start + 1, ctx)
    const nl = buf.indexOf(0x0a)
    const off = nl < 0 ? buf.length : nl + 1
    return { start: start - 1 + off, bufStart: start - 1, buf, text: buf.subarray(off).toString('utf8') }
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

  async function anchorAt(file: string, start: number, ctx?: { h: CommandCodeFileHandle, stamp: number }) {
    const s0 = Math.max(0, start - ANCHOR_BYTES)
    // Command Code: the anchor read is generation-bound and exact — a short
    // one is unknown, never a minted join point that would later mislabel
    // the page and force a false rewrite.
    const buf = start > 0 ? await cmdRead(file, s0, start - s0, ctx) : new Uint8Array()
    return anchorHash(buf)
  }

  // Goes back from `end` by windows up to PAGE_ITEMS messages (or the start).
  // `ctx`: the Command Code file's captured generation — each window feeds
  // the shared outcome map and fingerprints its result records on the raw
  // bytes it was read from, before they are dropped.
  async function readBackwards(file: string, end: number, kind: string | null, ctx?: { h: CommandCodeFileHandle, stamp: number }): Promise<TailResult> {
    const cwd = kind === 'omp' ? await ompCwd(file) : ''
    let start = end
    let items: ChatItem[] = []
    let queue: ClaudeQueueEntry[] | null = null
    let popped: ClaudeQueueEntry[] | null = null
    // Cross-page outcomes gathered over all windows: the newest absolute
    // offset wins, whichever order windows were walked in.
    const updates = new Map<string, CommandCodeToolUpdate>()
    while (start > 0 && end - start < MAX_READ_BYTES) {
      // Window widened as long as it contains no line start (a
      // multi-MB line: message with images). The issued window never
      // exceeds this request's remaining span: a line longer than the
      // cap must not parse by overshooting it.
      let w = WINDOW_BYTES
      let r: Awaited<ReturnType<typeof readRange>>
      for (;;) {
        const s0 = Math.max(0, start - Math.min(w, MAX_READ_BYTES - (end - start)))
        r = await readRange(file, s0, start, ctx)
        if (r.start < start || s0 === 0 || start - s0 >= MAX_READ_BYTES - (end - start)) break
        w *= 2
      }
      if (r.start === start) break // giant line beyond the cap: stop there
      // Each window is parsed alone (a tool result in error whose
      // call is in the previous window just loses its red mark).
      const parsed = parseLines(r.text, kind, r.start, home, ompTemplates.list, cwd, ctx?.h.results)
      for (const u of parsed.updates || []) {
        const was = updates.get(u.id)
        if (!was || cmdNewer(u.at, was.at)) { updates.delete(u.id); updates.set(u.id, u) }
      }
      if (ctx && parsed.resultRefs) for (const x of fingerprintRefs(r.buf, r.bufStart, parsed.resultRefs)) ctx.h.watch(x.id, x)
      if (!queue) queue = parsed.queue || [] // the queue lives in the most recent window
      if (!popped) popped = parsed.popped || []
      items = parsed.concat(items)
      start = r.start
      if (items.length >= PAGE_ITEMS) break
    }
    return { start, items, queue: queue || [], popped: popped || [], ...(updates.size ? { updates: [...updates.values()] } : {}) }
  }

  // Bottom of the conversation: from `from` (already shown on the phone) or,
  // on first load, the last PAGE_ITEMS messages. Cached by
  // (file, kind, size, generation, from), when read once the state settled.
  // Reads in progress are shared: several devices on one pane cost one read
  // and one parse per change.
  // `ctx` (Command Code): the captured file handle and stamp of the
  // generation this tail serves. A read that publishes must still be the
  // file's current generation — never cross-generation state.
  async function tail(file: string, kind: string | null, size: number, gen: string, from: number | null, settled = true, ino?: number, ctx?: { h: CommandCodeFileHandle, stamp: number }): Promise<TailResult> {
    const key = `${file}|${kind}|${from}`
    const c = parseCache.get(key)
    // A hit must also still be the file's live generation: a page cached
    // under a since-detached stamp is another transcript's state.
    if (c && c.settled && c.size === size && c.gen === gen && (!ctx || (c.stamp === ctx.stamp && cmd.io.live(file, ctx.stamp)))) return c.r
    const flight = `${key}|${size}|${gen}${ctx ? `|${ctx.stamp}` : ''}`
    let read = tailReads.get(flight)
    if (!read) {
      read = readTail(file, kind, size, from, ino, ctx).finally(() => { tailReads.delete(flight) })
      tailReads.set(flight, read)
    }
    const r = await read
    // The file's generation must not have moved under the read: a page
    // parsed from detached bytes is another transcript's state.
    if (ctx && !cmd.io.live(file, ctx.stamp)) throw new Error('command code transcript generation changed')
    parseCache.set(key, { size, gen, settled, r, stamp: ctx?.stamp })
    if (parseCache.size > 16) parseCache.delete(parseCache.keys().next().value!)
    return r
  }
  async function readTail(file: string, kind: string | null, size: number, from: number | null, ino?: number, ctx?: { h: CommandCodeFileHandle, stamp: number }): Promise<TailResult> {
    if (from !== null && from <= size && size - from <= MAX_READ_BYTES) {
      // Cmd bottoms serialize per captured generation (legacy key
      // unchanged): a fresh one never waits on stale detached IO.
      const k = ctx ? `${file}|${kind}|${from}|${ctx.stamp}` : `${file}|${kind}|${from}`
      return await locked(k, () => readBelow(file, kind, size, from, ino, ctx))
    }
    const r = await readBackwards(file, size, kind, ctx)
    r.anchor = await anchorAt(file, r.start, ctx)
    return r
  }
  // The whole bottom from `from`, read and parsed again.
  async function readSlice(file: string, kind: string | null, size: number, from: number, ctx?: { h: CommandCodeFileHandle, stamp: number }): Promise<TailResult> {
    // One read for the anchor above `from` and the bottom (as readRange: a
    // `from` in the middle of a line skips to the next line start).
    const s0 = Math.max(0, from - ANCHOR_BYTES)
    const buf = await cmdRead(file, s0, size - s0, ctx)
    const above = buf.subarray(0, from - s0)
    let off = from - s0
    if (from > 0 && above[above.length - 1] !== 0x0a) {
      const nl = buf.indexOf(0x0a, off)
      off = nl < 0 ? buf.length : nl + 1
    }
    const items = parseLines(buf.subarray(off).toString('utf8'), kind, s0 + off, home, ompTemplates.list, kind === 'omp' ? await ompCwd(file) : '', ctx?.h.results)
    if (ctx && items.resultRefs) for (const x of fingerprintRefs(buf, s0, items.resultRefs)) ctx.h.watch(x.id, x)
    // Start kept even when it moves to the next line: the client then sees a
    // stale anchor (or another start) and reloads from the bottom.
    if (ctx && !cmd.io.live(file, ctx.stamp)) throw new Error('command code transcript generation changed')
    return { start: from, items, queue: items.queue || [], popped: items.popped || [], anchor: off === from - s0 ? anchorHash(above) : '', ...(items.updates?.length ? { updates: items.updates } : {}) }
  }

  // Bottom below a client's cursor, kept between polls: while an agent
  // writes, each poll reads only the bytes appended since (and the few KB
  // around to check the rest is still there) instead of everything from the
  // cursor. Claude's new lines are parsed alone (claudeParser); Codex's and
  // omp's are kept and their last turn parsed again (see lastTurn). omp
  // rewrites its file (retries, see ompTurnEnd): all its bytes below the
  // cursor are checked, not only the last CHECK_BYTES.
  interface Below extends LineStore {
    ino?: number
    start: number // first line start at or after the cursor
    end: number // after the last complete line read
    above: string // anchorHash of the bytes above the cursor
    aligned: boolean // the cursor is a line start
    check: string // anchorHash of the CHECK_BYTES before `end` (omp: from `start`)
    claude: ClaudeParser | null
    // Command Code: the incremental parser (its `shared` map is the file's
    // current outcome map) and the generation stamp it was built under —
    // a retained bottom of a detached generation is never reused.
    cmd?: CommandCodeParser
    cmdStamp?: number
    turns: { lines: number, items: ChatItem[], templates: readonly CommandTemplate[] } // see lastTurn
  }
  const CHECK_BYTES = 4096
  const MAX_BELOW = 8
  const MAX_KEPT_BYTES = 48 * 1024 * 1024 // Codex lines kept, all bottoms together
  const below = new Map<string, Below>()
  const queues = new Map<string, Promise<unknown>>()
  // One update at a time per bottom (several devices, polls overlapping).
  function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const r = (queues.get(key) || Promise.resolve()).then(run)
    const done = r.catch(() => {})
    queues.set(key, done)
    void done.then(() => { if (queues.get(key) === done) queues.delete(key) })
    return r
  }
  // Codex and omp read a turn as a whole (a tool's result marks its call, an
  // image placeholder is declared after its message): the items of the turns
  // before the last one are kept, and only the last turn is parsed again. A
  // turn starts at a message the user typed. Kept items are handed out again
  // as the same objects (chatDelta signs each once).
  function lastTurn(b: Below, kind: string | null, cwd: string): Parsed {
    const all = b.lines
    if (b.turns.templates !== ompTemplates.list) b.turns = { lines: 0, items: [], templates: ompTemplates.list }
    const parse = (from: number, to = all.length) => {
      const lines: Lines = all.slice(from, to)
      lines.refs = all.refs.slice(from, to)
      return kind === 'omp' ? parseOmp(lines, home, ompTemplates.list, cwd) : parseCodex(lines)
    }
    for (let i = all.length - 1; i > b.turns.lines; i--) {
      if (!turnStart(all[i]!, kind)) continue
      b.turns.items.push(...parse(b.turns.lines, i))
      b.turns.lines = i
      break
    }
    return b.turns.items.concat(parse(b.turns.lines))
  }
  async function readBelow(file: string, kind: string | null, size: number, from: number, ino?: number, ctx?: { h: CommandCodeFileHandle, stamp: number }): Promise<TailResult> {
    const key = `${file}|${kind}|${from}`
    const s0 = Math.max(0, from - ANCHOR_BYTES)
    // After any awaited IO the captured generation must still be the file's:
    // a stale poll must never feed the retained parser, republish a bottom,
    // nor reach a response.
    const live = () => !ctx || cmd.io.live(file, ctx.stamp)
    const stale = (): never => { throw new Error('command code transcript generation changed') }
    // Before any cache lookup or mutation: a request queued behind its own
    // generation's IO must never delete or feed the fresh bottom another
    // generation may already have published here.
    if (!live()) stale()
    let b = below.get(key)
    // A legacy bottom leaves the map while read (put back below when up to
    // date, most recent last). A Cmd bottom stays — an unknown read needs
    // no restore then, and nothing stale can evict the fresh entry.
    if (!ctx) below.delete(key)
    // A retained bottom belongs to its generation: a detached one rebuilds.
    if (kind === 'cmd' && b && b.cmdStamp !== ctx?.stamp) b = undefined
    let above: Buffer = Buffer.alloc(0)
    let known: Buffer = Buffer.alloc(0) // bytes just before b.end, still the same
    let fresh: Buffer = Buffer.alloc(0) // bytes from b.end
    const whole = kind === 'omp'
    // omp: one hash of the bytes from b.start, checked, then extended with the new ones.
    let sum: Hash | null = null
    const c0 = b ? (whole ? b.start : Math.max(b.start, b.end - CHECK_BYTES)) : 0
    if (b && b.ino === ino && size >= b.end) {
      if (c0 - from <= CHECK_BYTES) {
        const buf = await cmdRead(file, s0, size - s0, ctx)
        above = buf.subarray(0, from - s0)
        known = buf.subarray(c0 - s0, b.end - s0)
        fresh = buf.subarray(b.end - s0)
      } else {
        above = await cmdRead(file, s0, from - s0, ctx)
        const buf = await cmdRead(file, c0, size - c0, ctx)
        known = buf.subarray(0, b.end - c0)
        fresh = buf.subarray(b.end - c0)
      }
      // Rewritten, cut or replaced since: read again from the cursor. Cmd's
      // reads are exact by contract — coverage mismatches cannot occur, so
      // a difference here is the reader's own proof of a byte-level rewrite:
      // propagate the generation, then fail closed — the dead entry goes.
      sum = whole ? createHash('sha1').update(known) : null
      const check = sum ? sum.copy().digest('hex').slice(0, 12) : anchorHash(known)
      if (above.length !== from - s0 || known.length !== b.end - c0 || anchorHash(above) !== b.above || check !== b.check) {
        if (kind === 'cmd' && b.cmdStamp !== undefined) {
          // The proof belongs to b's captured generation: if it already
          // moved, the slot can hold a fresh bottom — only an invalidation
          // that landed on that generation may evict here.
          if (cmd.invalidate(file, b.cmdStamp)) below.delete(key)
          throw new Error('command code transcript rewritten')
        }
        below.delete(key)
        b = undefined
      }
    }
    if (!b || b.ino !== ino || size < b.end) {
      const buf = await cmdRead(file, s0, size - s0, ctx)
      above = buf.subarray(0, from - s0)
      let off = from - s0
      if (from > 0 && above[above.length - 1] !== 0x0a) {
        const nl = buf.indexOf(0x0a, off)
        off = nl < 0 ? buf.length : nl + 1
      }
      known = Buffer.alloc(0)
      sum = whole ? createHash('sha1') : null
      const lines: Lines & { refs: string[] } = Object.assign([], { refs: [] })
      const claude = kind === 'codex' || kind === 'omp' || kind === 'cmd' ? null : claudeParser(home)
      const cmdP = kind === 'cmd' && ctx ? commandCodeParser(ctx.h.results) : undefined
      b = { ino, start: s0 + off, end: s0 + off, above: anchorHash(above), aligned: off === from - s0, check: anchorHash(known), lines, hashes: new Map(), keep: !claude && !cmdP, claude,
        ...(cmdP ? { cmd: cmdP, cmdStamp: ctx!.stamp } : {}),
        turns: { lines: 0, items: [], templates: ompTemplates.list } }
      fresh = buf.subarray(off)
    }
    const nl = fresh.lastIndexOf(0x0a)
    // Absolute offset of fresh[0]: the base the appended lines' result
    // positions fingerprint against, while the raw bytes are still held.
    let feedBase = b.end
    if (nl >= 0) {
      if (!live()) stale()
      feedBase = b.end
      const added = storeLines(b, fresh.subarray(0, nl).toString('utf8'), b.end, kind)
      b.claude?.feed(added)
      b.cmd?.feed(added)
      b.end += nl + 1
      // From c0 (or the start) to the new end: covers the bytes to check next time.
      if (sum) b.check = sum.update(fresh.subarray(0, nl + 1)).digest('hex').slice(0, 12)
      else {
        const tail = Buffer.concat([known, fresh.subarray(0, nl + 1)])
        b.check = anchorHash(tail.subarray(Math.max(0, tail.length - CHECK_BYTES)))
      }
    }
    if (!live()) stale()
    // Most recent last — a Cmd bottom stayed in the map while read.
    below.delete(key)
    below.set(key, b)
    let kept = 0
    for (const x of below.values()) kept += x.keep ? x.end - x.start : 0
    for (const [k, x] of below) {
      if (x === b || (below.size <= MAX_BELOW && kept <= MAX_KEPT_BYTES)) break
      below.delete(k)
      kept -= x.keep ? x.end - x.start : 0
    }
    // A last line not ended yet is left for the next poll, unless it already
    // parses (written whole, its newline still to come): read the whole
    // bottom for this poll, as before. Only the parse attempt is caught —
    // a failed read must reject so the line is read again next poll.
    const partial = fresh.subarray(nl + 1)
    if (partial.length) {
      let whole2 = false
      try { JSON.parse(stripBlobs(partial.toString('utf8'), kind)); whole2 = true }
      catch { /* incomplete: ignored as the parsers would */ }
      if (whole2) return await readSlice(file, kind, size, from, ctx)
    }
    const items = b.claude ? b.claude.result() : b.cmd ? b.cmd.result() : lastTurn(b, kind, kind === 'omp' ? await ompCwd(file) : '')
    // Result positions of the appended lines: fingerprinted on the bytes
    // just read — never a re-encoded copy — before they are dropped.
    if (b.cmd && ctx && nl >= 0 && items.resultRefs) {
      for (const x of fingerprintRefs(fresh.subarray(0, nl), feedBase, items.resultRefs)) ctx.h.watch(x.id, x)
    }
    if (!live()) stale()
    withHashes(items, b.hashes)
    return { start: from, items, queue: items.queue || [], popped: items.popped || [], anchor: b.aligned ? b.above : '', ...(items.updates?.length ? { updates: items.updates } : {}) }
  }

  // ------------------------------------------------------------ API

  // Everything the reader keeps per file — caches keyed `file|…`, retained
  // bottoms, and pane-keyed caches whose entry is about this file. A Command
  // Code generation replaced or evicted purges all of it at once: old
  // awaited work must not refill them afterwards.
  function purgeFile(file: string) {
    const p = `${file}|`
    for (const k of parseCache.keys()) if (k.startsWith(p)) parseCache.delete(k)
    for (const k of tailReads.keys()) if (k.startsWith(p)) tailReads.delete(k)
    for (const k of below.keys()) if (k.startsWith(p)) below.delete(k)
    for (const k of previewCache.keys()) if (k.startsWith(p)) previewCache.delete(k)
    for (const k of firstSums.keys()) if (k.startsWith(p)) firstSums.delete(k)
    metaCache.delete(file)
    genSeen.delete(file)
    for (const [k, v] of modelCache) if (v.file === file) modelCache.delete(k)
    for (const [k, v] of pendingCache) if (v.file === file) pendingCache.delete(k)
    for (const [k, v] of askCache) if (v.file === file) askCache.delete(k)
    for (const [k, v] of claudeAskCache) if (v.file === file) claudeAskCache.delete(k)
  }

  async function search(pane: TranscriptPane, query: string, deadline: number) {
    if (!hasTranscript(pane.agent)) return { hits: [], limited: false, kind: null }
    const loc = await locate(pane)
    if (!loc || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: null }
    if (pane.agent === 'devin') return devin.search({ ...pane, agentSession: loc.session }, query, deadline)
    // The transcript path tells the real kind (closed agent mislabeled).
    const kind = transcriptKind(loc.file) || pane.agent
    if (kind === 'cmd') {
      // The same generation guard as chat: the selected file's state must
      // be trusted before its awaited reads run — unknown is a read error.
      const o = await cmd.observe(loc.file)
      if (!o.st) throw new Error('command code transcript state unknown')
      // The captured handle is bound and proven current before any purge:
      // a stale resolved observation must not clear a newer generation's
      // caches and then fail this check anyway.
      const h = cmd.handle(loc.file)
      if (h.stamp !== o.stamp) throw new Error('command code transcript generation changed')
      if (o.invalidated) purgeFile(loc.file)
      // A generation-bound view of the disk: every awaited stat/read of
      // the search is enclosed by the liveness check — no raw fs.read
      // bypass — and the client deadline reaches physical reads.
      const stamp = h.stamp
      const bound: MachineFs = {
        ...fs,
        stat: async p => {
          if (!cmd.io.live(p, stamp)) throw new Error('command code transcript generation changed')
          const st = await fs.stat(p)
          if (!cmd.io.live(p, stamp)) throw new Error('command code transcript generation changed')
          return st
        },
        read: async (p, start, len, timeoutMs) => {
          const buf = await cmd.io.readExact(p, start, len, stamp, timeoutMs)
          if (!buf) throw new Error('command code transcript read unknown')
          return buf
        },
      }
      const r = await searchFile(bound, loc.file, kind, home, query, deadline)
      // Hits of a moved generation are another transcript's: never served.
      if (!cmd.io.live(loc.file, stamp)) throw new Error('command code transcript generation changed')
      return { ...r, kind }
    }
    return { ...await searchFile(fs, loc.file, kind, home, query, deadline), kind }
  }

  // opts.since : token of the last state seen ("unchanged" reply if it has not moved)
  // opts.from  : re-read the bottom from this byte (continuity with older pages)
  // opts.before: load the older slice ending at this byte
  // opts.fresh : look for the file again if none was found lately (see locate)
  // opts.anchor: token as the client sent it, for the join check (anchorOf),
  //              when `since` was dropped (list the server no longer knows)
  async function chat(pane: TranscriptPane, opts: { since?: string, from?: number | null, before?: number | null, fresh?: boolean, anchor?: string } = {}): Promise<ChatResponse> {
    if (!hasTranscript(pane.agent)) return { available: false, reason: 'unsupported' }
    const loc = await locate(pane, Boolean(opts.fresh))
    if (!loc) return { available: false, reason: 'not_found' }
    if (pane.agent === 'devin') {
      const r = await devin.chat({ ...pane, agentSession: loc.session }, opts)
      for (const item of r.items || []) if (item.role === 'assistant' && item.ref) replyKeys.set(item, `devin:${r.session}:${item.ref}`)
      return r
    }
    // The transcript path tells the real kind: a pane whose agent changed while
    // its session stayed must not read the file as another agent's (no message).
    const kind = transcriptKind(loc.file) || pane.agent
    if (kind === 'omp') await refreshOmpTemplates()
    let st: FsStat | null = null
    let h: CommandCodeFileHandle | null = null
    if (kind === 'cmd') {
      // The observation is the one stat acquisition: it also proves the
      // file's generation (result watches) or invalidates it.
      let o: CommandCodeObservation | null = null
      try { o = await cmd.observe(loc.file) }
      catch (e) { if (!isMissing(e)) throw e; o = null }
      // Unknown — failed or short validation, the pending cap, a record
      // replaced mid-IO: a read error, never a trusted advance. The client
      // keeps what it shows and the next poll retries.
      if (o && !o.st) throw new Error('command code transcript state unknown')
      st = o ? o.st : null
      if (st && st.isFile) {
        h = cmd.handle(loc.file)
        // The bound handle must prove the observation current before any
        // cache mutation — synchronous, nothing awaits between them: a
        // stale resolved observation must not clear a newer generation's
        // caches and then fail this check anyway.
        if (o && h.stamp !== o.stamp) throw new Error('command code transcript generation changed')
        if (o && o.invalidated) purgeFile(loc.file)
      }
    } else {
      try { st = await fs.stat(loc.file) }
      catch (e) {
        // Failed read: an error (the client keeps what it shows), not an empty result.
        if (!isMissing(e)) throw e
        st = null
      }
    }
    // Gone, or a folder where the transcript was expected: no conversation.
    if (!st || !st.isFile) {
      locCache.delete(pane.id)
      lastLoc.delete(pane.id)
      return { available: false, reason: 'not_found' }
    }
    const fileId = path.basename(loc.file)
    const base = { available: true, file: fileId, session: loc.session, guessed: Boolean(loc.guessed) }
    // The generation every read and cache write is bound to — every
    // awaited step must still find it live before its result is used.
    const ctx = h ? { h, stamp: h.stamp } : undefined
    // The reply's bound context for the route's post-await re-check
    // (current/live below): held in a per-reader WeakMap, never on the
    // reply — no callback or path can reach the wire, and a foreign
    // reader can never claim this context (its stamps are its own).
    const withGen = <T extends ChatResponse>(r: T): T => {
      if (h) {
        const file = loc.file
        const stamp = h.stamp
        contexts.set(r, { file, live: () => cmd.io.live(file, stamp) })
      }
      return r
    }
    // The token the client claims to have read from (its anchor doubles as
    // the join check when `since` was forgotten). For Command Code it must
    // name this exact generation and reader: a missing or stale stamp can
    // never serve its pages or its outcomes — fresh bottom, not older.
    const sent = opts.anchor ?? opts.since
    const tok = kind === 'cmd' ? tokenStamp(sent) : null
    const noProof = kind === 'cmd' && (tok === null || tok.stamp !== h!.stamp || tok.reader !== cmd.reader)
    const stale = noProof && (sent != null || opts.before != null)
    if (opts.before !== null && opts.before !== undefined && !noProof) {
      const r = await readBackwards(loc.file, Math.min(opts.before, st.size), kind, ctx)
      // An older page exists only in its generation: a rewrite observed
      // while its windows were awaited makes this page another
      // transcript's — reject, never return it.
      if (h && !cmd.io.live(loc.file, h.stamp)) throw new Error('command code transcript generation changed')
      return withGen({ ...base, older: true, items: r.items, start: r.start, ...(r.updates?.length ? { toolUpdates: r.updates } : {}) })
    }
    const from = opts.from === undefined ? null : opts.from
    const gen = genOf(st)
    const settled = await settledGen(loc.file, st, gen)
    // digests may have awaited: an "unchanged" answer must still be of this
    // generation — a replacement mid-await means the client must reset.
    if (h && !cmd.io.live(loc.file, h.stamp)) throw new Error('command code transcript generation changed')
    // Token: file, size, cursor, generation (unchanged as long as these are,
    // once settled), then the anchor of the reply's start. For Command Code
    // the head also carries the generation stamp and the reader nonce — the
    // unchanged comparison then includes both, exactly.
    const head = `${fileId}:${st.size}:${from}:${gen}${h ? `~s${h.stamp}~r${cmd.reader}` : ''}`
    if (settled && opts.since && opts.since.split('/')[0] === head) return withGen({ ...base, unchanged: true, token: opts.since })
    let r = await tail(loc.file, kind, st.size, gen, from, settled, st.ino, ctx)
    // The client's list starts at the cursor, and the file was rewritten
    // above it: replaced by another file (inode), shorter, rewritten at the
    // same size (appends always grow it), or other bytes just above the cursor
    // (anchor), or no line start there any more. Read back from the end, and
    // say so: the client starts again.
    const at = anchorOf(sent)
    const prev = headOf(sent)
    const same = prev !== null && prev.file === fileId
    // A list read before its state settled (whole-second mtimes): rewritten
    // within that second if its part of the file changed since.
    const rewritten = stale || (from !== null && from > 0 && at !== null && at.start === from && (r.anchor !== at.hash
      || (same && prev.ino !== null && st.ino !== undefined && prev.ino !== st.ino)
      || (same && st.size < prev.size)
      || (same && st.size === prev.size && prev.gen !== gen)
      || (same && prev.unsettled && !await stillThere(loc.file, prev))))
    if (rewritten) r = await tail(loc.file, kind, st.size, gen, null, settled, st.ino, ctx)
    // `!` (unsettled) rides right after the generation where headOf finds it.
    const mark = `${fileId}:${st.size}:${from}:${gen}${settled ? '' : '!'}${h ? `~s${h.stamp}~r${cmd.reader}` : ''}`
    const token = r.anchor ? `${mark}/${r.start}.${r.anchor}` : mark
    if (h && !cmd.io.live(loc.file, h.stamp)) throw new Error('command code transcript generation changed')
    return withGen({ ...base, token, items: r.items, start: r.start, queue: r.queue || [], ...(r.popped?.length ? { popped: r.popped } : {}), ...(rewritten ? { rewritten: true } : {}), ...(r.updates?.length ? { toolUpdates: r.updates } : {}) })
  }

  // The context a Command Code reply was bound under still authorizes it
  // while the selection names the same file and that generation is live:
  // 'gone' — no or another selected file, or a reply this reader never
  // bound (a Command Code available reply must have been bound by some
  // reader — a miss is foreign, never "nothing to check"); 'stale' — it
  // detached; null — an unbound reply (other agents, unavailable),
  // nothing to check. One awaited locate, nothing else.
  async function current(pane: TranscriptPane, r: ChatResponse): Promise<'ok' | 'stale' | 'gone' | null> {
    const ctx = contexts.get(r)
    if (!ctx) return pane.agent === 'cmd' && r.available ? 'gone' : null
    const loc = await locate(pane)
    if (!loc || loc.file !== ctx.file) return 'gone'
    return ctx.live() ? 'ok' : 'stale'
  }

  // The synchronous final predicate for the same bound context — the
  // route's last word after all its awaits; never awaits itself. The
  // generation predicate is joined by the latest observed selection
  // evidence (never a fallback, only a guard): a bound Command Code reply
  // needs a known selection still on its file — moved, lost or forgotten
  // evidence fails closed even while the stamp stays live. Same
  // fail-closed miss rule as current().
  function live(pane: TranscriptPane, r: ChatResponse): boolean | null {
    const ctx = contexts.get(r)
    if (!ctx) return pane.agent === 'cmd' && r.available ? false : null
    const sel = selections.get(pane.id)
    if (!sel || sel.file !== ctx.file) return false
    return ctx.live()
  }

  // Agent's last reply, for cards and notifications.
  // A stable message identity lets notifications distinguish a new reply
  // from another poll (or more streamed text in the same reply).
  // Previews refresh every few seconds per working agent: the last
  // PREVIEW_BYTES are read first (cached by size and generation once settled),
  // the bottom of the conversation (chat) only if they hold no reply.
  async function latestReply(pane: TranscriptPane): Promise<{ key: string, text: string } | null> {
    try {
      const short = await tailReply(pane)
      if (short) return short
      const r = await chat(pane, {})
      if (!r.available || !r.items) return null
      return lastReplyOf(r.items)
    } catch { /* no preview */ }
    return null
  }
  async function tailReply(pane: TranscriptPane): Promise<{ key: string, text: string } | null> {
    if (pane.agent === 'devin') return null // ATIF is a single JSON document, not JSONL.
    // Command Code previews come from the guarded chat itself until the
    // short-preview path carries generation evidence (4d-3).
    if (pane.agent === 'cmd') return null
    if (!hasTranscript(pane.agent)) return null
    const loc = await locate(pane)
    if (!loc) return null
    const st = await fs.stat(loc.file).catch(() => null)
    // Missing (chat forgets the location) or short enough for one read anyway.
    if (!st || !st.isFile || st.size <= PREVIEW_BYTES) return null
    const kind = transcriptKind(loc.file) || pane.agent
    const gen = genOf(st)
    const key = `${loc.file}|${kind}`
    const c = previewCache.get(key)
    if (c && c.size === st.size && c.gen === gen) return c.reply
    const settled = await settledGen(loc.file, st, gen)
    if (kind === 'omp') await refreshOmpTemplates()
    const r = await readRange(loc.file, st.size - PREVIEW_BYTES, st.size)
    const reply = lastReplyOf(parseLines(r.text, kind, r.start, home, ompTemplates.list, kind === 'omp' ? await ompCwd(loc.file) : ''))
    previewCache.delete(key)
    if (settled && reply) previewCache.set(key, { size: st.size, gen, reply })
    if (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value!)
    return reply
  }
  function lastReplyOf(items: ChatItem[]): { key: string, text: string } | null {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.role === 'assistant' && it.text.trim()) {
        const text = it.text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
        const key = replyKeys.get(it)
        if (key) return { key, text }
      }
    }
    return null
  }
  async function preview(pane: TranscriptPane): Promise<string | null> {
    return (await latestReply(pane))?.text ?? null
  }

  // Image no. `index` of the message at `ref` ("start:length"): we re-read
  // that single line and decode the image it contains (base64).
  async function image(pane: TranscriptPane, fileId: string | null, ref: string | null, index: number) {
    const loc = await locate(pane)
    if (!loc || path.basename(loc.file) !== fileId) return null
    if (pane.agent === 'devin') return devin.image({ ...pane, agentSession: loc.session }, fileId, ref, index)
    const m = /^(\d+):(\d+)$/.exec(String(ref || ''))
    if (!m) return null
    const off = Number(m[1])
    const len = Number(m[2])
    if (len > 60 * 1024 * 1024) return null
    const kind = transcriptKind(loc.file) || pane.agent
    if (kind === 'cmd') {
      // The extent is rejected before even the observation: a warm file
      // reads its result watches inside observe — an unsafe range must
      // start no IO at all.
      if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len)
        || len < 0 || len > 60 * 1024 * 1024 || !Number.isSafeInteger(off + len)) return null
      // The ref is `offset:length` — it carries no stamp. What bounds the
      // request is the selected file's basename (above) and the current
      // observation's generation; a captured read detached in flight
      // serves nothing.
      const o = await cmd.observe(loc.file).catch(() => null)
      if (!o || !o.st || !o.st.isFile) return null
      const h = cmd.handle(loc.file)
      if (h.stamp !== o.stamp) return null
      if (o.invalidated) purgeFile(loc.file)
      // readExact rejects unsafe/negative/noninteger/sum/over-limit ranges
      // before any allocation and answers only with exact coverage under
      // a live generation — a failed or detached read is no image. Its own
      // check runs before its promise resolves; this caller resumes in a
      // later continuation, so an invalidation queued in between must be
      // caught here too before the bytes are parsed.
      const buf = await cmd.io.readExact(loc.file, off, len, h.stamp)
      if (!buf || !cmd.io.live(loc.file, h.stamp)) return null
      let d: Json
      try { d = JSON.parse(buf.toString('utf8')) }
      catch { return null }
      const img = extractImage(d, index, kind)
      // Command Code images are inline data only — never a blob/file/URL
      // fetch (cmdLineImage never yields one, keep it unreachable anyway).
      return img && !('blob' in img) ? img : null
    }
    let d: Json
    try { d = JSON.parse((await fs.read(loc.file, off, len)).toString('utf8')) }
    catch { return null }
    const img = extractImage(d, index, kind)
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
  const modelCache = new Map<string, { file: string, size: number, raw: ModelInfo | null, info: ModelInfo | null, stamp?: number }>()
  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    if (pane.agent === 'devin') {
      const loc = await locate(pane)
      return loc ? devin.model({ ...pane, agentSession: loc.session }) : null
    }
    if (!pane.agent || !['claude', 'codex', 'omp', 'cmd'].includes(pane.agent)) return null
    const loc = await locate(pane)
    if (!loc) return null
    // The transcript path tells the real kind (closed agent mislabeled).
    const kind = transcriptKind(loc.file) || pane.agent
    const c = modelCache.get(pane.id)
    let h: CommandCodeFileHandle | null = null
    let size: number
    // A failed read (SSH dropped, timeout) says nothing about the model: keep
    // the last value of this file, or let the caller keep its own. Only a
    // missing file means "no model". Command Code: only an entry proven of
    // the file's CURRENT generation may stand in — never a prior selected
    // file's or a detached generation's metadata.
    const stale = (e: unknown) => {
      if (kind === 'cmd') {
        // Missing file means "no model", warm cache or not — only a
        // transport unknown may retain current same-generation metadata.
        if (isMissing(e)) return null
        if (c && c.file === loc.file && c.stamp !== undefined && c.stamp === cmd.stampOf(loc.file)) return c.info
        throw e
      }
      if (c && c.file === loc.file) return c.info
      if (isMissing(e)) return null
      throw e
    }
    if (kind === 'cmd') {
      // The observation is the one stat acquisition: it also proves the
      // file's generation (result watches) or invalidates it.
      let o: CommandCodeObservation | null = null
      try { o = await cmd.observe(loc.file) }
      catch (e) { return stale(e) }
      // Unknown — failed or short validation, the pending cap, a record
      // replaced mid-IO: the entry stamped by the very record this
      // observation resolved under AND still current now is proven
      // same-generation; anything else is a read error, never another
      // generation's model.
      if (!o.st) {
        if (c && c.file === loc.file && c.stamp !== undefined && c.stamp === o.stamp && cmd.io.live(loc.file, o.stamp)) return c.info
        throw new Error('command code transcript state unknown')
      }
      // A folder where the transcript was expected has no model.
      if (!o.st.isFile) return null
      h = cmd.handle(loc.file)
      // Bound handle proven current before any cache mutation — same
      // ordering as chat.
      if (h.stamp !== o.stamp) throw new Error('command code transcript generation changed')
      if (o.invalidated) purgeFile(loc.file)
      size = o.st.size
      if (c && c.file === loc.file && c.size === size && c.stamp === h.stamp) return c.info
    } else {
      try { size = (await fs.stat(loc.file)).size }
      catch (e) { return stale(e) }
      if (c && c.file === loc.file && c.size === size) return c.info
    }
    const omp = pane.agent === 'omp'
    let raw: ModelInfo | null = null
    let done = size // end of the last complete line (a line being written will be re-read)
    try {
      // Already read up to c.size: only what follows can bring something new. We
      // start from the byte before (the newline): readRange skips the line
      // started at the beginning of the window. For Command Code that floor is
      // usable only within its generation — another generation's remembered
      // size says nothing of these bytes.
      const floor = c && c.file === loc.file && c.size < size && (kind !== 'cmd' || c.stamp === h!.stamp) ? c.size : 0
      let end = size
      let w = MODEL_WINDOW
      while (end > floor && size - end < MODEL_MAX_BYTES) {
        // Window widened as long as it holds no line start — but never
        // issued past this request's remaining logical span (a giant
        // line must not be read by overshooting the cap), and `w` can't
        // widen forever: a window already covering the span ends it.
        const room = MODEL_MAX_BYTES - (size - end)
        const s0 = Math.max(floor ? floor - 1 : 0, end - Math.min(w, room))
        const r = await readRange(loc.file, s0, end, h ? { h, stamp: h.stamp } : undefined)
        if (r.start >= end) {
          // No whole line in the window (message with images): we widen it.
          if (s0 <= Math.max(0, floor - 1) || end - s0 >= room) break
          w *= 2
          continue
        }
        if (end === size && !r.text.endsWith('\n')) done = size - Buffer.byteLength(r.text.slice(r.text.lastIndexOf('\n') + 1))
        const lines = r.text.split('\n').map(l => stripBlobs(l, pane.agent))
        raw = omp ? mergeOmpModel(raw, ompLastModel(lines)) : lastModel(lines, kind)
        if (omp ? ompModelComplete(raw) : raw) break
        end = r.start
      }
      if (floor && c) raw = omp ? mergeOmpModel(raw, c.raw) : raw || c.raw
    } catch (e) { return stale(e) }
    // The generation must still be live before its metadata is cached or
    // returned — a detached answer is never published.
    if (h && !cmd.io.live(loc.file, h.stamp)) throw new Error('command code transcript generation changed')
    const info = omp ? ompModelResult(raw) : raw
    modelCache.set(pane.id, { file: loc.file, size: done, raw, info, stamp: h?.stamp })
    return info
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
      const lines = r.text.split('\n').map(l => stripBlobs(l))
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
    try { asked = pendingOmpAsk((await readRange(loc.file, Math.max(0, size - PENDING_WINDOW), size)).text.split('\n').map(l => stripBlobs(l))) }
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
    try { asked = pendingClaudeAsk((await readRange(loc.file, Math.max(0, size - PENDING_WINDOW), size)).text.split('\n').map(l => stripBlobs(l))) }
    catch { asked = [] }
    claudeAskCache.set(pane.id, { file: loc.file, size, asked })
    return asked
  }

  function forget(paneId: string) {
    locCache.delete(paneId)
    lastLoc.delete(paneId)
    selections.delete(paneId)
    selSeq.delete(paneId)
    modelCache.delete(paneId)
    pendingCache.delete(paneId)
    askCache.delete(paneId)
    claudeAskCache.delete(paneId)
  }

  return { chat, preview, latestReply, image, forget, locate, model, observe, wasActive: activity.was, search, pendingTool, pendingAsk, pendingClaudeQuestions, current, live }
}

export type Transcripts = ReturnType<typeof createTranscripts>
