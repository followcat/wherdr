// Paging of a conversation read whole (a database, a JSON document) as numbered
// steps: the bottom page, older pages (`before`), a re-read from a step
// (`from`), and a token that proves the steps above a page did not change.
// Same tokens and rules as the Antigravity and Devin readers.
import { createHash } from 'node:crypto'
import type { ChatItem, ChatResponse } from '../../shared/types'

export interface PageStep { idx: number, fp: string, items: ChatItem[] }
export interface PageOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }
// `size` grows when steps are added, `gen` changes with any change.
export interface PageState { file: string, size: number, gen: string }

const PAGE_ITEMS = 120
const HEAD = /^(.*):(\d+):(null|\d+):([0-9a-f]{12})(?=[/~#]|$)/
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/

export const hash12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

export function pageHeadOf(token: string | null | undefined) {
  const m = HEAD.exec(String(token || ''))
  return m ? { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), gen: m[4]! } : null
}

function anchorOf(token: string | null | undefined) {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}

const prefixOf = (steps: PageStep[], start: number) =>
  hash12(steps.filter(s => s.idx < start).map(s => `${s.idx}.${s.fp}`).join('|'))
const hasStep = (steps: PageStep[], idx: number) => idx === 0 || steps.some(s => s.idx === idx)

// The last steps holding at least `limit` items.
function takeVisible(steps: PageStep[], limit: number): { start: number, items: ChatItem[] } {
  let i = steps.length
  for (let visible = 0; i > 0 && visible < limit;) visible += steps[--i]!.items.length
  return { start: i > 0 ? steps[i]!.idx : 0, items: steps.slice(i).flatMap(s => s.items) }
}

export function pageSteps(steps: PageStep[], st: PageState, opts: PageOptions = {}, limit = PAGE_ITEMS): ChatResponse {
  const { file, size, gen } = st
  const from = opts.from === undefined ? null : opts.from
  const before = opts.before
  const prev = pageHeadOf(opts.since)
  if (before == null && prev && prev.file === file && prev.size === size && prev.gen === gen) {
    return { available: true, file, token: opts.since, unchanged: true }
  }
  const sent = opts.anchor ?? opts.since
  const at = anchorOf(sent)
  const sentHead = pageHeadOf(sent)
  let invalid = Boolean(sentHead && sentHead.file !== file) || (before != null && !hasStep(steps, before)) || (from != null && !hasStep(steps, from))
    || (from != null && Boolean(sent) && !sentHead)
  if (!invalid && at && (before != null || from === at.start) && prefixOf(steps, at.start) !== at.hash) invalid = true
  if (!invalid && from != null && from > 0 && prev && prev.file === file && size < prev.size) invalid = true
  if (invalid && before != null) return { available: true, file, older: true, items: [], start: 0, rewritten: true }
  const rewritten = invalid ? { rewritten: true as const } : {}
  let page: { start: number, items: ChatItem[] }
  if (before != null) {
    const end = before === 0 ? 0 : steps.findIndex(s => s.idx >= before)
    page = takeVisible(end < 0 ? steps : steps.slice(0, end), limit)
    return { available: true, file, older: true, ...page, ...rewritten }
  }
  if (from != null && !invalid) {
    const lo = from === 0 ? 0 : steps.findIndex(s => s.idx >= from)
    const selected = lo < 0 ? steps : steps.slice(lo)
    page = { start: selected[0] && selected.length < steps.length ? selected[0].idx : 0, items: selected.flatMap(s => s.items) }
  } else {
    page = takeVisible(steps, limit)
  }
  const token = `${file}:${size}:${from}:${gen}/${page.start}.${prefixOf(steps, page.start)}`
  return { available: true, file, token, ...page, queue: [], ...rewritten }
}
