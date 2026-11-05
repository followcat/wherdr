import { describe, expect, it } from 'vitest'
import { speakableText, speechChunks } from '../app/utils/speech/plainText'

describe('speakableText', () => {
  it('says "Code block." in place of fenced code, closed or not', () => {
    expect(speakableText('Run this:\n\n```sh\nnpm ci\nnpm test\n```\n\nThen push.')).toBe('Run this:\n\nCode block.\n\nThen push.')
    expect(speakableText('Start:\n~~~\nopen fence', 'Bloc de code.')).toBe('Start:\n\nBloc de code.')
  })

  it('keeps the words of links, images and inline code', () => {
    expect(speakableText('See [the docs](https://x.dev/a) and ![a chart](c.png), run `npm ci`.')).toBe('See the docs and a chart, run npm ci.')
    expect(speakableText('Open https://example.com/a?b=1 now')).toBe('Open link now')
  })

  it('drops headings, emphasis, list, quote and task marks', () => {
    expect(speakableText('## Summary\n\n- **Fixed** the _flaky_ test\n2. ~~old~~ new\n- [x] done\n> quoted')).toBe('Summary\n\nFixed the flaky test\nold new\ndone\nquoted')
  })

  it('leaves snake_case and lone stars alone', () => {
    expect(speakableText('Set read_aloud_voice to 2 * 3')).toBe('Set read_aloud_voice to 2 * 3')
  })

  it('reads a table row by row, without rules or pipes', () => {
    expect(speakableText('| File | State |\n| --- | :-: |\n| a.ts | ok |')).toBe('File, State\na.ts, ok')
  })

  it('strips HTML tags and horizontal rules', () => {
    expect(speakableText('<details><summary>More</summary>Hidden</details>\n\n---\n\nEnd')).toBe('More Hidden\n\nEnd')
  })
})

describe('speechChunks', () => {
  it('keeps short paragraphs whole', () => {
    expect(speechChunks('One.\n\nTwo.')).toEqual(['One.', 'Two.'])
  })

  it('cuts long text at a sentence end, within the limit', () => {
    const s = `${'a'.repeat(50)}. ${'b'.repeat(50)}. ${'c'.repeat(50)}.`
    const out = speechChunks(s, 120)
    expect(out).toEqual([`${'a'.repeat(50)}. ${'b'.repeat(50)}.`, `${'c'.repeat(50)}.`])
  })

  it('falls back to a space, then a hard cut', () => {
    expect(speechChunks('word '.repeat(30).trim(), 40).every(c => c.length <= 40)).toBe(true)
    expect(speechChunks('x'.repeat(90), 40)).toEqual(['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(10)])
  })
})
