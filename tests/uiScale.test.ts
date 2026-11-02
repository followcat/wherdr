import { describe, expect, it } from 'vitest'
import { readUiScale } from '../app/utils/uiScale'

describe('uiScale', () => {
  it('keeps an explicit Standard; missing or unknown defaults to Large', () => {
    expect(readUiScale('md')).toBe('md')
    for (const v of [null, '', 'lg', 'xl', '1', 'large']) expect(readUiScale(v)).toBe('lg')
  })
})
