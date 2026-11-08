// wherdr's "queued" message against Claude's screen (ClaudeScreen):
// still in its queue, already sent (turn in progress), or "!" command
// running. The transcript only tells afterwards (a "!" command
// is only written there at the end), the screen right away.
import type { ClaudeScreen } from './types'
import { sameSent } from './reference'
import { imageTagCount, isUploadLine, onlyImageTags, photosOnly, uploadNames } from './queuedMatch'

export type QueuedPhase = 'queued' | 'sent' | 'running'

// The screen replaces photos with "[Image #1]" and cuts long lines.
const norm = (t: string) => String(t || '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
const msgNorm = (t: string) => norm(String(t || '').split('\n').filter(l => !isUploadLine(l)).join('\n'))

// Same message (first 80 characters); or one starts with the other, long
// enough not to confuse "ok" with "ok, go ahead" (cut screen). Whitespace is
// ignored: the screen wraps long lines, mid-word when a word (a path) is
// longer than the line, so a break may stand where the text has none.
// Under the same reference (see sameSent): "Yes" to one question is not "Yes"
// to another.
function sameWords(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, '').slice(0, 80)
  const y = b.replace(/\s+/g, '').slice(0, 80)
  if (!x || !y) return false
  return x === y || (Math.min(x.length, y.length) >= 24 && (x.startsWith(y) || y.startsWith(x)))
}
const same = (a: string, b: string) => Boolean(a && b) && sameSent(a, b, sameWords)

// Photos alone: "[Image #1] [Image #2]" alone on the screen, as many as its photos.
const samePhotos = (text: string, shown: string) => onlyImageTags(shown) && imageTagCount(shown) === uploadNames(text).length

const isBash = (t: string) => /^\s*!/.test(t)
const bashNorm = (t: string) => norm(String(t || '').replace(/^\s*!!?\s*/, ''))

export function queuedPhase(text: string, s: ClaudeScreen | null | undefined): QueuedPhase {
  if (!s) return 'queued'
  if (photosOnly(text)) return s.queued.some(q => samePhotos(text, q)) || !s.sent || !samePhotos(text, s.sent) ? 'queued' : 'sent'
  const n = msgNorm(text)
  if (!n) return 'queued'
  if (s.queued.some(q => same(n, norm(q)))) return 'queued'
  // omp runs "$ code" (Python) too: matched against its running command only.
  const run = !s.shell ? '' : s.shell.python ? (/^\s*\$/.test(text) ? norm(text.replace(/^\s*\$\$?\s*/, '')) : '') : isBash(text) ? bashNorm(text) : ''
  if (s.shell && same(run, norm(s.shell.command))) return 'running'
  if (isBash(text)) {
    return s.sent && isBash(s.sent) && same(bashNorm(text), bashNorm(s.sent)) ? 'sent' : 'queued'
  }
  return s.sent && !isBash(s.sent) && same(n, norm(s.sent)) ? 'sent' : 'queued'
}

// Phases of a queue in sending order. The screen only keeps the last
// message sent: when Claude takes two messages from its queue at once, only
// the second is recognized there, and it would show as "sent" before the first.
// Rule: a message is only sent if all older ones are. A
// more recent message already sent proves that the older ones outside the
// screen's queue were sent too; an older one still in that queue holds back
// the following ones.
export function queuedPhases(texts: string[], s: ClaudeScreen | null | undefined): QueuedPhase[] {
  const raw = texts.map(t => queuedPhase(t, s))
  const inQueue = texts.map(t => Boolean(s && s.queued.some(q => (photosOnly(t) ? samePhotos(t, q) : same(msgNorm(t), norm(q))))))
  const lastGone = raw.reduce((acc, p, i) => (p !== 'queued' ? i : acc), -1)
  return raw.map((p, i) => {
    if (i > lastGone) return p
    if (inQueue.slice(0, i + 1).some(Boolean)) return 'queued'
    return p === 'queued' ? 'sent' : p
  })
}
