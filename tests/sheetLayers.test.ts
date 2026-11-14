import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

// Windows (AppSheet) on a computer: floating content opens above them, and the
// phone bottom sheet's color-filling shadow stays off the centered window.
const css = fs.readFileSync('app/assets/css/main.css', 'utf8')
const z = (selector: string) => {
  const m = new RegExp(`^${selector.replace(/[.[\]]/g, '\\$&')} \\{[^}]*z-index: (\\d+)`, 'm').exec(css)
  if (!m) throw new Error(`no z-index for ${selector}`)
  return Number(m[1])
}
// Top-level `.hw-sheet { ... }` rules outside the phone media queries.
const sheetRules = (text: string) => [...text.matchAll(/^ {0,2}\.hw-sheet \{[^}]*\}/gm)].map(m => m[0])

describe('sheet layers', () => {
  it('select, menu, popover and tooltip content sits above every sheet and under the lightbox', () => {
    const popper = z('[data-reka-popper-content-wrapper]')
    expect(popper).toBeGreaterThan(z('.hw-sheet.top'))
    expect(popper).toBeGreaterThan(z('.hw-sheet'))
    expect(popper).toBeLessThan(z('.lightbox'))
  })
  it('the 160 px filling shadow belongs to the phone bottom sheet only', () => {
    const rules = sheetRules(css)
    expect(rules.length).toBe(2) // base and computer
    for (const rule of rules) expect(rule).not.toContain('160px')
    expect(css).toMatch(/\.hw-sheet:not\(\.screen\) \{[^}]*0 160px 0 var\(--bg\)/)
  })
})
