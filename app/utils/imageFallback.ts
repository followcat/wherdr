// An image of an agent reply that does not show (refused by the Content
// Security Policy, see server/utils/csp.ts, or failed to load) is replaced by
// a note saying why, with a link that opens it in a new tab. The broken image
// stays in place, hidden, so the rendered HTML keeps its shape.

type Why = 'blocked' | 'failed'

// Addresses the browser refused under img-src. The violation and the image's
// error event come in either order: a note is written as 'failed', then
// turned into 'blocked' when the violation arrives.
const blocked = new Set<string>()
let listening = false

const originOf = (src: string) => {
  try { return new URL(src, location.href).origin } catch { return '' }
}
// blockedURI is the full address, or only its origin after a redirect.
const isBlocked = (src: string) => blocked.has(src) || blocked.has(originOf(src))

function reason(why: Why): string {
  return why === 'blocked'
    ? t('wherdr only shows images from its own address and from HTTPS addresses on your tailnet.')
    : t('The image could not be loaded.')
}

export function watchImageViolations() {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('securitypolicyviolation', (e) => {
    if (!/^img-src\b/.test(e.effectiveDirective || e.violatedDirective || '') || !e.blockedURI) return
    blocked.add(e.blockedURI)
    for (const note of document.querySelectorAll<HTMLElement>('.md-img-fallback[data-why="failed"]')) {
      const src = note.dataset.src || ''
      if (src === e.blockedURI || originOf(src) === e.blockedURI) setWhy(note, 'blocked')
    }
  })
}

function setWhy(note: HTMLElement, why: Why) {
  note.dataset.why = why
  const text = note.querySelector('.md-img-fallback-why')
  if (text) text.textContent = reason(why)
}

// Only web addresses get a link (never data:, blob: or javascript:).
function webUrl(src: string): URL | null {
  try {
    const url = new URL(src, location.href)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch { return null }
}

export function showImageFallback(img: HTMLImageElement) {
  if (img.classList.contains('md-img-broken')) return
  const src = img.currentSrc || img.src
  img.classList.add('md-img-broken')
  const note = document.createElement('span')
  note.className = 'md-img-fallback'
  note.setAttribute('role', 'note')
  note.dataset.src = src
  const tag = document.createElement('span')
  tag.className = 'md-img-fallback-tag'
  tag.textContent = t('Image not shown')
  note.append(tag)
  const alt = img.getAttribute('alt')?.trim()
  if (alt) {
    const name = document.createElement('span')
    name.className = 'md-img-fallback-alt'
    name.textContent = alt
    note.append(name)
  }
  const why = document.createElement('span')
  why.className = 'md-img-fallback-why'
  note.append(why)
  const url = webUrl(src)
  if (url) {
    const link = document.createElement('a')
    link.href = url.href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = t('Open image')
    const where = document.createElement('span')
    where.className = 'md-img-fallback-url'
    where.textContent = url.href.replace(/^https?:\/\//, '')
    note.append(link, where)
  }
  setWhy(note, isBlocked(src) ? 'blocked' : 'failed')
  img.after(note)
}
