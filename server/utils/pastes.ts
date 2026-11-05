// Pasted texts of the messages sent from wherdr's field, kept for every
// device. No transcript tells them from typed words (Claude Code wraps the
// whole send in one <pasted_content>, Codex and omp keep plain text): the app
// says where they sit in the message it sends, and the conversation served to
// all devices lists them (ChatItem.pasted), so each one shows the same cards
// (see shared/pastedText.ts).
// Kept in data/pastes.json (in clear, readable by the server's user only),
// most recent first, bounded in number, size and time: the oldest go, a block
// goes 30 days after it was last sent, and their messages become plain text
// again.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QueuedMessage } from '../../shared/types'
import { isLongPaste, splitPasted } from '../../shared/pastedText'
import { DATA_DIR } from './env'

export const PASTES_MAX = 100
export const PASTES_MAX_CHARS = 2_000_000
export const PASTES_TTL_MS = 30 * 86400000
// A kept block, and when it was last sent.
export interface KeptPaste { text: string, at: number }
const live = (p: KeptPaste, now: number) => now - p.at < PASTES_TTL_MS
// Ranges read from one request.
const PER_MESSAGE = 20

// The pasted texts of `text` at the [start, length] ranges the app gave:
// long blocks only, each one once. Anything malformed is ignored.
export function pastesAt(text: string, ranges: unknown): string[] {
  if (!Array.isArray(ranges)) return []
  const out: string[] = []
  for (const r of ranges.slice(0, PER_MESSAGE)) {
    if (!Array.isArray(r)) continue
    const [at, len] = r as unknown[]
    if (typeof at !== 'number' || typeof len !== 'number' || !Number.isInteger(at) || !Number.isInteger(len)) continue
    if (at < 0 || len <= 0 || at + len > text.length) continue
    const b = text.slice(at, at + len).trim()
    if (isLongPaste(b) && !out.includes(b)) out.push(b)
  }
  return out
}

// The list with `blocks` first, sent at `now`, without the blocks that
// expired. The same list (same array) when there is nothing to add.
export function addPastes(list: KeptPaste[], blocks: string[], now: number): KeptPaste[] {
  if (!blocks.length) return list
  let total = 0
  return [...blocks.map(text => ({ text, at: now })), ...list.filter(p => !blocks.includes(p.text) && live(p, now))].slice(0, PASTES_MAX).filter((p) => {
    total += p.text.length
    return total <= PASTES_MAX_CHARS
  })
}

// Blocks read back from data/pastes.json: well-formed ones that have not
// expired, within the bounds. A block of the first format (the text alone)
// starts its 30 days at `now`.
export function loadPastes(raw: unknown, now: number): KeptPaste[] {
  if (!Array.isArray(raw)) return []
  const out: KeptPaste[] = []
  let total = 0
  for (const r of raw as unknown[]) {
    const p = typeof r === 'string' ? { text: r, at: now } : (r as KeptPaste | null)
    if (!p || typeof p.text !== 'string' || typeof p.at !== 'number' || !Number.isFinite(p.at)) continue
    if (!isLongPaste(p.text) || !live(p, now) || out.some(o => o.text === p.text)) continue
    if (out.length >= PASTES_MAX || (total += p.text.length) > PASTES_MAX_CHARS) break
    out.push({ text: p.text, at: Math.min(p.at, now) })
  }
  return out
}

// Pasted texts of a user message: the blocks its transcript lists (`listed`)
// and the kept ones found in it, the longest first (a kept block may sit
// inside another one), in the order of the text. Only text of the message
// itself: a kept block that merely starts like it is another message's, and
// of a text cut short, the part it holds.
export function pastedIn(list: string[], text: string, listed: string[] = []): string[] {
  if (!list.length || !isLongPaste(text)) return listed
  const known = list.filter(b => !listed.includes(b)).sort((a, b) => b.length - a.length)
  return splitPasted(text, listed, known).pastes
}

// The conversation with the pasted texts of its user messages listed.
export function withPasted<T extends { role: string, text: string, pasted?: string[] }>(items: T[], list: string[]): T[] {
  if (!list.length) return items
  return items.map((i) => {
    if (i.role !== 'user') return i
    const pasted = pastedIn(list, i.text, i.pasted)
    return pasted.length && pasted !== i.pasted ? { ...i, pasted } : i
  })
}

// A queued record with its pasted texts: what its text, cut short, holds of them.
export function withQueuedPasted(q: QueuedMessage, list: string[]): QueuedMessage {
  const pasted = pastedIn(list, q.text)
  return pasted.length ? { ...q, pasted } : q
}

const PASTES_FILE = path.join(DATA_DIR, 'pastes.json')
let kept: KeptPaste[] | null = null
// The list the file holds (null: the file is to be written).
let saved: KeptPaste[] | null = null
// Texts of `list`, for the conversations (read on every request).
let texts: { of: KeptPaste[], list: string[] } | null = null
function pastes(): KeptPaste[] {
  if (kept) return kept
  kept = []
  saved = kept
  try {
    const raw = fs.readFileSync(PASTES_FILE, 'utf8')
    kept = loadPastes(JSON.parse(raw), Date.now())
    // Expired blocks, or the first format: the file is written again.
    saved = JSON.stringify(kept) + '\n' === raw ? kept : null
  } catch { /* no file yet, or unreadable: nothing kept */ }
  return kept
}
function keptTexts(): string[] {
  const list = pastes()
  if (texts?.of !== list) texts = { of: list, list: list.map(p => p.text) }
  return texts.list
}

// Written to a temporary file then renamed (a reader never sees half a file,
// which would read as an empty list), one write after the other: the latest
// list, whatever sends came in meanwhile.
let writing: Promise<unknown> = Promise.resolve()
function save() {
  writing = writing.then(async () => {
    const list = kept
    if (!list || list === saved) return
    const temp = `${PASTES_FILE}.${randomUUID()}.tmp`
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      await fsp.writeFile(temp, JSON.stringify(list) + '\n', { mode: 0o600 })
      await fsp.rename(temp, PASTES_FILE)
      saved = list
    } catch {
      await fsp.rm(temp, { force: true }).catch(() => {})
    }
  })
}

// A message sent from the app: its pasted texts are kept. Written only when
// the list changes (never for a message without a paste).
export function keepPastes(text: string, ranges: unknown) {
  const next = addPastes(pastes(), pastesAt(text, ranges), Date.now())
  if (next === kept) return
  kept = next
  save()
}
// At startup and from time to time (see plugins/poller.ts): the blocks that
// expired leave the memory and the file.
export function purgePastes(now = Date.now()) {
  const list = pastes()
  if (list.some(p => !live(p, now))) kept = list.filter(p => live(p, now))
  if (kept !== saved) save()
}
export const chatPasted = <T extends { role: string, text: string, pasted?: string[] }>(items: T[]) => withPasted(items, keptTexts())
