// New version after a deployment: detection.
import { describe, expect, it } from 'vitest'
import { installedSwAction, isChunkLoadError, isNewBuild } from '../app/utils/appVersion'

describe('isNewBuild', () => {
  it('detects another build', () => {
    expect(isNewBuild('aaa', { id: 'bbb', timestamp: 1 })).toBe(true)
  })
  it('ignores the same build and unreadable responses', () => {
    expect(isNewBuild('aaa', { id: 'aaa' })).toBe(false)
    expect(isNewBuild('aaa', null)).toBe(false)
    expect(isNewBuild('aaa', '<html>')).toBe(false)
    expect(isNewBuild('aaa', { id: '' })).toBe(false)
    expect(isNewBuild(undefined, { id: 'bbb' })).toBe(false)
  })
})

describe('isChunkLoadError', () => {
  it('recognizes the browsers\' messages', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /_nuxt/x.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
  })
  it('ignore les autres erreurs', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('installedSwAction', () => {
  it('announces nothing on a first installation', () => {
    expect(installedSwAction(false, true)).toBe('none')
    expect(installedSwAction(false, false)).toBe('none')
  })
  it('activates silently a SW found at startup (reinstall over an old SW)', () => {
    expect(installedSwAction(true, true)).toBe('activate')
  })
  it('shows the banner for an update arriving during use', () => {
    expect(installedSwAction(true, false)).toBe('banner')
  })
})
