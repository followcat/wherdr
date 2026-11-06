import type { ChatItem, ConversationHit } from '../../shared/types'
import { parseLines } from './transcripts'
import type { MachineFs } from './fsx'
import { excerpt, matchAt } from '../../shared/searchText'

export const SEARCH_WINDOW = 256 * 1024
export const SEARCH_BYTES_PER_AGENT = 8 * 1024 * 1024
export const SEARCH_MAX_RESULTS = 60
export const SEARCH_DEADLINE_MS = 5000

export { foldSearch, matchAt, excerpt } from '../../shared/searchText'

export function hitsInLine(line: string, kind: string, base: number, query: string, home = ''): Omit<ConversationHit, 'pane' | 'agent' | 'title'>[] {
  const items = parseLines(line + '\n', kind, base, home)
  return items.filter((item: ChatItem) => item.role === 'user' || item.role === 'assistant').flatMap(item => {
    const at = matchAt(item.text, query)
    return at < 0 ? [] : [{ role: item.role, text: item.text.slice(0, 180), excerpt: excerpt(item.text, at, 120, query), ts: item.ts, offset: base }]
  })
}

export async function searchFile(fs: MachineFs, file: string, kind: string, home: string, query: string, deadline: number, maxHits = 8) {
  const size = (await fs.stat(file)).size
  let end = size
  let read = 0
  const hits: ReturnType<typeof hitsInLine> = []
  let limited = false
  while (end > 0 && read < SEARCH_BYTES_PER_AGENT && hits.length < maxHits) {
    if (Date.now() >= deadline) { limited = true; break }
    const start = Math.max(0, end - Math.min(SEARCH_WINDOW, SEARCH_BYTES_PER_AGENT - read))
    const buf = await fs.read(file, start, end - start, Math.max(100, deadline - Date.now()))
    read += buf.length
    // A window starting in the middle of a line skips that line. The
    // previous window will pick it up from its start; a giant line is
    // ignored under the byte cap.
    const first = start ? buf.indexOf(10) + 1 : 0
    // A window inside one giant line holds no complete line: none of its
    // bytes is a newline, or only the last one is. Repeating it would
    // leave `end` unchanged, so the walk jumps to its start instead.
    if (start && (first === 0 || first === buf.length)) { end = start; continue }
    const body = buf.subarray(first).toString('utf8')
    const lines = body.split('\n')
    let offset = start + first
    const found: typeof hits = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (i < lines.length - 1 || end === size) found.push(...hitsInLine(line, kind, offset, query, home))
      offset += Buffer.byteLength(line) + 1
    }
    hits.push(...found.reverse().slice(0, maxHits - hits.length))
    end = start + first
    // Yields between two windows, even on a fast local disk.
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { hits, limited: limited || (end > 0 && (read >= SEARCH_BYTES_PER_AGENT || hits.length >= maxHits)) }
}
