import { describe, expect, it } from 'vitest'
import { importThemeText, readCustomThemes, readThemeFile, themeFile, writeCustomThemes } from '../app/utils/customThemes'
import { THEMES } from '../app/utils/themes'

const gruvbox = THEMES.find(t => t.id === 'gruvbox')!
const file = () => JSON.parse(JSON.stringify(themeFile({ ...gruvbox, label: 'Mine', author: 'Someone' })))

describe('custom theme files', () => {
  it('round-trips a theme through export and import', () => {
    const th = importThemeText(JSON.stringify(file()))
    expect(th).toMatchObject({ label: 'Mine', author: 'Someone', group: 'custom', c: gruvbox.c, light: gruvbox.light, ansi: gruvbox.ansi })
    expect((th as { id: string }).id).toMatch(/^custom-/)
  })
  it('refuses invalid files with a clear message', () => {
    const bad = (edit: (f: ReturnType<typeof file>) => void) => { const f = file(); edit(f); return readThemeFile(f, 'custom-x') }
    expect(importThemeText('{nope')).toBe('Not valid JSON')
    expect(importThemeText(' '.repeat(9000))).toBe('The file is larger than 8 KB')
    expect(readThemeFile({ name: 'x' }, 'custom-x')).toBe('Not a wherdr theme file')
    expect(bad(f => { f.version = 2 })).toBe('Unsupported theme file version')
    expect(bad(f => { f.name = '' })).toBe('The name must be 1 to 40 characters')
    expect(bad(f => { f.dark.bg = 'red' })).toBe('"dark.bg" is not a #rrggbb color')
    expect(bad(f => { f.light.glow = '#ffffff' })).toBe('Unknown color "light.glow"')
    expect(bad(f => { delete f.light.text })).toBe('"light.text" is missing')
    expect(bad(f => { f.dark.ansi = f.dark.ansi.slice(1) })).toBe('"dark.ansi" must be 16 #rrggbb colors')
  })
  it('keeps the valid themes of the synced setting', () => {
    const th = readThemeFile(file(), 'custom-a') as typeof gruvbox
    const raw = JSON.parse(writeCustomThemes([th])!)
    expect(readCustomThemes(JSON.stringify([...raw, { id: 'custom-b', name: 'broken' }, { ...raw[0], id: 'gruvbox' }]))).toEqual([th])
    expect(readCustomThemes('oops')).toEqual([])
    expect(writeCustomThemes([])).toBeNull()
  })
})
