// Replying to several questions of an agent in one message.
// Each question of a reply (a sentence ending with "?" in a paragraph or a
// list item, never in code) gets a small "↳ Reply" button right after it; a
// tap appends a reference to it to the draft (shared/reference.ts), followed
// by an empty line for the answer:
//   ↳ Quote point 11:37 : Can you plug the box in over Ethernet? —
//   No, not for now.
//   ↳ Quote point 11:37 : Shall I send the request to the coordinator? —
//   Yes.
// The draft text is the only state: the quotes shown above the field, the
// "quoted" state of the buttons and their removal are all read from it.
// A point that asks nothing (a list item, a paragraph without a question) can
// be quoted the same way, to discuss it. How the two show is a setting
// (ReplyStyle): the markup below is the same for every style, main.css draws it.
import { type Reference, type TextRef, decisionRef, pointRef, isRefLine, refLine, refsIn, sameRef, tableId } from '../../shared/reference'
import { createRenderCache } from './renderCache'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
// What may close a question after its "?": quotes, brackets, emphasis, spaces.
const QUESTION_END = /\?[\s"'»”’)\]*_~]*$/
// A "?" closed by a quote mark belongs to quoted words (what the user asked,
// a label): 'You asked "can it be faster?"' is a statement.
const QUOTED_END = /\?\s*["'»”’][\s"'»”’)\]*_~]*$/
// Sentence boundary: end punctuation (and its closers) followed by a space,
// so that "v1.2" or "?x=1" never cuts a sentence; never before a French
// spaced "?", "!", ":" or ";" ("en Ethernet… ?"), nor before a lowercase
// letter ('"Why?" you asked', "e.g. this").
const SENTENCE_BREAK = /(?<=[.!?…]["'»”’)\]*_~]*)\s+(?=[^?!:;»\p{Ll}])/gu
// A statement that answers the question before it: the agent was not asking.
const SELF_ANSWER = /^[\s"'«“‘(*_~]*(?:yes|yep|no|nope|because|oui|non|si|parce\s+qu|car)(?![\p{L}\p{N}])/iu
const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu)?.length || 0
const isQuestion = (s: string) => QUESTION_END.test(s) && !QUOTED_END.test(s) && words(s) > 0

// A question of a block of text: its words on one line, and where it sits in
// the block (`end` is right after its "?" and what closes it).
export interface Question { text: string, start: number, end: number }

// Questions asked by a block of text, in order. Consecutive question
// sentences are one question to answer ("Shall I push? Or wait?"); sentences
// that are not questions separate them, wherever they are in the block:
//   "Done. Shall I start step 1 now? A slot is free." → "Shall I start step 1 now?"
// A question the block answers itself ("Is it done? Yes.") or a one-word
// lead-in to a statement ("Why? Because…") is not one to reply to.
export function questionsIn(text: string): Question[] {
  if (!text.includes('?')) return []
  const sentences: { start: number, end: number, q: boolean }[] = []
  let from = 0
  const push = (to: number) => {
    const raw = text.slice(from, to)
    const start = from + raw.length - raw.trimStart().length
    const end = from + raw.trimEnd().length
    if (end > start) sentences.push({ start, end, q: isQuestion(text.slice(start, end)) })
  }
  for (const m of text.matchAll(SENTENCE_BREAK)) {
    push(m.index)
    from = m.index + m[0].length
  }
  push(text.length)
  const out: Question[] = []
  for (let i = 0; i < sentences.length; i++) {
    if (!sentences[i]!.q) continue
    let j = i
    while (j + 1 < sentences.length && sentences[j + 1]!.q) j++
    const start = sentences[i]!.start
    const end = sentences[j]!.end
    const next = sentences[j + 1]
    const q = oneLine(text.slice(start, end))
    const rhetorical = next && (SELF_ANSWER.test(text.slice(next.start, next.end)) || (i === j && words(q) < 2))
    if (!rhetorical) out.push({ text: q, start, end })
    i = j
  }
  return out
}

// References of a draft (see shared/reference.ts): one line each.
export const quotesIn = refsIn
const find = (draft: string, ref: Reference) => refsIn(draft).find(q => sameRef(q, ref)) || null
export const isQuoted = (draft: string, ref: Reference) => find(draft, ref) !== null

// Draft with the reference appended at the end (one reference / answer pair
// after the other, in order) and an empty line below it for the answer. A
// reference still unanswered is closed by an empty line, so the next one does
// not read as sharing its answer. Null if it is already there.
export function addQuote(draft: string, ref: Reference): string | null {
  const line = refLine(ref)
  if (!line || isQuoted(draft, ref)) return null
  const base = String(draft || '').replace(/\s+$/, '')
  const sep = !base ? '' : isRefLine(base.slice(base.lastIndexOf('\n') + 1)) ? '\n\n' : '\n'
  return `${base}${sep}${line}\n`
}

// Draft without one of its references (its answer stays).
export function removeQuote(draft: string, q: TextRef): string {
  return (draft.slice(0, q.start) + draft.slice(q.end)).replace(/^\n+/, '')
}

// A closed question: one that "yes" or "no" answers in full, so it gets the
// one-tap "Yes" / "No" buttons next to its "↳ Reply". The rule is cautious, in
// doubt a question is open (Reply alone):
// - a single sentence (two questions in a row, "Shall I push? Or wait?", are
//   one reply target: a single "yes" would not say which);
// - it starts, after an optional "Last point:" and a small connector ("And",
//   "So", "Et", "Donc"…), with a yes/no opening: an English auxiliary and its
//   subject ("Shall I…", "Do you…", "Is it…"), a short elliptical form ("Want
//   me to…", "OK to…"), or their French counterparts ("Est-ce que…", "Je
//   lance… ?", "On…", "Tu…", "Dois-je…", any inversion "Veux-tu…"); or it ends
//   with a tag (", OK?", ", d'accord ?");
// - it holds no alternative ("or", "ou"), no interrogative word ("which",
//   "how", "quel", "comment"…, and "où", "quand", "qui" as its last word) and
//   no negation ("Shouldn't I…", "Tu ne veux pas… ?": "yes" is ambiguous).
const EN_SUBJECT = 'i|we|you|it|this|that|these|those|there|they|he|she|the|your|my|our|everything|anything|all'
const OPENING = new RegExp(`^(?:${[
  `(?:shall|should|can|could|may|will|would|do|does|did|is|are|was|were|have|has|am|must)\\s+(?:${EN_SUBJECT})(?![\\p{L}\\p{N}'’])`,
  '(?:want me to|ok(?:ay)? (?:to|if|for|with)|sounds? good|good to go|go ahead|proceed|ready (?:to|for)|agreed|makes? sense|all good)(?![\\p{L}\\p{N}])',
  'est-ce(?![\\p{L}\\p{N}])',
  '(?:je|tu|vous|nous|ça)\\s',
  'on\\s+(?!(?:the|a|an|this|that|these|those|my|your|our|its|top|main|all|both|each|every)(?![\\p{L}\\p{N}]))',
  '(?:j|c)[\'’]\\p{L}',
  '(?:ok|d[\'’]accord) pour(?![\\p{L}\\p{N}])',
  '\\p{L}+-(?:t-)?(?:je|tu|il|elle|on|nous|vous|ils|elles)(?![\\p{L}\\p{N}])',
].map(r => `(?:${r})`).join('|')})`, 'iu')
const TAG = /,\s*(?:ok|okay|right|agreed|d['’]accord|ça te va|ça vous va|c['’]est bon|non)\s*\?[\s"'»”’)\]*_~]*$/iu
const CONNECTOR = /^(?:and|so|then|also|but|now|et|donc|alors|sinon|mais|du coup)[,\s]+/iu
const ALTERNATIVE = /(?<![\p{L}\p{N}])(?:or|ou|ou bien|plutôt|either|versus|vs)(?![\p{L}\p{N}])/iu
const INTERROGATIVE = /(?<![\p{L}\p{N}])(?:what|which|who|whom|whose|where|when|why|how|quel|quels|quelle|quelles|quoi|comment|combien|pourquoi|lequel|laquelle|lesquels|lesquelles)(?![\p{L}\p{N}])/iu
const INTERROGATIVE_LAST = /(?<![\p{L}\p{N}])(?:où|quand|qui)\s*\?/iu
const NEGATION = /(?<![\p{L}\p{N}])(?:not|never|ne|pas|jamais)(?![\p{L}\p{N}])|n['’]t(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])n['’]\p{L}/iu
// A question that clearly asks for words: an alternative or an interrogative
// word. (The rows of a decision table are terse, "Merge now?": they keep
// their Yes / No unless they are open in this sense.)
export function isOpenQuestion(text: string): boolean {
  const q = oneLine(text)
  return isQuestion(q) && (ALTERNATIVE.test(q) || INTERROGATIVE.test(q) || INTERROGATIVE_LAST.test(q))
}
export function isClosedQuestion(text: string): boolean {
  const q = oneLine(text)
  if ((q.match(/\?/g) || []).length !== 1 || !isQuestion(q)) return false
  if (ALTERNATIVE.test(q) || INTERROGATIVE.test(q) || INTERROGATIVE_LAST.test(q) || NEGATION.test(q)) return false
  if (TAG.test(q)) return true
  // The whole sentence, or what follows its last colon ("Last point: shall I…?").
  return [q, q.slice(q.lastIndexOf(': ') + 1)].some((part) => {
    let head = part.replace(/^[\s"'«“‘(*_~]+/, '')
    for (let m = CONNECTOR.exec(head); m; m = CONNECTOR.exec(head)) head = head.slice(m[0].length)
    return OPENING.test(head)
  })
}

// One-tap answers: "Yes" / "No" under the reference to a closed question, as
// Reply and typing would write them:
//   ↳ Quote point 11:37 : Shall I merge the branch now? —
//   Yes
export type Answer = 'yes' | 'no'
// What a tap may have written, in either language: only that is replaced.
const TAPPED: Record<Answer, RegExp> = { yes: /^(?:yes|oui)\.?$/i, no: /^(?:no|non)\.?$/i }
export const tappedAnswer = (s: string): Answer | null => {
  const v = s.trim()
  return TAPPED.yes.test(v) ? 'yes' : TAPPED.no.test(v) ? 'no' : null
}
// Where the answer to a reference of the draft sits: from its end to the next
// reference (or the end of the draft).
function answerSpan(draft: string, ref: Reference): { start: number, end: number } | null {
  const quotes = refsIn(draft)
  const i = quotes.findIndex(q => sameRef(q, ref))
  return i < 0 ? null : { start: quotes[i]!.end, end: quotes[i + 1]?.start ?? draft.length }
}
// What the draft answers to a reference: its text ("" when nothing is written
// yet), null when the reference is not there.
export function answerOf(draft: string, ref: Reference): string | null {
  const at = answerSpan(draft, ref)
  return at ? draft.slice(at.start, at.end).trim() : null
}
// Where the caret goes after a one-tap answer: right after the answer written
// under the reference (an answer may sit above others), else the end of the
// draft (the reference is gone: "OK to all" taken back).
export function answerEnd(draft: string, ref: Reference): number {
  const text = String(draft || '')
  const at = answerSpan(text, ref)
  if (!at) return text.length
  const answer = text.slice(at.start, at.end).replace(/\s+$/, '')
  return answer.trim() ? at.start + answer.length : at.start
}
// Draft with the reference and its answer, in one tap. A reference already
// there gets the answer under it; a "yes" or "no" written by an earlier tap
// is replaced. Null when there is nothing to change: the same answer is
// there, or the user wrote their own (never overwritten).
export function addAnswer(draft: string, ref: Reference, word: string): string | null {
  const base = addQuote(draft, ref) ?? String(draft || '')
  const at = answerSpan(base, ref)
  if (!at) return null
  const current = base.slice(at.start, at.end).trim()
  if (current === word || (current && !tappedAnswer(current))) return null
  const head = base.slice(0, at.start)
  return `${head}${head.endsWith('\n') ? '' : '\n'}${word}\n${base.slice(at.end)}`
}

// Decision table: a Markdown table whose rows are numbered questions, as a
// coordinator writes them ("# | Question | My advice"). Under it, each row is
// answered in one tap or quoted for an answer in words, and the whole table
// accepted, each time under a reference that names the message, the row and
// the table (the code after "~", see shared/reference.ts):
//   ↳ Quote decision 11:37 #3 ~k3f : Tag the release today? —
//   Yes
//   ↳ Quote decisions 11:37 #1-4 ~k3f : Tag the release today? · … —
//   OK to all
// The reference is always written, even for the agent's last message: the
// agent may write another one before the answer is sent, and "3: yes" alone
// would then be read against that one. The table must have:
// - a number column: a header that says so ("#", "N°", "No", "Num", "ID",
//   "Q") over cells that all hold a short number ("1", "2.", "Q3"), each once;
// - a question column, by one of three signs: a header that names it
//   ("Question", "Decision", "Choix"…); or cells that all end with "?"; or an
//   advice column next to it ("Avis", "Recommendation", "Suggestion"…), the
//   question then being the first column left.
// Any other table (a list of files, a comparison) gets nothing.
const NUM_HEAD = /^(?:#|n[°º]|no\.?|num(?:[ée]ro)?\.?|id|q)$/i
const NUM_CELL = /^(?:[#qd]|n[°º])?\s*\d{1,3}[.)]?$/i
const QUESTION_HEAD = /question|d[ée]cision|choix|choice|to decide|à décider|à trancher/i
const ADVICE_HEAD = /avis|recomm|suggestion|proposition|proposal|opinion|my take|my pick|conseil|advice/i
// `all`: the whole table the row belongs to (its rows, their questions), when it has several rows.
// `table`: rank of that table among the decision tables of its message, from 1.
export interface DecisionRow { n: string, text: string, all?: { n: string, text: string } | null, table?: number }
export function decisionRows(header: string[], rows: string[][]): DecisionRow[] | null {
  const head = header.map(oneLine)
  const body = rows.map(r => r.map(oneLine))
  if (head.length < 2 || !body.length || body.some(r => r.length < head.length)) return null
  const column = (i: number) => body.map(r => r[i]!)
  const label = (cell: string) => cell.replace(/[.)]$/, '')
  const num = head.findIndex((h, i) => NUM_HEAD.test(h) && column(i).every(c => NUM_CELL.test(c))
    && new Set(column(i).map(c => label(c).toLowerCase())).size === body.length)
  if (num < 0) return null
  const others = head.map((_, i) => i).filter(i => i !== num)
  const advice = others.filter(i => ADVICE_HEAD.test(head[i]!))
  let question = others.find(i => QUESTION_HEAD.test(head[i]!) && !advice.includes(i))
  question ??= others.find(i => column(i).every(isQuestion))
  if (question === undefined && advice.length) question = others.find(i => !advice.includes(i))
  if (question === undefined || column(question).some(c => !words(c))) return null
  return body.map(r => ({ n: label(r[num]!), text: r[question]! }))
}

// Row numbers as a reference names them: the numbers that are there, a run
// of consecutive ones as a range ("1-4", "1-2,4", "Q1,Q3").
export function rowNumbers(labels: string[]): string {
  const runs: string[][] = []
  for (const label of labels) {
    const run = runs.at(-1)
    const prev = run ? /^(\D*)(\d+)$/.exec(run.at(-1)!) : null
    const cur = /^(\D*)(\d+)$/.exec(label)
    if (run && prev && cur && prev[1] === cur[1] && Number(cur[2]) === Number(prev[2]) + 1) run.push(label)
    else runs.push([label])
  }
  return runs.map(r => (r.length > 1 ? `${r[0]}-${r.at(-1)}` : r[0]!)).join(',')
}
// The whole table as "OK to all" refers to it: its row numbers and questions.
export const tableOf = (rows: DecisionRow[]) => ({ n: rowNumbers(rows.map(r => r.n)), text: rows.map(r => r.text).join(' · ') })
// `id`: code of the message the table is in (shared/reference.ts messageId).
export const rowRef = (row: DecisionRow, time: string | null, id?: string | null) => decisionRef(row.n, row.text, time, false, tableId(id, row.table))
export const tableRef = (all: { n: string, text: string }, time: string | null, id?: string | null, table = 1) => decisionRef(all.n, all.text, time, true, tableId(id, table))
// "OK to all" / "OK tout": what a tap writes under the reference to the table.
const OK_ALL = /^ok\s+(?:to\s+all|tout|pour\s+tout)\s*[.!]?$/i
// Draft with the table accepted, or with that taken back when it is there (a
// second tap): the reference goes, and the words under it when a tap wrote them.
export function toggleOkAll(draft: string, ref: Reference, phrase: string): string {
  const at = find(draft, ref)
  if (!at) return addAnswer(draft, ref, phrase) ?? draft
  const span = answerSpan(draft, ref)!
  const end = OK_ALL.test(draft.slice(span.start, span.end).trim()) ? span.end : at.end
  return (draft.slice(0, at.start) + draft.slice(end)).replace(/^\n+/, '')
}
// A row is settled once the draft refers to it (answered or quoted), or
// accepts its whole table.
export const rowSettled = (draft: string, row: DecisionRow, time: string | null, id?: string | null) =>
  isQuoted(draft, rowRef(row, time, id)) || Boolean(row.all && isQuoted(draft, tableRef(row.all, time, id, row.table)))

// How many questions of a reply (its questions and the rows of its decision
// tables) the draft does not answer yet: the reminder above the field. A
// question counts as answered once it is quoted, a row once it is settled.
// A reply that asks one thing only is answered by any words of the user's:
// there is nothing to tell apart, quoting it would be a formality.
export function unansweredCount(targets: Pick<ReplyTargets, 'questions' | 'rows'>, draft: string, time: string | null, id?: string | null): number {
  const left = targets.questions.filter(q => !isQuoted(draft, pointRef(q.text, time, id))).length + targets.rows.filter(r => !rowSettled(draft, r, time, id)).length
  const single = targets.questions.length + targets.rows.length === 1
  return single && String(draft || '').split('\n').some(l => l.trim() && !isRefLine(l)) ? 0 : left
}

// Text of a block as the reader sees it, with the text node of each
// character: up to its first nested block (sub-list, code block), a line break
// counting as a space. `masked` is the same text with the sentence punctuation
// of inline code blanked out: "`a?.b`" or "`cmd?`" asks nothing.
const NESTED = /^(UL|OL|PRE|DIV|BLOCKQUOTE|TABLE)$/
function ownText(el: Element) {
  const parts: { node: Text, start: number }[] = []
  let raw = ''
  let masked = ''
  const walk = (parent: Node, code: boolean): boolean => {
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) {
        const data = (n as Text).data
        parts.push({ node: n as Text, start: raw.length })
        raw += data
        masked += code ? data.replace(/[?!.…]/g, 'x') : data
      } else if (n.nodeType === 1) {
        const tag = (n as Element).tagName
        if (NESTED.test(tag)) return false
        if (tag === 'BR') {
          raw += '\n'
          masked += '\n'
        } else if (!walk(n, code || tag === 'CODE' || tag === 'KBD')) return false
      }
    }
    return true
  }
  walk(el, false)
  return { parts, raw, masked }
}

// How the reply targets show in a conversation (Settings › Conversation):
// `icon`, a small "↳" after each question and each point; `text`, the words of
// the question are the button and a point is clicked; `list`, a number after
// each question and the questions listed under the message.
export const REPLY_STYLES = ['icon', 'text', 'list'] as const
export type ReplyStyle = typeof REPLY_STYLES[number]
export const parseReplyStyle = (v: string | null | undefined): ReplyStyle =>
  (REPLY_STYLES as readonly string[]).includes(v || '') ? v as ReplyStyle : 'icon'

export interface ReplyLabels { reply: string, quoted: string, discuss: string, yes: string, no: string, okAll: string, decisions: string }

// A point worth discussing: a few words that ask nothing and do not merely
// introduce what follows ("Three things to note:").
const POINT_MIN_WORDS = 3
export const isPoint = (text: string) => words(text) >= POINT_MIN_WORDS && !/[:：]$/.test(text.trim())

// Reply targets in the HTML of an agent reply. Each question gets a button
// right after it (`.q-reply`, numbered in reading order) and its words are
// wrapped (`.q-text`, same number); a closed question also gets its one-tap
// answers (`.q-ans`: `.q-yes`, `.q-no`); each point (`.q-pt`: a list item or a
// paragraph with no question) gets a button at its end (`.q-point`). The
// labels come from data attributes (CSS content): no text node, so the
// typewriter and the copied text ignore them.
export function markQuestions(root: ParentNode, labels: ReplyLabels) {
  const wrapped = new Map<HTMLElement, HTMLElement[]>()
  for (const el of root.querySelectorAll<HTMLElement>('p, li')) {
    if (el.closest('pre, code, .code-block, blockquote, table')) continue
    // A loose list item holds paragraphs: they carry the button.
    if (el.tagName === 'LI' && el.querySelector(':scope > p')) continue
    const { parts, raw, masked } = ownText(el)
    const last = raw.trimEnd().length
    const questions = questionsIn(masked)
    if (!questions.length && isPoint(raw)) {
      const point = oneLine(raw)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'q-point'
      btn.dataset.q = point
      btn.dataset.l = labels.discuss
      btn.dataset.lq = labels.quoted
      btn.setAttribute('aria-label', `${labels.discuss}: ${point}`)
      el.classList.add('q-pt')
      // At the end of the point's own text, before a nested list or code block.
      el.insertBefore(btn, [...el.children].find(c => NESTED.test(c.tagName)) || null)
    }
    // From the last one: a text node cut for a button keeps its start.
    for (const { start, end } of questions.reverse()) {
      const part = parts.findLast(p => p.start < end)
      if (!part) continue
      const q = oneLine(raw.slice(start, end))
      const btn = document.createElement('button')
      btn.type = 'button'
      // `q-mid`: more text follows in the block (see main.css).
      btn.className = end < last ? 'q-reply q-mid' : 'q-reply'
      btn.dataset.q = q
      btn.dataset.l = labels.reply
      btn.dataset.lq = labels.quoted
      btn.setAttribute('aria-label', `${labels.reply}: ${q}`)
      const cut = end - part.start
      if (cut < part.node.data.length) part.node.splitText(cut)
      // After the emphasis, link or code the question ends in, not inside it.
      let at: Node = part.node
      while (at.parentNode && at.parentNode !== el && (!at.nextSibling || /^(A|CODE|KBD)$/.test((at.parentNode as Element).tagName))) at = at.parentNode
      at.parentNode!.insertBefore(btn, at.nextSibling)
      // A closed question: "Yes" / "No" right after its Reply button.
      if (isClosedQuestion(q)) {
        btn.dataset.c = '1'
        for (const a of ['no', 'yes'] as const) {
          const ans = document.createElement('button')
          ans.type = 'button'
          ans.className = `q-ans q-${a}`
          ans.dataset.q = q
          ans.dataset.a = a
          ans.dataset.l = labels[a]
          ans.setAttribute('aria-label', `${labels[a]}: ${q}`)
          ans.setAttribute('aria-pressed', 'false')
          btn.after(ans)
        }
      }
      // The words of the question, text node by text node (a question may
      // cross emphasis, a link or inline code); what is before it stays in
      // the node the earlier questions still point to.
      const spans: HTMLElement[] = []
      for (const p of parts.filter(x => x.start < end).reverse()) {
        const len = p.node.data.length
        if (p.start + len <= start) break
        const from = Math.max(0, start - p.start)
        const to = Math.min(len, end - p.start)
        if (to <= from) continue
        if (to < len) p.node.splitText(to)
        const node = from > 0 ? p.node.splitText(from) : p.node
        if (!node.data.trim()) continue
        const span = document.createElement('span')
        span.className = 'q-text'
        node.replaceWith(span)
        span.appendChild(node)
        spans.push(span)
      }
      wrapped.set(btn, spans)
    }
  }
  markDecisions(root, labels)
  markChoices(root)
  let n = 0
  for (const btn of root.querySelectorAll<HTMLElement>('.q-reply')) {
    btn.dataset.n = String(++n)
    for (const span of wrapped.get(btn) || []) span.dataset.n = btn.dataset.n
  }
}

// The buttons of a `choices` line (utils/markdown.ts) answer the last
// question written before them: each carries it (`data-q`). Without one, a
// tap quotes the whole message.
function markChoices(root: ParentNode) {
  let question: string | null = null
  for (const el of root.querySelectorAll<HTMLElement>('.q-reply, .w-choices')) {
    if (el.classList.contains('q-reply')) question = el.dataset.q || null
    else if (question) for (const b of el.querySelectorAll<HTMLElement>('.q-choice')) b.dataset.q = question
  }
}

// The panel under a decision table (`.q-table`, see decisionRows): "OK to
// all" (`.q-all`), then per row (`.q-trow`) its number and question (`.q-tl`),
// "Yes" / "No" (`.q-tans`) and Reply (`.q-tquote`). No text node here either: every
// word comes from a data attribute. `.q-all` carries the row numbers and the
// questions of its table (`n`, `q`), as "OK to all" refers to them; the panel
// carries the rank of its table among those of the message (`t`).
function markDecisions(root: ParentNode, labels: ReplyLabels) {
  const cells = (tr: Element) => [...tr.children].filter(c => /^T[DH]$/.test(c.tagName)).map(c => c.textContent || '')
  let rank = 0
  for (const table of root.querySelectorAll('table')) {
    if (table.closest('pre, code, .code-block, blockquote') || table.parentElement?.closest('table')) continue
    const head = table.querySelector(':scope > thead > tr')
    const rows = head ? decisionRows(cells(head), [...table.querySelectorAll(':scope > tbody > tr')].map(cells)) : null
    if (!rows) continue
    const el = (tag: string, cls: string, data: Record<string, string>, label?: string) => {
      const e = document.createElement(tag)
      e.className = cls
      Object.assign(e.dataset, data)
      if (tag === 'button') (e as HTMLButtonElement).type = 'button'
      if (label) e.setAttribute('aria-label', label)
      return e
    }
    const panel = el('div', 'q-table', { t: String(++rank) }, labels.decisions)
    panel.setAttribute('role', 'group')
    const top = el('div', 'q-table-h', { l: labels.decisions })
    if (rows.length > 1) {
      const table = tableOf(rows)
      const all = el('button', 'q-all', { l: labels.okAll, n: table.n, q: table.text }, labels.okAll)
      all.setAttribute('aria-pressed', 'false')
      top.append(all)
    }
    panel.append(top)
    for (const row of rows) {
      const line = el('div', 'q-trow', { n: row.n, q: row.text })
      line.append(el('span', 'q-tl', { n: row.n, l: row.text }))
      // A row that asks an open question ("Which name…?") is answered in words.
      for (const a of isOpenQuestion(row.text) ? [] : ['yes', 'no'] as const) {
        const ans = el('button', `q-tans q-${a}`, { n: row.n, a, l: labels[a] }, `${row.n} · ${labels[a]}: ${row.text}`)
        ans.setAttribute('aria-pressed', 'false')
        line.append(ans)
      }
      line.append(el('button', 'q-tquote', { n: row.n, l: labels.reply, lq: labels.quoted }, `${labels.reply}: ${row.n}. ${row.text}`))
      panel.append(line)
    }
    table.after(panel)
  }
}

// Budgets of the two caches below, in characters (see utils/markdown.ts for
// the reasoning): the first holds each reply's HTML twice (as key and marked),
// the second only as key. Together with the Markdown cache: 13 MB of strings
// at most when the text is Latin-1.
export const MARKED_CACHE_CHARS = 6_000_000
export const TARGETS_CACHE_CHARS = 3_000_000
const REPLY_CACHE_ENTRIES = 2000
const marked = createRenderCache<{ labels: string, out: string }>(REPLY_CACHE_ENTRIES, MARKED_CACHE_CHARS)
// HTML of an agent reply with its question buttons (cached: the
// conversation is re-read every 1.5 s). One entry per reply: the labels only
// change with the language.
export function withQuestions(html: string, labels: ReplyLabels): string {
  if (typeof document === 'undefined') return html
  const sig = `${labels.reply}\u0000${labels.discuss}\u0000${labels.yes}\u0000${labels.okAll}`
  const hit = marked.get(html)
  if (hit && hit.labels === sig) return hit.out
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  markQuestions(tpl.content, labels)
  const out = tpl.innerHTML
  marked.set(html, { labels: sig, out }, html.length + out.length)
  return out
}
// A reply's HTML that will not be shown again (a version replaced by a longer
// one while the agent writes): nothing derived from it is kept.
export function forgetReply(html: string) {
  const gone = marked.delete(html)
  targets.delete(gone ? gone.out : html)
}
export const replyCacheStats = () => ({ marked: marked.stats(), targets: targets.stats() })

// What a reply offers to answer: its questions in order, the rows of its
// decision tables, and for the "list" style how many
// points it has, and whether "+ Quote a point" is worth offering (`pick`):
// only when there is a choice to make, that is a point in a list, or two
// points or more. A reply of plain prose in one paragraph is a single point:
// the whole message is the thing to reply to.
// Read from the marked HTML, cached with it.
export interface ReplyTargets { questions: { n: string, text: string, closed: boolean }[], rows: DecisionRow[], points: number, pick: boolean }
// A row of the panel under a decision table, read back from its markup.
export const tableRank = (el: HTMLElement) => Number(el.closest<HTMLElement>('.q-table')?.dataset.t) || 1
export function rowOf(el: HTMLElement): DecisionRow {
  const all = el.closest('.q-table')?.querySelector<HTMLElement>('.q-all')
  return { n: el.dataset.n || '', text: el.dataset.q || '', all: all ? { n: all.dataset.n || '', text: all.dataset.q || '' } : null, table: tableRank(el) }
}
const targets = createRenderCache<ReplyTargets>(REPLY_CACHE_ENTRIES, TARGETS_CACHE_CHARS)
export function replyTargets(html: string): ReplyTargets {
  let out = targets.get(html)
  if (!out) {
    out = { questions: [], rows: [], points: 0, pick: false }
    if (typeof document !== 'undefined' && html.includes('class="q-')) {
      const tpl = document.createElement('template')
      tpl.innerHTML = html
      out.questions = [...tpl.content.querySelectorAll<HTMLElement>('.q-reply')].map(b => ({ n: b.dataset.n || '', text: b.dataset.q || '', closed: b.dataset.c === '1' }))
      out.rows = [...tpl.content.querySelectorAll<HTMLElement>('.q-trow')].map(rowOf)
      const points = [...tpl.content.querySelectorAll('.q-point')]
      out.points = points.length
      out.pick = points.length > 1 || points.some(b => b.closest('li'))
    }
    targets.set(html, out, html.length)
  }
  return out
}
