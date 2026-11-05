import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTE_MODE, QUOTE_MODES, migrateQuoteMode } from '../app/utils/quoteTokens'

// A Storage stand-in over a plain record.
function store(init: Record<string, string>) {
  const data = { ...init }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    removeItem: (k: string) => { delete data[k] },
  }
}

describe('quote mode saved on this device', () => {
  it('defaults to tokens in the native field', () => {
    expect(DEFAULT_QUOTE_MODE).toBe('native')
  })
  it('offers two modes; the former rich field is the native one', () => {
    expect([...QUOTE_MODES]).toEqual(['lines', 'native'])
    const s = store({ quoteMode: 'rich', theme: 'dark' })
    expect(migrateQuoteMode(s)).toBe('native')
    expect(s.data).toEqual({ quoteMode: 'native', theme: 'dark' })
  })
  it('an empty storage takes the default and records the pass', () => {
    const s = store({})
    expect(migrateQuoteMode(s)).toBe('native')
    expect(s.data).toEqual({ quoteMode: 'native' })
  })
  it('the pass overwrites the former per-device values once and removes their keys', () => {
    const s = store({ quoteModeComputer: 'lines', quoteModePhone: 'rich', quoteTokensComputer: '1', quoteTokensPhone: '0', theme: 'dark' })
    expect(migrateQuoteMode(s)).toBe('native')
    expect(s.data).toEqual({ quoteMode: 'native', theme: 'dark' })
  })
  it('a choice made after the pass is kept on the next launches', () => {
    const s = store({ quoteModeComputer: 'rich' })
    migrateQuoteMode(s)
    s.setItem('quoteMode', 'lines')
    expect(migrateQuoteMode(s)).toBe('lines')
    expect(migrateQuoteMode(s)).toBe('lines')
    expect(s.data).toEqual({ quoteMode: 'lines' })
  })
})
