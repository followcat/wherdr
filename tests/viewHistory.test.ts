import { describe, expect, it } from 'vitest'
import { internalBack, isDetailRoute } from '../app/utils/viewHistory'

describe('detail history policy', () => {
  it('recognizes every detail entry point, leaving list and settings routes alone', () => {
    for (const [path, query] of [['/a/pane', {}], ['/t/tab', {}], ['/board', { task: 'demo/9' }], ['/board', { coordinator: 'demo' }], ['/board', { conversation: 'main' }]] as const) {
      expect(isDetailRoute(path, query)).toBe(true)
    }
    for (const [path, query] of [['/', {}], ['/board', {}], ['/board', { machine: '' }], ['/board', { settings: 'all' }], ['/setup', {}]] as const) {
      expect(isDetailRoute(path, query)).toBe(false)
    }
  })
  it('uses only an internal predecessor, otherwise Home is the fallback', () => {
    for (const back of ['/', '/board', '/board?task=demo%2F9', '/a/pane']) expect(internalBack(back)).toBe(true)
    for (const back of [null, undefined, '', '//example.test', 'https://example.test', 1]) expect(internalBack(back)).toBe(false)
  })
})
