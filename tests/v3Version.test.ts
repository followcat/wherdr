import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { v3Version } from '../shared/v3Version'

describe('v3Version', () => {
  it('is the package version plus the short commit read at build time', () => {
    expect(pkg.version).toMatch(/^3\./)
    expect(v3Version('FC3550ED0123456789abcdef0123456789abcdef\n')).toBe(`${pkg.version}+fc3550e`)
    expect(v3Version('fc3550e')).toBe(`${pkg.version}+fc3550e`)
  })

  it('is the package version alone without a commit', () => {
    for (const commit of [undefined, null, '', 'not a sha', 'abc']) expect(v3Version(commit)).toBe(pkg.version)
  })
})
