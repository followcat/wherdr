import { describe, expect, it } from 'vitest'
import { ansiToLines } from '../app/utils/ansiToHtml'

const textOf = (line: { text: string }[]) => line.map(s => s.text).join('')

describe('ansiToLines', () => {
  it('keeps plain text untouched, one entry per line', () => {
    const lines = ansiToLines('one\ntwo\nthree')
    expect(lines.map(textOf)).toEqual(['one', 'two', 'three'])
    expect(lines[0]).toEqual([{ text: 'one' }])
  })

  it('splits spans at SGR boundaries and applies 8-color styling', () => {
    const [line] = ansiToLines('a\x1b[31mRED\x1b[0mb')
    expect(line!.map(s => s.text).join('')).toBe('aREDb')
    expect(line![1]).toMatchObject({ text: 'RED', color: '#800000' })
    expect(line![2]).toMatchObject({ text: 'b' })
    expect(line![2]!.color).toBeUndefined()
  })

  it('carries SGR state across lines until reset', () => {
    const lines = ansiToLines('\x1b[32mgreen1\ngreen2\x1b[0m\nplain')
    expect(lines[0]![0]).toMatchObject({ color: '#008000' })
    expect(lines[1]![0]).toMatchObject({ color: '#008000' })
    expect(lines[2]![0]!.color).toBeUndefined()
  })

  it('supports 256 and truecolor foreground/background', () => {
    const [a] = ansiToLines('\x1b[38;5;196mX')
    expect(a![0]).toMatchObject({ color: '#ff0000' })
    const [b] = ansiToLines('\x1b[48;2;1;2;3mX')
    expect(b![0]).toMatchObject({ background: 'rgb(1,2,3)' })
  })

  it('maps attributes: bold, dim, italic, underline, strike, inverse', () => {
    const [line] = ansiToLines('\x1b[1;4;7mX')
    expect(line![0]).toMatchObject({ bold: true, underline: true })
    const [inv] = ansiToLines('\x1b[7;31;42mX')
    // inverse swaps the effective fg/bg in the emitted span
    expect(inv![0]).toMatchObject({ color: '#008000', background: '#800000' })
    const [strike] = ansiToLines('\x1b[9mX')
    expect(strike![0]).toMatchObject({ strike: true })
  })

  it('drops carriage returns and produces no empty final artifacts', () => {
    const lines = ansiToLines('a\r\nb\r')
    expect(lines.map(textOf)).toEqual(['a', 'b'])
  })
})
