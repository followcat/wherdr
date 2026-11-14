// Markdown of replies: marked for rendering, DOMPurify so that nothing
// an agent might have written gets executed. Cached by text (the
// conversation is re-read every 1.5 s), within a budget (see MD_CACHE_CHARS).
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { boardLink, isAppLink } from '../../shared/appLinks'
import { uiPlaceLabel } from '../../shared/uiOpen'
import { pathCandidate } from '../../shared/filePaths'
import { codeKind } from './codeKind'
import { highlightCode } from './codeHighlight'
import { createRenderCache, createSupersedeTracker } from './renderCache'
import { blockCommand, inlineCommand } from './shellCommand'
import { svgPreview } from './svgPreview'
import { parseStatusBlock, STATUS_MAX } from '../../shared/statusBlock'
import { parseOpenLine } from '../../shared/uiOpen'
import { parseActionLine } from '../../shared/uiActions'
import { parseShowLine } from '../../shared/uiShow'

let hooked = false
// Budget of the cache, in characters of text + HTML: about 4 MB of strings
// (twice that if a text is not Latin-1), small for a phone tab yet above what
// one 2 MiB page of transcript renders to, so a long conversation on screen
// is not parsed again at every re-read.
export const MD_CACHE_ENTRIES = 5000
export const MD_CACHE_CHARS = 4_000_000
const cache = createRenderCache<string>(MD_CACHE_ENTRIES, MD_CACHE_CHARS)
export const mdCacheStats = () => cache.stats()
// A reply still being written: each longer version replaces the previous one
// instead of piling up. What was derived from the dropped HTML is told to go
// too (utils/questionReply.ts, wired in ChatView.vue).
const superseded = createSupersedeTracker()
const dropListeners = new Set<(html: string) => void>()
export function onMdDropped(fn: (html: string) => void) { dropListeners.add(fn) }

// `plain`: Markdown from a file kept on disk (a project's memory), shown
// outside a conversation. Its raw HTML must not restyle the app or draw
// controls over it: no `<style>`, no `style` attribute, no form or field. A
// task list's own checkbox (`- [ ]`, disabled) is kept. Code is never a
// control there (no path menu, no Run): only a code block's Copy. Raw HTML
// shows as text (a task's description), except in `doc`, sanitized as above.
// `doc`: a whole Markdown document read in the file explorer (implies
// `plain`). Line breaks follow Markdown (a single newline is a space), code
// blocks get light syntax colours and only Copy, inline code is never a
// control, and an image with a relative path keeps it in `data-src` (no
// request to the app's own address): FilesView loads it from the folder.
export interface MdOptions { plain?: boolean, doc?: boolean }
const PLAIN = { FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'option', 'optgroup', 'fieldset', 'legend', 'label', 'datalist', 'output', 'dialog'], FORBID_ATTR: ['style'] }
let plainNow = false
let docNow = false
const isRelativeUrl = (u: string) => !/^[a-z][a-z\d+.-]*:/i.test(u) && !u.startsWith('//') && !u.startsWith('#')

const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))
// An in-app address as an action button: an icon and a label (the link's
// text, or the place's name: "Open Settings › Phone"), never the raw address.
// ChatMarkdown.vue opens it through the router.
const appButton = (href: string, label: string) => `<a href="${escHtml(href)}" class="md-app-link"><span class="md-app-icon" aria-hidden="true"></span><span>${label}</span></a>`

// A `wherdr` fence: what an agent asks the conversation to draw instead of
// code, one element per line (`kind arg…`). A block with a line not
// understood stays an ordinary code block, never an error. Kinds:
// - `choices "A" | "B" | "C"`: 1 to 4 buttons (one alone is a one-click
//   confirm); a tap sends that text as the user's reply, quoted to the
//   question before the block (ChatView.vue).
//   ```wherdr
//   choices "Squash" | "Merge commit" | "Rebase"
//   ```
// - `task WHR-12`: the task's live card, read from the board
//   (ChatTaskCard.vue); a tap opens its sheet.
export interface WherdrChoices { kind: 'choices', options: string[] }
export interface WherdrTask { kind: 'task', id: string }
export type WherdrElement = WherdrChoices | WherdrTask
export const CHOICES_MIN = 1
export const CHOICES_MAX = 4
const CHOICE_MAX_CHARS = 80
const CHOICE = /^\s*"([^"]+)"\s*$/
function parseChoices(arg: string): WherdrChoices | null {
  const options: string[] = []
  for (const part of arg.split('|')) {
    const option = CHOICE.exec(part)?.[1]?.replace(/\s+/g, ' ').trim() || ''
    if (!option || option.length > CHOICE_MAX_CHARS || options.some(o => o.toLowerCase() === option.toLowerCase())) return null
    options.push(option)
  }
  return options.length >= CHOICES_MIN && options.length <= CHOICES_MAX ? { kind: 'choices', options } : null
}
const TASK_ID = /^[A-Za-z][\w.-]*-\d+$/
const parseTask = (arg: string): WherdrTask | null => TASK_ID.test(arg.trim()) ? { kind: 'task', id: arg.trim() } : null
const KINDS: Record<string, (arg: string) => WherdrElement | null> = { choices: parseChoices, task: parseTask }
export function parseWherdrBlock(text: string): WherdrElement[] | null {
  const out: WherdrElement[] = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const m = /^\s*([a-z]+)\s+(.*)$/.exec(line)
    const el = m && Object.hasOwn(KINDS, m[1]!) ? KINDS[m[1]!]!(m[2]!) : null
    if (!el) return null
    out.push(el)
  }
  return out.length ? out : null
}
// The options of a message's last `choices` line (Tasks to review's buttons).
export function messageChoices(text: string): string[] {
  const blocks = [...String(text || '').matchAll(/^```wherdr[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)]
  for (const b of blocks.reverse()) {
    const c = parseWherdrBlock(b[1]!)?.findLast(e => e.kind === 'choices')
    if (c?.kind === 'choices') return c.options
  }
  return []
}
// Its HTML. Each option rides in a data attribute, read back by ChatView.vue.
// Tasks side by side share one grid: each a placeholder that ChatMarkdown.vue
// fills live; until then a link to the task's sheet.
const taskHtml = (id: string) => `<div class="wd-task" data-task="${escHtml(id)}"><a href="${escHtml(boardLink({ task: id }))}"><code>${escHtml(id)}</code></a></div>`
function wherdrHtml(els: WherdrElement[]): string {
  let html = ''
  let tasks = ''
  for (const el of els) {
    if (el.kind === 'task') { tasks += taskHtml(el.id); continue }
    if (tasks) { html += `<div class="wherdr-block">${tasks}</div>`; tasks = '' }
    html += `<div class="w-choices" role="group">${el.options.map(o =>
      `<button type="button" class="q-choice" data-a="${escHtml(o)}">${escHtml(o)}</button>`).join('')}</div>`
  }
  return tasks ? `${html}<div class="wherdr-block">${tasks}</div>` : html
}

export function md(text: string, options: MdOptions = {}): string {
  // The modes never share a cached result.
  const key = options.doc ? `\0doc\0${text}` : options.plain ? `\0plain\0${text}` : text
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (!hooked) {
    hooked = true
    // Terminal-style framed code blocks: language + "Copy" button, and "Run"
    // on a shell command (shown only where the agent can run it, see
    // ChatView.vue). `data-cmd`: the command without its prompts, which Copy
    // and Run use (utils/shellCommand.ts).
    marked.use({
      renderer: {
        code({ text, lang }) {
          const l = escHtml((lang || '').split(/\s/)[0] || '')
          // A language fence is an explicit preview request. A normal HTML/XML
          // fence (including examples containing SVG) remains ordinary code.
          // A ```wherdr block of `status …` lines (shared/statusBlock.ts): one
          // slot per card, which ChatMarkdown.vue fills with a live card. Its
          // text stays the line, read as such before the card mounts.
          const status = plainNow || l.toLowerCase() !== 'wherdr' ? null : parseStatusBlock(text)
          if (status) {
            return `<div class="wherdr-block">${status.map(r => `<div class="status-slot" data-status-kind="${r.kind}" data-status-arg="${escHtml(r.arg)}">status ${r.kind}:${escHtml(r.arg)}</div>`).join('')}</div>`
          }
          // `open <in-app link>` lines: the cards of an agent's `ui open`
          // (shared/uiOpen.ts), kept in the conversation.
          const opens = plainNow || l.toLowerCase() !== 'wherdr' ? [] : text.split('\n').filter(x => x.trim())
          const links = opens.length && opens.length <= STATUS_MAX ? opens.map(parseOpenLine) : []
          if (links.length && links.every(Boolean)) {
            return `<div class="wherdr-block">${links.map(k => `<div class="open-slot" data-link="${escHtml(k!)}">open ${escHtml(k!)}</div>`).join('')}</div>`
          }
          // `show file|shots <arg>` lines: what an agent showed with `ui show` (shared/uiShow.ts).
          const shows = opens.length && opens.length <= STATUS_MAX ? opens.map(parseShowLine) : []
          if (shows.length && shows.every(Boolean)) {
            return `<div class="wherdr-block">${shows.map(x => `<div class="show-slot" data-what="${x!.what}" data-arg="${escHtml(x!.arg)}">show ${x!.what} ${escHtml(x!.arg)}</div>`).join('')}</div>`
          }
          // `action <id>` lines: an agent's `ui action` buttons (shared/uiActions.ts).
          const actions = opens.length && opens.length <= STATUS_MAX ? opens.map(parseActionLine) : []
          if (actions.length && actions.every(Boolean)) {
            return `<div class="wherdr-block">${actions.map(id => `<div class="action-slot" data-action="${id}">action ${id}</div>`).join('')}</div>`
          }
          if (!docNow && l.toLowerCase() === 'svg') {
            const src = svgPreview(text)
            const source = `<pre class="svg-source"${src ? ' hidden' : ''}><code class="language-svg">${escHtml(text)}</code></pre>`
            const head = `<div class="code-head"><span>svg</span><span class="code-tools">${src ? `<button type="button" class="svg-toggle" aria-pressed="false">${escHtml(t('Source'))}</button>` : ''}<button type="button" class="code-copy">${escHtml(t('Copy'))}</button></span></div>`
            return `<div class="code-block svg-block">${head}`
              + (src
                ? `<img class="svg-preview" src="${escHtml(src)}" alt="${escHtml(t('SVG preview'))}" role="button" tabindex="0" aria-label="${escHtml(t('Enlarge SVG preview'))}">${source}`
                : `<p class="svg-note">${escHtml(t('SVG preview unavailable. Source shown below.'))}</p>${source}`)
              + '</div>'
          }
          // Only in a conversation: a file read elsewhere shows its source.
          const block = !plainNow && l.toLowerCase() === 'wherdr' ? parseWherdrBlock(text) : null
          if (block) return wherdrHtml(block)
          if (docNow) {
            return `<div class="code-block"><div class="code-head"><span>${l || 'code'}</span>`
              + `<span class="code-tools"><button type="button" class="code-copy">${escHtml(t('Copy'))}</button></span></div>`
              + `<pre><code${l ? ` class="language-${l}"` : ''}>${highlightCode(text, l)}</code></pre></div>`
          }
          const cmd = plainNow ? null : blockCommand(text, lang)
          const run = cmd === null ? '' : `<button type="button" class="code-run">${escHtml(tl('Run', 'Lancer'))}</button>`
          return `<div class="code-block"${cmd === null ? '' : ` data-cmd="${escHtml(cmd)}"`}><div class="code-head"><span>${l || 'code'}</span>`
            + `<span class="code-tools">${run}<button type="button" class="code-copy">${escHtml(t('Copy'))}</button></span></div>`
            + `<pre><code${l ? ` class="language-${l}"` : ''}>${escHtml(text)}</code></pre></div>`
        },
        link(token) {
          if (plainNow || !isAppLink(token.href)) return false
          // A link whose text is its own address names the place instead.
          const named = token.text.trim() !== token.href && token.text.trim() !== `\`${token.href}\``
          return appButton(token.href, named ? this.parser.parseInline(token.tokens) : escHtml(`${t('Open')} ${uiPlaceLabel(token.href)}`))
        },
        html({ text }) {
          return plainNow && !docNow ? escHtml(text) : text
        },
        // Inline code that is exactly an in-app address (`#/board?task=X`),
        // or a Markdown link to one: an action button that opens it in the app.
        // Inline code that looks like a file path: a menu in the conversation
        // (Reveal in Finder, Open, Copy path; see ChatView.vue); like a
        // command: Copy and Run. Every span carries its kind
        // (utils/codeKind.ts) for the terminal-style tints.
        codespan({ text }) {
          const code = escHtml(text)
          if (plainNow) {
            const kind = codeKind(text)
            return `<code${kind ? ` data-k="${kind}"` : ''}>${code}</code>`
          }
          if (isAppLink(text)) return appButton(text, escHtml(`${t('Open')} ${uiPlaceLabel(text)}`))
          if (pathCandidate(text)) return `<code class="md-path" data-k="path" role="button" tabindex="0">${code}</code>`
          const cmd = inlineCommand(text)
          if (cmd !== null) return `<code class="md-cmd" data-k="cmd" data-cmd="${escHtml(cmd)}" role="button" tabindex="0">${code}</code>`
          const kind = codeKind(text)
          return `<code${kind ? ` data-k="${kind}"` : ''}>${code}</code>`
        },
      },
    })
    DOMPurify.addHook('uponSanitizeElement', (n, data) => {
      if (data.tagName === 'svg') {
        n.parentNode?.removeChild(n)
        return
      }
      if (!plainNow || data.tagName !== 'input') return
      const el = n as Element
      if (!(el.getAttribute('type') === 'checkbox' && el.hasAttribute('disabled'))) el.parentNode?.removeChild(el)
    })
    DOMPurify.addHook('afterSanitizeAttributes', (n) => {
      if (docNow && n.tagName === 'IMG') {
        const src = n.getAttribute('src')
        if (src && isRelativeUrl(src)) {
          n.setAttribute('data-src', src)
          n.removeAttribute('src')
        }
      }
      // An in-app address opens in the same tab, through the router
      // (ChatMarkdown.vue); any other link in a new tab.
      if (n.tagName === 'A' && !isAppLink(n.getAttribute('href') ?? '')) {
        n.setAttribute('target', '_blank')
        n.setAttribute('rel', 'noopener noreferrer')
      }
    })
  }
  let html: string
  plainNow = Boolean(options.plain || options.doc)
  docNow = Boolean(options.doc)
  try {
    const parsed = marked.parse(text, { breaks: !docNow, gfm: true, async: false }) as string
    // Raw inline SVG is not a preview request and must not enter the parent
    // DOM. The explicit fenced subset above renders only as an inert image.
    const config = { ...(plainNow ? PLAIN : {}), FORBID_TAGS: [...(plainNow ? PLAIN.FORBID_TAGS : []), 'svg'] }
    html = DOMPurify.sanitize(parsed, config)
  } catch { html = `<p>${escHtml(text)}</p>` }
  finally { plainNow = false; docNow = false }
  for (const old of superseded(key)) {
    const gone = cache.delete(old)
    if (gone !== undefined && gone !== html) for (const fn of dropListeners) fn(gone)
  }
  cache.set(key, html, key.length + html.length)
  return html
}
