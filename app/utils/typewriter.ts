// Typewriter effect for the agent's new replies (Conversation).
// Claude Code and Codex only write a reply once it is finished: we
// reveal it on the app side. To keep the markdown always valid, we never
// truncate the source: we render the final HTML (utils/markdown.ts), then reveal
// its text nodes in document order. An element whose text has not
// started is hidden (`hidden`); tags therefore cannot be
// broken, and code blocks or tables fill up in their final frame.
// The functions work on a minimal node interface (real DOM in
// the app, plain objects in the tests).

export interface RevealNode {
  nodeType: number
  nodeValue: string | null
  childNodes: ArrayLike<RevealNode>
  hidden?: boolean
}

interface TextEntry { node: RevealNode, full: string, start: number }
interface ElemEntry { node: RevealNode, start: number, text: boolean, keep: boolean }
export interface RevealPlan {
  texts: TextEntry[]
  elems: ElemEntry[]
  total: number
  stops: number[]
  shown: number
  written: number
}

// Reveal parameters: writing rate, distance between the two fronts,
// catch-up duration and glyph change speed.
export const TYPE_MIN_MS = 500
export const TYPE_MAX_MS = 2000
export type TypingSpeed = 'off' | 'fast' | 'medium' | 'slow'
export const TYPE_FACTOR: Record<Exclude<TypingSpeed, 'off'>, number> = { fast: 1, medium: 2, slow: 3 }
export const CIPHER_GAP: Record<Exclude<TypingSpeed, 'off'>, number> = { fast: 20, medium: 40, slow: 70 }
export const CATCHUP_MS: Record<Exclude<TypingSpeed, 'off'>, number> = { fast: 300, medium: 450, slow: 650 }
export const GLYPH_MS = 60
export function typeDuration(chars: number, speed: TypingSpeed = 'fast'): number {
  if (speed === 'off') return 0
  return Math.round(Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, 400 + chars * 3.5)) * TYPE_FACTOR[speed])
}

export interface TypingFronts { written: number, decrypted: number, done: boolean }
export function typingFronts(total: number, elapsed: number, speed: TypingSpeed): TypingFronts {
  if (speed === 'off' || total <= 0) return { written: total, decrypted: total, done: true }
  const duration = typeDuration(total, speed)
  const written = Math.min(total, Math.floor(Math.max(0, elapsed) / duration * total))
  const gap = Math.min(total, CIPHER_GAP[speed])
  const behind = Math.max(0, written - gap)
  const catchup = Math.min(1, Math.max(0, elapsed - duration) / CATCHUP_MS[speed])
  const decrypted = Math.min(total, behind + Math.floor((total - behind) * catchup))
  return { written, decrypted, done: elapsed >= duration + CATCHUP_MS[speed] }
}

// Stop points: end of each word (spaces included); a very long word
// (URL, path, line of code) advances in groups of 8 characters.
export function wordStops(text: string, maxWord = 8): number[] {
  const stops: number[] = []
  const re = /\s*\S+\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length
    for (let p = m.index + maxWord; p < end - 2; p += maxWord) stops.push(p)
    stops.push(end)
  }
  if (!stops.length || stops[stops.length - 1] !== text.length) stops.push(text.length)
  return stops
}

// Characters visible after `elapsed` ms.
export function revealedAt(stops: number[], elapsed: number, duration: number): number {
  if (!stops.length) return 0
  if (elapsed >= duration) return stops[stops.length - 1]!
  const i = Math.floor(Math.max(0, elapsed) / duration * stops.length)
  return i <= 0 ? 0 : stops[Math.min(i, stops.length) - 1]!
}

// Survey of the content: text nodes (excluding layout whitespace) with their
// position in the revealed text, elements with the position of their start.
// `atomic(el)`: element shown as a block (code block header);
// `keep(el)`: never hidden, only emptied (cells: a table row
// keeps its columns).
export interface PlanOptions { atomic?: (n: RevealNode) => boolean, keep?: (n: RevealNode) => boolean }
export function planReveal(root: RevealNode, { atomic = () => false, keep = () => false }: PlanOptions = {}): RevealPlan {
  const texts: TextEntry[] = []
  const elems: ElemEntry[] = []
  let pos = 0
  let flat = ''
  const walk = (n: RevealNode) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        const full = c.nodeValue || ''
        if (!full.trim()) continue
        texts.push({ node: c, full, start: pos })
        pos += full.length
        flat += full
      } else if (c.nodeType === 1) {
        const e: ElemEntry = { node: c, start: pos, text: false, keep: keep(c) }
        elems.push(e)
        if (!atomic(c)) walk(c)
        e.text = pos > e.start
      }
    }
  }
  walk(root)
  return { texts, elems, total: pos, stops: wordStops(flat), shown: -1, written: -1 }
}

// Shows the first `n` characters. Element with text: hidden while
// that text has not started; without text (image, rule, atomic header):
// shown as soon as what precedes it is written. `trail`: the cipher trail
// follows (Terminal mode); the element starting right at `n` is then shown
// to carry it (new paragraph opening on glyphs).
export function applyReveal(plan: RevealPlan, n: number, trail = false, written = n) {
  if (n === plan.shown && written === plan.written) return
  plan.shown = n
  plan.written = written
  for (const t of plan.texts) {
    const v = t.full.slice(0, Math.max(0, n - t.start))
    if (t.node.nodeValue !== v) t.node.nodeValue = v
  }
  const edge = trail && written < plan.total ? written + 1 : written
  for (const e of plan.elems) {
    const hide = !e.keep && written < plan.total && (e.text ? e.start >= edge : e.start > written)
    if (Boolean(e.node.hidden) !== hide) e.node.hidden = hide
  }
}

// ------------------------------------------------------------ cipher band
// Each portion keeps its real characters in the flow, under the glyphs
// painted in CSS. A band may cross several Markdown nodes.
export const TRAIL_GLYPHS = '#%@&$*+=-/\\|<>01{}[]~^:;_!?'

// Old choices get their original rate back. A new device
// starts at Medium, with cipher text enabled.
export function parseTypingSettings(speed: string | null, encrypted: string | null, oldMode: string | null, oldSwitch: string | null): { speed: TypingSpeed, encrypted: boolean } {
  const migrated = oldMode === 'off' || oldSwitch === '0' ? 'off' : oldMode === 'plain' || oldMode === 'terminal' ? 'fast' : 'medium'
  return {
    speed: speed === 'off' || speed === 'fast' || speed === 'medium' || speed === 'slow' ? speed : migrated,
    encrypted: encrypted === '0' ? false : encrypted === '1' ? true : oldMode !== 'plain',
  }
}
export const effectiveTypingSpeed = (speed: TypingSpeed, reducedMotion: boolean): TypingSpeed => (reducedMotion ? 'off' : speed)
export const encryptedTextActive = (speed: TypingSpeed, encrypted: boolean, reducedMotion: boolean): boolean =>
  effectiveTypingSpeed(speed, reducedMotion) !== 'off' && encrypted
export interface CipherSegment { node: RevealNode, text: string }
export function cipherSegments(plan: RevealPlan, decrypted: number, written: number): CipherSegment[] {
  if (written <= decrypted) return []
  const segments: CipherSegment[] = []
  for (const t of plan.texts) {
    if (t.start >= written) break
    const from = Math.max(0, decrypted - t.start)
    const to = Math.min(t.full.length, written - t.start)
    if (to > from) segments.push({ node: t.node, text: t.full.slice(from, to) })
  }
  return segments
}

// One glyph per character; whitespace stays whitespace (line breaks
// and code block indentation intact).
export function trailGlyphs(text: string, rand: () => number = Math.random): string[] {
  return Array.from(text, c => (/\s/.test(c) ? c : TRAIL_GLYPHS[Math.floor(rand() * TRAIL_GLYPHS.length)]!))
}

// Restores all the content (end, or tapping the message).
export function finishReveal(plan: RevealPlan) {
  applyReveal(plan, plan.total)
}

// Identity of a reply, stable when older slices are added
// above (the block key, for its part, contains the position in the list).
export const replyId = (it: { ts: string | null, text: string }) => `${it.ts || ''}|${it.text.length}|${it.text.slice(0, 64)}`

// Replies new to this device after a re-read; all become known.
// `following`: the conversation was already open and read live since
// (not its first read, nor the first after the background or offline):
// only then is the last new reply typed in (`animate`, the setting).
// Otherwise new replies show at once, the first one under a "New" divider
// (`fresh`), if this device knew some replies before (`baseline`): never
// on a first open, where everything would be new.
export interface NewReplies { typing: string | null, fresh: string | null }
export function sortNewReplies(known: Set<string>, replies: string[], o: { following: boolean, animate: boolean, baseline: boolean }): NewReplies {
  let first: string | null = null
  let last: string | null = null
  for (const id of replies) {
    if (!known.has(id)) {
      known.add(id)
      first ??= id
      last = id
    }
  }
  if (o.following) return { typing: o.animate ? last : null, fresh: null }
  return { typing: null, fresh: o.baseline ? first : null }
}

// The kept end read after the server's answer: as if read first (all its
// replies known), the first reply it lacks was missed by this device. Only
// one written after its last message: older ones were never in it.
interface Said { role: string, ts: string | null, text: string }
export function missedReply(kept: Said[], current: Said[]): string | null {
  const seen = new Set(kept.filter(i => i.role === 'assistant').map(replyId))
  const end = kept.reduce((m, i) => Math.max(m, i.ts ? Date.parse(i.ts) || -Infinity : -Infinity), -Infinity)
  for (const it of current) {
    if (it.role !== 'assistant' || seen.has(replyId(it))) continue
    if (end === -Infinity || (it.ts && Date.parse(it.ts) > end)) return replyId(it)
  }
  return null
}
