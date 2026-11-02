import { describe, expect, it } from 'vitest'
import { readUiScale } from '../app/utils/uiScale'

describe('uiScale', () => {
  it('parses the stored value, Standard for missing or unknown ones', () => {
    expect(readUiScale('lg')).toBe('lg')
    for (const v of [null, '', 'md', 'xl', '1', 'large']) expect(readUiScale(v)).toBe('md')
  })
})
