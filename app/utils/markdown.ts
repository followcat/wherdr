// Markdown of replies: marked for rendering, DOMPurify so that nothing
// an agent might have written gets executed. Cached by text (the
// conversation is re-read every 1.5 s), within a budget (see MD_CACHE_CHARS).
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { pathCandidate } from '../../shared/filePaths'
import { codeKind } from './codeKind'
import { highlightCode } from './codeHighlight'
import { createRenderCache, createSupersedeTracker } from './renderCache'
import { blockCommand, inlineCommand } from './shellCommand'
import { svgPreview } from './svgPreview'

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
// task list's own checkbox (`- [ ]`, disabled) is kept.
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
          if (docNow) {
            return `<div class="code-block"><div class="code-head"><span>${l || 'code'}</span>`
              + `<span class="code-tools"><button type="button" class="code-copy">${escHtml(t('Copy'))}</button></span></div>`
              + `<pre><code${l ? ` class="language-${l}"` : ''}>${highlightCode(text, l)}</code></pre></div>`
          }
          const cmd = blockCommand(text, lang)
          const run = cmd === null ? '' : `<button type="button" class="code-run">${escHtml(tl('Run', 'Lancer'))}</button>`
          return `<div class="code-block"${cmd === null ? '' : ` data-cmd="${escHtml(cmd)}"`}><div class="code-head"><span>${l || 'code'}</span>`
            + `<span class="code-tools">${run}<button type="button" class="code-copy">${escHtml(t('Copy'))}</button></span></div>`
            + `<pre><code${l ? ` class="language-${l}"` : ''}>${escHtml(text)}</code></pre></div>`
        },
        // Inline code that looks like a file path: a menu in the conversation
        // (Reveal in Finder, Open, Copy path; see ChatView.vue); like a
        // command: Copy and Run. Every span carries its kind
        // (utils/codeKind.ts) for the terminal-style tints.
        codespan({ text }) {
          const code = escHtml(text)
          if (docNow) {
            const kind = codeKind(text)
            return `<code${kind ? ` data-k="${kind}"` : ''}>${code}</code>`
          }
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
      if (n.tagName === 'A') {
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
