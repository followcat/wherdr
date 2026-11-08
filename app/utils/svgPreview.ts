// Only explicitly tagged `svg` fences are previews. Raw SVG is not promoted,
// and SVG nested in another language's fence remains ordinary copyable code.
// Static SVG is serialized into an image, never inserted in the app DOM. Reject
// unsupported/active content instead of showing a deceptively incomplete image.
import { DEFAULT_THEME, themeById } from './themes'

export const SVG_THEME_VARS = {
  fg: 'text', muted: 'muted', border: 'line', surface: 'surface', accent: 'accent',
  success: 'done', warning: 'blocked', error: 'danger',
  c1: 'blue', c2: 'teal', c3: 'green', c4: 'ochre', c5: 'lav', c6: 'rose',
} as const
export type SvgColors = Partial<Record<keyof typeof SVG_THEME_VARS, string>>
const base = themeById(DEFAULT_THEME)!.c
const defaults: Required<SvgColors> = {
  fg: base.text, muted: base.muted, border: base.line, surface: base.surface, accent: base.accent,
  success: base.done || base.green, warning: base.blocked || base.ochre, error: base.rose,
  c1: base.blue, c2: base.teal, c3: base.green, c4: base.ochre, c5: base.lav || base.accent, c6: base.rose,
}
const NS = 'http://www.w3.org/2000/svg'
const tags: Record<string, true> = { svg: true, g: true, defs: true, symbol: true, title: true, desc: true, path: true, rect: true, circle: true, ellipse: true, line: true, polyline: true, polygon: true, text: true, tspan: true, textPath: true, use: true, marker: true, linearGradient: true, radialGradient: true, stop: true, clipPath: true, mask: true, pattern: true }
const attributes: Record<string, true> = Object.fromEntries('id class x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform dx dy rotate textLength lengthAdjust offset gradientUnits gradientTransform spreadMethod fx fy fr markerWidth markerHeight markerUnits refX refY orient patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits'.split(' ').map(name => [name, true as const]))
const properties: Record<string, true> = Object.fromEntries('fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing text-decoration paint-order vector-effect marker-start marker-mid marker-end clip-path clip-rule mask stop-color stop-opacity display visibility'.split(' ').map(name => [name, true as const]))
const reference = /^#([a-zA-Z_][\w.:-]*)$/
const color = /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\)|[a-z]+)$/i

export function svgPreview(source: string, colors: SvgColors = {}): string | null {
  // XML declarations/DTDs/entities, processing instructions and incomplete
  // streamed roots are not part of the supported static subset.
  const text = source.trim()
  if (text.length > 150_000 || !/^<svg(?:\s|>)/.test(text) || !/<\/svg>\s*$/.test(text) || /<!DOCTYPE|<!ENTITY|<\?/i.test(text)) return null
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const root = doc.documentElement
    if (doc.querySelector('parsererror') || root.localName !== 'svg') return null
    const nodes = [root, ...root.querySelectorAll('*')]
    if (nodes.length > 2000) return null
    const palette = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
      const value = colors[key as keyof SvgColors]?.trim() || fallback
      return [key, color.test(value) && !/^(?:inherit|initial|unset|revert|currentcolor)$/i.test(value) ? value : fallback]
    }))
    const ids = new Map<string, Element>()
    const refs = new Map<Element, string[]>()
    let visual = false
    const valueOf = (value: string, el: Element): string | null => {
      const resolved = value.replace(/var\(\s*--([a-z][\w-]*)\s*(?:,\s*[^()]*)?\)/gi, (_, key: string) => palette[key] || '')
      // No CSS escapes, comments, at-rules, unknown functions or resource URLs.
      // The sole resource form is an ID in this standalone image.
      const local = /^url\(\s*['"]?(#[a-zA-Z_][\w.:-]*)['"]?\s*\)$/i.exec(resolved.trim())
      if (local) {
        refs.set(el, [...(refs.get(el) || []), local[1]!.slice(1)])
        return `url(${local[1]})`
      }
      if (!resolved.trim() || /[\\@{};<>]|\/\*|url|var\s*\(|(?:https?|data|javascript):/i.test(resolved)) return null
      if (/[()]/.test(resolved) && !/^(?:rgb|rgba|hsl|hsla|translate|scale|rotate|skewX|skewY|matrix)\([\d\s.,%+eE/-]+\)(?:\s+(?:translate|scale|rotate|skewX|skewY|matrix)\([\d\s.,%+eE/-]+\))*$/i.test(resolved)) return null
      return resolved
    }
    const declarations = (css: string, el: Element): string | null => {
      const result: string[] = []
      for (const declaration of css.split(';')) {
        if (!declaration.trim()) continue
        const colon = declaration.indexOf(':')
        if (colon < 0) return null
        const name = declaration.slice(0, colon).trim().toLowerCase()
        if (!Object.hasOwn(properties, name)) return null
        const value = valueOf(declaration.slice(colon + 1).trim(), el)
        if (value === null) return null
        result.push(`${name}:${value}`)
      }
      return result.join(';')
    }
    for (const el of nodes) {
      if (!Object.hasOwn(tags, el.localName) || (el.namespaceURI && el.namespaceURI !== NS) || el.prefix) return null
      const id = el.getAttribute('id')
      if (id) {
        if (!reference.test(`#${id}`) || ids.has(id)) return null
        ids.set(id, el)
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name
        if (name === 'xmlns' && el === root && attr.value === NS) continue
        if (name === 'xmlns:xlink' && attr.value === 'http://www.w3.org/1999/xlink') continue
        if (/^on/i.test(name) || name === 'src') return null
        if ((attr.localName === 'href' || name.endsWith(':href')) && name !== 'href' && name !== 'xlink:href') return null
        if (name === 'xlink:href' && attr.namespaceURI !== 'http://www.w3.org/1999/xlink') return null
        if (name === 'href' || name === 'xlink:href') {
          const ref = reference.exec(attr.value)
          if (!ref || !['use', 'textPath', 'linearGradient', 'radialGradient', 'pattern'].includes(el.localName)) return null
          refs.set(el, [...(refs.get(el) || []), ref[1]!])
          continue
        }
        if (name === 'style') {
          const safe = declarations(attr.value, el)
          if (safe === null) return null
          el.setAttribute(name, safe)
        } else if (Object.hasOwn(attributes, name) || Object.hasOwn(properties, name)) {
          const safe = valueOf(attr.value, el)
          if (safe === null) return null
          el.setAttribute(name, safe)
        } else el.removeAttribute(name)
      }
      if (!el.closest('defs, symbol, marker, clipPath, mask, pattern')) {
        if (el.localName === 'text' && el.textContent?.trim()) visual = true
        if (el.localName === 'use' && (el.hasAttribute('href') || el.hasAttribute('xlink:href'))) visual = true
        if (el.localName === 'path' && el.getAttribute('d')?.trim()) visual = true
        if (['line', 'polyline', 'polygon'].includes(el.localName) && el.attributes.length) visual = true
        if (el.localName === 'rect' && parseFloat(el.getAttribute('width') || '') > 0 && parseFloat(el.getAttribute('height') || '') > 0) visual = true
        if (el.localName === 'circle' && parseFloat(el.getAttribute('r') || '') > 0) visual = true
        if (el.localName === 'ellipse' && parseFloat(el.getAttribute('rx') || '') > 0 && parseFloat(el.getAttribute('ry') || '') > 0) visual = true
      }
    }
    if (!visual) return null
    // Bound expanded instances as well as source nodes: a small acyclic
    // <use>/paint DAG can otherwise multiply into an enormous render tree.
    const visiting = new Set<Element>()
    const expanded = new Map<Element, number>()
    const visit = (el: Element): boolean => {
      if (visiting.has(el)) return false
      if (expanded.has(el)) return true
      visiting.add(el)
      let size = 1
      for (const child of el.children) {
        if (!visit(child)) return false
        size += expanded.get(child)!
        if (size > 10_000) return false
      }
      for (const id of refs.get(el) || []) {
        const target = ids.get(id)
        if (!target || !visit(target)) return false
        size += expanded.get(target)!
        if (size > 10_000) return false
      }
      visiting.delete(el)
      expanded.set(el, size)
      return true
    }
    if (!visit(root)) return null
    const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
    if (viewBox && (viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n)) || viewBox[2]! <= 0 || viewBox[3]! <= 0)) return null
    for (const dimension of ['width', 'height']) {
      const value = root.getAttribute(dimension)
      if (value !== null && !(parseFloat(value) > 0)) return null
    }
    root.setAttribute('xmlns', NS)
    // SVG's implicit black fill is invisible on dark themes. Explicit colors
    // stay intact; only its default fill and currentColor follow wherdr.
    if (!root.hasAttribute('fill')) root.setAttribute('fill', 'currentColor')
    root.setAttribute('style', `color:${palette.fg};${root.getAttribute('style') || ''}`)
    return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
  } catch { return null }
}
