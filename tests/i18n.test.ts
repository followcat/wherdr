import { describe, expect, it } from 'vitest'
import { FR_DICTIONARY, language, setLanguage, t, tl } from '../app/utils/i18n'

describe('i18n', () => {
  it('keeps English active after a legacy French preference', () => {
    setLanguage('fr')
    expect(language).toBe('en')
    expect(t('Rename pane')).toBe('Rename pane')
    expect(t('Text with no entry')).toBe('Text with no entry')
    expect(tl('English', 'Français')).toBe('English')
    expect(tl('English only')).toBe('English only')
  })

  it('retains the inactive French dictionary with English keys', () => {
    expect(FR_DICTIONARY['Rename pane']).toBe('Renommer le pane')
    expect(Object.keys(FR_DICTIONARY).filter(k => /[àâçéèêëîïôûùœ]/i.test(k))).toEqual([])
  })
})
