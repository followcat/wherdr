// Quoted replies in the message field: the field stays the native textarea,
// its text plain (a "↳ … —" line per reference, its answer below, see
// shared/reference.ts), so sending, Enter,
// "/", image paste, dictation and autocorrect do not change; only its drawing
// does. A mirror behind the textarea draws the same text with the same
// metrics (font, size, padding, wrapping, scroll), each reference line as a
// token; the textarea's own text is transparent, its caret and selection stay
// visible. Nothing in the mirror may change a line's width or height: the
// same characters in the same font, no vertical margin or padding, only
// colours and a band widened into the padding by margin = -padding.

import { refParts } from '../../shared/reference'

// A line as drawn: a reference keeps what introduces its excerpt (`head`,
// "↳ Quote point 11:37 : ") and its closing dash (`tail`) apart.
export interface MirrorLine { ref: boolean, head: string, text: string, tail: string }

export function mirrorLines(value: string): MirrorLine[] {
  return value.split('\n').map((line) => {
    const p = line.startsWith('↳') ? refParts(line) : null
    return p ? { ref: true, head: p.head, text: p.ref.excerpt, tail: p.tail } : { ref: false, head: '', text: line, tail: '' }
  })
}

// Styles that decide where text wraps and how it is drawn.
const COPIED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontKerning', 'fontFeatureSettings',
  'fontVariationSettings', 'fontVariantLigatures', 'fontOpticalSizing', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform',
  'textIndent', 'textRendering', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'hyphens', 'direction',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxSizing',
] as const

// Draws `ta`'s reference lines as tokens until destroyed. Call render() when the
// value is set from script (no input event).
export function attachQuoteMirror(ta: HTMLTextAreaElement) {
  const host = ta.parentElement!
  const box = document.createElement('div')
  box.className = 'qm-mirror'
  box.setAttribute('aria-hidden', 'true')
  const inner = document.createElement('div')
  box.append(inner)
  host.insertBefore(box, ta)
  host.classList.add('qm-host')
  ta.classList.add('qm-on')
  let alive = true

  function scroll() {
    inner.style.transform = `translateY(${-ta.scrollTop}px)`
  }
  function layout() {
    if (!alive) return
    const cs = getComputedStyle(ta)
    for (const k of COPIED) box.style[k] = cs[k]
    box.style.borderStyle = 'solid'
    box.style.borderColor = 'transparent'
    // A classic scrollbar narrows the textarea's text: same width for the mirror.
    const bars = ta.offsetWidth - ta.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)
    box.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, bars)}px`
    box.style.top = `${ta.offsetTop}px`
    box.style.left = `${ta.offsetLeft}px`
    box.style.width = `${ta.offsetWidth}px`
    box.style.height = `${ta.offsetHeight}px`
    box.style.setProperty('--qm-pl', cs.paddingLeft)
    box.style.setProperty('--qm-pr', box.style.paddingRight)
    scroll()
  }
  function render() {
    inner.textContent = ''
    for (const l of mirrorLines(ta.value)) {
      const row = document.createElement('div')
      if (l.ref) {
        row.className = 'qm-q'
        const mark = document.createElement('span')
        mark.className = 'qm-a'
        mark.textContent = l.head.slice(0, 1)
        const head = document.createElement('span')
        head.className = 'qm-h'
        head.textContent = l.head.slice(1)
        const tail = document.createElement('span')
        tail.className = 'qm-h'
        tail.textContent = l.tail
        row.append(mark, head, l.text, tail)
      } else row.append(l.text || '\u200B') // an empty line still takes one line (zero-width space)
      inner.append(row)
    }
    layout()
  }
  ta.addEventListener('input', render)
  ta.addEventListener('scroll', scroll, { passive: true })
  const ro = new ResizeObserver(layout)
  ro.observe(ta)
  // Web fonts arriving later change the metrics.
  void document.fonts?.ready.then(layout)
  render()

  return {
    render,
    destroy() {
      alive = false
      ro.disconnect()
      ta.removeEventListener('input', render)
      ta.removeEventListener('scroll', scroll)
      ta.classList.remove('qm-on')
      host.classList.remove('qm-host')
      box.remove()
    },
  }
}
