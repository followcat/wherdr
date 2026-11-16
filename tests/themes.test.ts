import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME, THEMES, contrastIssues, modeIsLight, storedThemeChoice, storedThemeMode, legacyLightTheme,
  themeSections, themeVariant, themesCss, xtermTheme,
} from '../app/utils/themes'

describe('theme list', () => {
  it('keeps wherdr, agent and three classic themes, Titanium first', () => {
    expect(themeSections().map(s => [s.group, s.themes.map(t => t.id)])).toEqual([
      ['wherdr', ['wherdr-titanium', 'wherdr-neon', 'wherdr-graphite']],
      ['agents', ['claude-code', 'codex', 'omp']],
      ['classic', ['vesper', 'gruvbox', 'kanagawa']],
    ])
  })
  it('paints a light rule for every theme and a dark one except main.css\'s Titanium', () => {
    const css = themesCss()
    for (const t of THEMES) expect(css).toContain(`:root[data-theme="${t.id}"][data-mode="light"]{`)
    expect(css).toContain(':root[data-theme="vesper"]{')
    expect(css).not.toContain(`:root[data-theme="${DEFAULT_THEME}"]{`)
  })
  it('gives the terminal the light palette in light mode', () => {
    const omp = THEMES.find(t => t.id === 'omp')!
    expect(xtermTheme(themeVariant(omp, true))).toMatchObject({ background: omp.light.bg, foreground: omp.light.text, red: omp.light.rose })
    expect(xtermTheme(themeVariant(omp, false)).background).toBe(omp.c.bg)
  })
})

describe('saved choices', () => {
  it('keeps a kept theme, sends removed ones to Titanium and 2.x light themes to their family', () => {
    expect(storedThemeChoice('gruvbox')).toBe('gruvbox')
    for (const gone of ['dracula', 'wherdr-neon-purple', 'herdr', 'follow', null]) expect(storedThemeChoice(gone)).toBe(DEFAULT_THEME)
    expect(storedThemeChoice('omp-light')).toBe('omp')
    expect(storedThemeChoice('catppuccin-latte')).toBe(DEFAULT_THEME)
    expect(legacyLightTheme('omp-light')).toBe('omp')
    expect(legacyLightTheme('gruvbox')).toBeUndefined()
  })
  it('reads the mode, Dark by default, System following the device', () => {
    expect(storedThemeMode(null)).toBe('dark')
    expect(storedThemeMode('sepia')).toBe('dark')
    expect(storedThemeMode('system')).toBe('system')
    expect([modeIsLight('dark', true), modeIsLight('light', false), modeIsLight('system', true), modeIsLight('system', false)])
      .toEqual([false, true, true, false])
  })
})

describe('contrast', () => {
  for (const th of THEMES) for (const light of [false, true]) {
    it(`${th.label} ${light ? 'light' : 'dark'}`, () => expect(contrastIssues(themeVariant(th, light).c)).toEqual([]))
  }
})
