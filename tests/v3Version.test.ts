import { describe, expect, it } from 'vitest'
import { V3_BASE_VERSION, v3Version } from '../shared/v3Version'

describe('v3Version', () => {
  it('adds the short commit read at build time', () => {
    expect(v3Version('FC3550ED0123456789abcdef0123456789abcdef\n')).toBe('3.0.0-dev+fc3550e')
    expect(v3Version('fc3550e')).toBe('3.0.0-dev+fc3550e')
  })

  it('stays distinct from the v2 package version without a commit', () => {
    for (const commit of [undefined, null, '', 'not a sha', 'abc']) expect(v3Version(commit)).toBe(V3_BASE_VERSION)
    expect(V3_BASE_VERSION).toMatch(/^3\./)
  })
})
