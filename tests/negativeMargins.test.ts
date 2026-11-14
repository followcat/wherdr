import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// A negative left/right margin pulls an element out of its parent's box and,
// unless the parent clips or has matching padding, makes the sheet or page
// scroll sideways (docs/design.md, Text and layout checks). Each one in app/
// must say why it is safe, on its line: /* overflow-safe: <why> */.
const ROOT = join(__dirname, '..', 'app')

const negative = (v: string) => /^-[\d.]/.test(v) || /^calc\(\s*-/.test(v)
// Splits a value on spaces outside parentheses: `0 calc(-1 * var(--x)) 0` → 3 parts.
const parts = (v: string) => {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of v.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && !depth) { if (cur) out.push(cur); cur = '' } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** The negative horizontal margins on a line of CSS, as `property: value`. */
function negativeHorizontalMargins(line: string): string[] {
  const found: string[] = []
  for (const m of line.matchAll(/(?<![\w-])(margin(?:-left|-right|-inline(?:-start|-end)?)?)\s*:\s*([^;}]+)/g)) {
    const [, prop, raw] = m as unknown as [string, string, string]
    const v = parts(raw.replace(/!important/, ''))
    const sides = prop === 'margin' ? (v.length === 4 ? [v[1], v[3]] : v.length > 1 ? [v[1]] : v) : v
    if (sides.some(s => s && negative(s))) found.push(`${prop}: ${raw.trim()}`)
  }
  // Tailwind utilities: -mx-2, -ml-4, -mr-px, -ms-1, -me-[3px].
  for (const m of line.matchAll(/(?<![\w-])-m[xlrse]-(?:\d|px\b|\[)[\w.[\]-]*/g)) found.push(m[0])
  return found
}

const flagged = (line: string) => !/\/\*\s*overflow-safe:\s*\S/.test(line) && negativeHorizontalMargins(line).length > 0

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|css)$/.test(e.name) ? [join(dir, e.name)] : [])

describe('negative horizontal margins', () => {
  it('finds them in shorthands, longhands and Tailwind classes', () => {
    expect(flagged('.a { margin: 0 -10px; }')).toBe(true)
    expect(flagged('.a { margin: -8px -6px -8px auto; }')).toBe(true)
    expect(flagged('.a { margin: 0 0 0 calc(-1 * var(--x)); }')).toBe(true)
    expect(flagged('.a { margin-right: -6px; }')).toBe(true)
    expect(flagged('.a { margin-inline: -4px; }')).toBe(true)
    expect(flagged('<div class="flex -mx-4">')).toBe(true)
    // Vertical only, positive, or explained: not flagged.
    expect(flagged('.a { margin: -12px 0 26px; }')).toBe(false)
    expect(flagged('.a { margin: -4px 8px 12px; }')).toBe(false)
    expect(flagged('.a { margin-top: -4px; scroll-margin-top: 12px; }')).toBe(false)
    expect(flagged('.a { margin: 0 -10px; } /* overflow-safe: the parent has 10px padding */')).toBe(false)
  })

  it('every one in app/ says why it cannot overflow', () => {
    const bad = files(ROOT).flatMap(f => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => (flagged(line) ? `${relative(ROOT, f)}:${i + 1}: ${negativeHorizontalMargins(line).join(', ')}` : ''))
      .filter(Boolean))
    expect(bad, 'add /* overflow-safe: <why> */ on the line, or use padding inside the element').toEqual([])
  })
})
